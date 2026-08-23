/**
 * OpenSky Network driver — the free, no-card live source.
 *
 * WHAT IT GIVES YOU
 *   • Confirmed wheels-up for every Delta departure off KAUS (ADS-B truth).
 *   • The live position of the inbound aircraft that becomes your next
 *     departure — which is the real driver of "late inbound aircraft".
 *   • Tail-number resolution via the ICAO 24-bit address.
 *
 * WHAT IT CANNOT GIVE YOU — read this before trusting the board
 *   OpenSky is ADS-B only. There is no schedule, no gate and no cancellation
 *   flag anywhere in it. A cancelled flight simply never appears. Everything
 *   schedule-shaped in this platform is therefore *learned* from observed
 *   history (see baseline.ts) and clearly marked with a lower confidence.
 *   Set AEROAPI_KEY to get authoritative scheduled times, gates and true
 *   `cancelled` flags; the AeroAPI driver then takes over as primary.
 *
 * AUTH
 *   Anonymous works and is what this ships with (400 credits/day, windows of
 *   roughly six hours or less). Setting OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
 *   raises that to 4,000/day via OAuth2 and is strongly recommended once the
 *   cron poller is running every five minutes.
 */

import { STATION, POLL, carrierForCallsign, DELTA_HUBS } from "../config";

const API = "https://opensky-network.org/api";
const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

export interface OpenSkyFlight {
  icao24: string;
  callsign: string | null;
  firstSeen: number;
  lastSeen: number;
  estDepartureAirport: string | null;
  estArrivalAirport: string | null;
}

export interface OpenSkyState {
  icao24: string;
  callsign: string;
  longitude: number | null;
  latitude: number | null;
  baroAltitude: number | null;
  onGround: boolean;
  velocity: number | null;
  verticalRate: number | null;
  lastContact: number;
}

let cachedToken: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  cachedToken = {
    token: json.access_token,
    expires: Date.now() + (json.expires_in ?? 1800) * 1000,
  };
  return cachedToken.token;
}

/**
 * OpenSky is a volunteer-run service and answers 429/503 fairly often under
 * anonymous credits. One short retry turns most of those into a normal answer;
 * anything beyond that is a real outage and should surface to the caller.
 */
async function osFetch(path: string, attempt = 0): Promise<Response> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    headers: {
      "User-Agent": "aus-bagroom-platform/1.0 (+https://github.com)",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
    // Kept short on purpose: this runs inside a serverless function with a
    // 60-second ceiling, so a hanging source must fail fast, not eat the budget.
    signal: AbortSignal.timeout(12_000),
  });
  if ((res.status === 503 || res.status === 429) && attempt < 1) {
    await new Promise((r) => setTimeout(r, 1500));
    return osFetch(path, attempt + 1);
  }
  return res;
}

/** Turn an OpenSky HTTP status into something an operator can act on. */
function explain(status: number, what: string): Error {
  if (status === 429 || status === 503) {
    return new Error(
      `OpenSky ${what} ${status} — out of credits or rate limited. Anonymous access allows 400 credits/day; set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET for 4,000.`,
    );
  }
  if (status === 401 || status === 403) {
    return new Error(`OpenSky ${what} ${status} — credentials rejected. Check the OAuth2 client id and secret.`);
  }
  return new Error(`OpenSky ${what} ${status}`);
}

/**
 * Departures observed off KAUS in the trailing window.
 * Anonymous credits reject windows much larger than six hours, so the poller
 * runs often and stitches history in the store rather than asking for a big range.
 */
/**
 * Every OpenSky query spends a credit from a small daily allowance, and one
 * request can serve every board on the floor. This memo collapses all calls
 * inside a 60-second window — from concurrent feed builds and from the poller
 * itself — into a single upstream request per instance.
 */
let departuresMemo: { at: number; data: OpenSkyFlight[] } | null = null;
const MEMO_MS = 60_000;

export async function fetchDepartures(windowSeconds = POLL.windowSeconds): Promise<OpenSkyFlight[]> {
  if (departuresMemo && Date.now() - departuresMemo.at < MEMO_MS) {
    return departuresMemo.data;
  }
  const end = Math.floor(Date.now() / 1000);
  const begin = end - windowSeconds;
  const res = await osFetch(
    `/flights/departure?airport=${STATION.icao}&begin=${begin}&end=${end}`,
  );
  if (res.status === 404) {
    departuresMemo = { at: Date.now(), data: [] };
    return []; // OpenSky returns 404 for "no flights in this window"
  }
  if (!res.ok) throw explain(res.status, "departures");
  const raw = (await res.json()) as OpenSkyFlight[];
  const data = Array.isArray(raw) ? raw : [];
  departuresMemo = { at: Date.now(), data };
  return data;
}

/** Arrivals into KAUS — these become the aircraft for the next departure bank. */
export async function fetchArrivals(windowSeconds = POLL.windowSeconds): Promise<OpenSkyFlight[]> {
  const end = Math.floor(Date.now() / 1000);
  const begin = end - windowSeconds;
  const res = await osFetch(`/flights/arrival?airport=${STATION.icao}&begin=${begin}&end=${end}`);
  if (res.status === 404) return [];
  if (!res.ok) throw explain(res.status, "arrivals");
  const raw = (await res.json()) as OpenSkyFlight[];
  return Array.isArray(raw) ? raw : [];
}

/** Live state vectors in the AUS box — aircraft on the field or on approach. */
export async function fetchLocalStates(): Promise<OpenSkyState[]> {
  const b = STATION.bbox;
  const res = await osFetch(
    `/states/all?lamin=${b.lamin}&lomin=${b.lomin}&lamax=${b.lamax}&lomax=${b.lomax}`,
  );
  if (!res.ok) throw explain(res.status, "states");
  const json = (await res.json()) as { states: unknown[][] | null };
  const rows = json.states ?? [];
  return rows.map((s) => ({
    icao24: String(s[0] ?? ""),
    callsign: String(s[1] ?? "").trim(),
    longitude: (s[5] as number) ?? null,
    latitude: (s[6] as number) ?? null,
    baroAltitude: (s[7] as number) ?? null,
    onGround: Boolean(s[8]),
    velocity: (s[9] as number) ?? null,
    verticalRate: (s[11] as number) ?? null,
    lastContact: Number(s[4] ?? 0),
  }));
}

/**
 * Is this callsign a Delta-system flight?
 * Mainline and Endeavor always count. The shared regionals (SkyWest, Republic,
 * GoJet) fly for several mainlines, so they only count when the other end of
 * the flight is a Delta hub — that is what `hubGated` means.
 */
export function isDeltaSystem(
  callsign: string | null | undefined,
  otherEnd?: string | null,
): boolean {
  if (!callsign) return false;
  const carrier = carrierForCallsign(callsign);
  if (!carrier) return false;
  if (!carrier.hubGated) return true;
  return Boolean(otherEnd && DELTA_HUBS.has(otherEnd));
}

/** "DAL1684" → "DL 1684". Regionals are marketed as DL too. */
export function callsignToFlightNumber(callsign: string): string {
  const cs = callsign.trim().toUpperCase();
  const m = cs.match(/^([A-Z]{3})(\d+)$/);
  if (!m) return cs;
  return `DL ${m[2]}`;
}
