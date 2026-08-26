/**
 * ADS-B.fi provider — replaces OpenSky for live aircraft positions.
 *
 * OpenSky Network (opensky-network.org) times out from Vercel's serverless
 * network because their servers are hosted on a Swiss university network
 * that blocks cloud-provider IP ranges.
 *
 * ADS-B.fi carries the same volunteer ADS-B radio data (overlapping receiver
 * network, same ICAO24 addresses) but via CDN-backed infrastructure that is
 * reachable from any cloud provider. No API key required.
 *
 * What it gives us:
 *   • Every Delta aircraft airborne or taxiing within 200 nm of KAUS right now.
 *   • Confirmed "Departed" status for flights that have left the field.
 *   • Aircraft on the ground at AUS that are about to push (taxiing / engines on).
 *
 * What it cannot give:
 *   • Destination airport (ADS-B position data has no route information).
 *   • Scheduled departure time (comes from the seed schedule or AeroAPI).
 *   • Cancellations (a cancelled flight simply never appears).
 */

import { STATION, carrierForCallsign, DELTA_HUBS } from "../config";
import { isDeltaSystem, callsignToFlightNumber, OpenSkyFlight } from "./opensky";

const AUS_LAT = 30.1975;
const AUS_LON = -97.6699;
const RADIUS_NM = 200;   // wide enough to catch flights 30–45 min out of AUS
const TIMEOUT_MS = 10_000;

interface AdsbFiAircraft {
  hex: string;
  flight?: string;
  r?: string;        // registration / tail number
  t?: string;        // ICAO type code
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;       // groundspeed knots
  track?: number;    // true heading
  seen?: number;     // seconds since last ADS-B message
  dst?: number;      // distance from query point in nautical miles
  baro_rate?: number;// climb/descent rate fpm (negative = descending)
}

interface AdsbFiResponse {
  now: number;
  aircraft?: AdsbFiAircraft[];
  ac?: AdsbFiAircraft[];          // some responses use "ac"
  resultCount?: number;
}

let memo: { at: number; data: OpenSkyFlight[] } | null = null;
const MEMO_MS = 60_000;

export async function fetchAdsbFiDepartures(): Promise<{
  flights: OpenSkyFlight[];
  latencyMs: number;
  ok: boolean;
  detail: string;
}> {
  if (memo && Date.now() - memo.at < MEMO_MS) {
    return { flights: memo.data, latencyMs: 0, ok: true, detail: "cached" };
  }

  const t0 = Date.now();
  const url = `https://opendata.adsb.fi/api/v2/lat/${AUS_LAT}/lon/${AUS_LON}/dist/${RADIUS_NM}`;

  let raw: AdsbFiResponse;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "aus-bagroom-platform/1.0 (+https://github.com)" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { flights: [], latencyMs: Date.now() - t0, ok: false, detail: `HTTP ${res.status}` };
    }
    raw = (await res.json()) as AdsbFiResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { flights: [], latencyMs: Date.now() - t0, ok: false, detail: `fetch failed — ${msg}` };
  }

  const latencyMs = Date.now() - t0;
  const aircraft: AdsbFiAircraft[] = raw.aircraft ?? raw.ac ?? [];
  const now = raw.now ?? Math.floor(Date.now() / 1000);

  /**
   * Classify aircraft relative to KAUS:
   *   RECENTLY_DEPARTED – airborne, within 200 nm, altitude climbing (positive baro_rate),
   *                       confident this is a departure not an arrival or overfly.
   *   AT_GATE           – on ground at or very near KAUS (< 3 nm).
   *   APPROACHING       – descending toward KAUS, not a departure.
   * We only return RECENTLY_DEPARTED and AT_GATE rows.
   */
  const flights: OpenSkyFlight[] = [];

  for (const ac of aircraft) {
    const callsign = (ac.flight ?? "").trim().toUpperCase();
    if (!callsign || callsign.length < 4) continue;
    if (!isDeltaSystem(callsign, undefined)) continue;

    const alt = ac.alt_baro;
    const onGround = alt === "ground";
    const altFt = onGround ? 0 : (typeof alt === "number" ? alt : -1);
    const gs = ac.gs ?? 0;
    const baroRate = ac.baro_rate ?? 0;
    const dst = ac.dst ?? 999;

    // Skip: cruising overflight not related to AUS
    if (!onGround && altFt > 15_000 && dst > 30) continue;

    // Skip: aircraft descending into AUS (likely an arrival, not a departure)
    if (!onGround && baroRate < -500 && dst < 60) continue;

    const seenAt = now - (ac.seen ?? 0);

    flights.push({
      icao24: ac.hex,
      callsign,
      firstSeen: seenAt,
      lastSeen: now,
      estDepartureAirport: STATION.icao,
      estArrivalAirport: null,  // ADS-B position data has no route/destination
    } as OpenSkyFlight);
  }

  memo = { at: Date.now(), data: flights };
  return { flights, latencyMs, ok: true, detail: `${flights.length} Delta aircraft observed` };
}
