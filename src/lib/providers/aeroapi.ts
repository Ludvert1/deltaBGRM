/**
 * FlightAware AeroAPI driver — optional, dark unless AEROAPI_KEY is set.
 *
 * This is the only source in the platform that carries an authoritative
 * `cancelled` flag, published scheduled times, and gate assignments. When the
 * key is present this driver becomes primary and OpenSky drops to a
 * cross-check role; when it is absent nothing here runs and no credits burn.
 *
 * FlightAware's Personal tier includes a monthly usage credit. This driver
 * keeps consumption low by requesting a single window and capping pagination.
 */

import { FeedFlight } from "../types";
import { BAG_MODEL, DELTA_CARRIERS, pierFromGate, PIER_TO_LEAD, STATION } from "../config";
import { toLocalTime } from "../time";

const BASE = "https://aeroapi.flightaware.com/aeroapi";
const MAX_PAGES = 4;
const DELTA_OPERATORS = new Set(DELTA_CARRIERS.map((c) => c.prefix));

export function aeroApiEnabled(): boolean {
  return Boolean(process.env.AEROAPI_KEY);
}

interface AeroFlight {
  ident?: string;
  ident_iata?: string;
  fa_flight_id?: string;
  operator?: string;
  operator_icao?: string;
  codeshares_iata?: string[];
  codeshares?: string[];
  destination?: { code_iata?: string; code?: string; city?: string };
  gate_origin?: string;
  terminal_origin?: string;
  registration?: string;
  aircraft_type?: string;
  cancelled?: boolean;
  diverted?: boolean;
  scheduled_out?: string;
  scheduled_off?: string;
  estimated_out?: string;
  estimated_off?: string;
  actual_out?: string;
  actual_off?: string;
}

async function fetchAllPages(url: string, key: string, listKey: string): Promise<AeroFlight[]> {
  const out: AeroFlight[] = [];
  let next: string | null = url;
  for (let i = 0; i < MAX_PAGES && next; i++) {
    const res: Response = await fetch(next, {
      headers: { "x-apikey": key },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`AeroAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as Record<string, unknown>;
    const list = (data[listKey] as AeroFlight[]) ?? [];
    out.push(...list);
    const links = data.links as { next?: string } | undefined;
    next = links?.next ? BASE + links.next : null;
  }
  return out;
}

function isDelta(f: AeroFlight): boolean {
  const op = (f.operator || f.operator_icao || "").toUpperCase();
  const identIata = (f.ident_iata || "").toUpperCase();
  const codeshares = [...(f.codeshares_iata ?? []), ...(f.codeshares ?? [])].map((c) =>
    String(c).toUpperCase(),
  );
  if (identIata.startsWith("DL")) return true;
  if (op === "DAL") return true;
  return DELTA_OPERATORS.has(op) && codeshares.some((c) => c.startsWith("DL"));
}

function marketingNumber(f: AeroFlight): string {
  let n = f.ident_iata || f.ident || "";
  if (!n.toUpperCase().startsWith("DL")) {
    const dl = (f.codeshares_iata ?? []).find((c) => String(c).toUpperCase().startsWith("DL"));
    if (dl) n = dl;
  }
  n = n.replace(/^DAL/i, "DL");
  const m = String(n).match(/^([A-Z]{2,3})\s*(\d+)$/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : n;
}

function seatsFor(f: AeroFlight): number {
  const op = (f.operator || f.operator_icao || "").toUpperCase();
  const carrier = DELTA_CARRIERS.find((c) => c.prefix === op);
  return carrier?.seats ?? 160;
}

export async function fetchAeroApiDepartures(): Promise<FeedFlight[]> {
  const key = process.env.AEROAPI_KEY;
  if (!key) return [];

  const now = Date.now();
  const start = new Date(now - 2 * 3600_000).toISOString().slice(0, 19) + "Z";
  const end = new Date(now + 16 * 3600_000).toISOString().slice(0, 19) + "Z";

  const [upcoming, departed] = await Promise.all([
    fetchAllPages(
      `${BASE}/airports/${STATION.icao}/flights/scheduled_departures?start=${start}&end=${end}&max_pages=1`,
      key,
      "scheduled_departures",
    ),
    fetchAllPages(
      `${BASE}/airports/${STATION.icao}/flights/departures?start=${start}&end=${end}&max_pages=1`,
      key,
      "departures",
    ),
  ]);

  const seen = new Set<string>();
  const merged = [...departed, ...upcoming].filter((f) => {
    if (!isDelta(f)) return false;
    const id = f.fa_flight_id || `${f.ident}${f.scheduled_out ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return merged
    .map((f): FeedFlight => {
      const sched = f.scheduled_out || f.scheduled_off || null;
      const est = f.estimated_out || f.estimated_off || null;
      const act = f.actual_out || f.actual_off || null;
      const best = act || est || sched;

      const delayMin =
        sched && est ? Math.round((new Date(est).getTime() - new Date(sched).getTime()) / 60_000) : 0;
      const gate = String(f.gate_origin ?? "").replace(/^G/i, "").trim();
      const pier = pierFromGate(gate);
      const pax = Math.round(seatsFor(f) * BAG_MODEL.loadFactor);
      const bags = Math.round(pax * BAG_MODEL.bagsPerPax);

      return {
        flight: marketingNumber(f),
        ident: f.ident,
        destination: f.destination?.code_iata || f.destination?.code || "",
        destination_city: f.destination?.city || "",
        gate,
        terminal: f.terminal_origin || "",
        tail: f.registration || "",
        equipment: f.aircraft_type || "",
        status: f.cancelled
          ? "Canceled"
          : f.diverted
            ? "Diverted"
            : act
              ? "Departed"
              : delayMin > 5
                ? "Delayed"
                : "Scheduled",
        cancelled: Boolean(f.cancelled),
        diverted: Boolean(f.diverted),
        etd_sched_local: toLocalTime(sched),
        etd_est_local: toLocalTime(est),
        etd_actual_local: toLocalTime(act),
        etd_local: toLocalTime(best),
        delayed: delayMin > 5,
        scheduled_out: sched,
        estimated_out: est,
        actual_out: act,
        paxCount: pax,
        source: "aeroapi",
        confidence: 1,
        operator: (f.operator || f.operator_icao || "").toUpperCase(),
        pier: pier || undefined,
        teamLead: pier ? PIER_TO_LEAD[pier] : undefined,
        bagEstimate: bags,
        cartEstimate: Math.max(1, Math.ceil(bags / BAG_MODEL.bagsPerCart)),
      };
    })
    .filter((f) => f.scheduled_out || f.estimated_out)
    .sort(
      (a, b) =>
        new Date(a.estimated_out || a.scheduled_out || 0).getTime() -
        new Date(b.estimated_out || b.scheduled_out || 0).getTime(),
    );
}
