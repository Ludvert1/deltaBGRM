/**
 * Feed assembly — merges every available source into one board-shaped payload.
 *
 * Precedence, highest first:
 *   1. AeroAPI        authoritative schedule, gate, and true `cancelled` flags
 *   2. OpenSky        observed truth: this aircraft actually left the ground
 *   3. Learned slots  inference only, for upcoming and suspected-cancelled rows
 *
 * A lower-precedence source never overwrites a field a higher one supplied, and
 * it never upgrades a row's status to a hard cancel.
 */

import { FeedFlight, FeedResponse, SourceStatus, NasSummary } from "../types";
import { STATION, BAG_MODEL, DELTA_CARRIERS, toIata, pierFromGate, PIER_TO_LEAD } from "../config";
import { toLocalTime } from "../time";
import {
  fetchDepartures,
  isDeltaSystem,
  callsignToFlightNumber,
  OpenSkyFlight,
} from "./opensky";
import { fetchAdsbFiDepartures } from "./adsbfi";
import { buildSeedFlights } from "./seed-aus";
import { fetchNasStatus } from "./faa";
import { fetchAeroApiDepartures, aeroApiEnabled } from "./aeroapi";
import { loadBaseline, saveBaseline, learn, recordObserved, projectDay, observedToday } from "../baseline";
import { scheduleForToday, scheduleStatus } from "../schedule";

/**
 * Opportunistic learning.
 *
 * Vercel's Hobby plan caps cron at one run per day, which is nowhere near
 * enough to learn a schedule. But the board already refreshes this feed every
 * ~120 seconds from every device on the floor — so each feed build folds what
 * it just fetched into the baseline. The board is the poller; cron is only a
 * safety net. Throttled per instance so a wall of TVs does not multiply writes.
 */
let lastLearnAt = 0;
const LEARN_INTERVAL_MS = 60_000;

async function learnOpportunistically(observed: OpenSkyFlight[]): Promise<void> {
  if (!observed.length) return;
  if (Date.now() - lastLearnAt < LEARN_INTERVAL_MS) return;
  lastLearnAt = Date.now();
  try {
    await saveBaseline(learn(await loadBaseline(), observed));
    await recordObserved(observed);
  } catch {
    // Learning is best-effort; never fail the feed over it.
  }
}

/** An OpenSky sighting → a "Departed" board row. */
export function departureToFeedFlight(d: OpenSkyFlight): FeedFlight {
  const callsign = (d.callsign ?? "").trim().toUpperCase();
  const iso = new Date(d.firstSeen * 1000).toISOString();
  const operator = callsign.slice(0, 3);
  const carrier = DELTA_CARRIERS.find((c) => c.prefix === operator);
  const pax = Math.round((carrier?.seats ?? 160) * BAG_MODEL.loadFactor);
  const bags = Math.round(pax * BAG_MODEL.bagsPerPax);

  return {
    flight: callsignToFlightNumber(callsign),
    ident: callsign,
    destination: toIata(d.estArrivalAirport),
    gate: "",
    tail: "",
    equipment: "",
    status: "Departed",
    cancelled: false,
    diverted: false,
    etd_sched_local: "",
    etd_est_local: "",
    etd_actual_local: toLocalTime(iso),
    etd_local: toLocalTime(iso),
    delayed: false,
    scheduled_out: null,
    estimated_out: null,
    actual_out: iso,
    paxCount: pax,
    source: "opensky",
    confidence: 0.95,
    operator,
    bagEstimate: bags,
    cartEstimate: Math.max(1, Math.ceil(bags / BAG_MODEL.bagsPerCart)),
    note: `Confirmed airborne off ${STATION.iata} by ADS-B at ${toLocalTime(iso)}.`,
  };
}

function mergeKey(f: FeedFlight): string {
  return f.flight.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

/** Fill blanks on `into` from `from` without ever demoting a stronger field. */
function enrich(into: FeedFlight, from: FeedFlight): void {
  if (!into.destination && from.destination) into.destination = from.destination;
  if (!into.gate && from.gate) into.gate = from.gate;
  if (!into.tail && from.tail) into.tail = from.tail;
  if (!into.equipment && from.equipment) into.equipment = from.equipment;
  if (!into.scheduled_out && from.scheduled_out) {
    into.scheduled_out = from.scheduled_out;
    into.etd_sched_local = from.etd_sched_local;
    // Carry the provenance with the time. A schedule inferred from the
    // aircraft's own movement must never be mistaken for a published one.
    into.schedSource = from.schedSource ?? from.source;
  }
  if (!into.actual_out && from.actual_out) {
    into.actual_out = from.actual_out;
    into.etd_actual_local = from.etd_actual_local;
  }
  if (!into.etd_local && from.etd_local) into.etd_local = from.etd_local;
  if (!into.note && from.note) into.note = from.note;

  // Observed truth beats any inference about whether the flight went.
  if (from.source === "opensky" && from.actual_out) {
    into.status = into.cancelled ? into.status : "Departed";
    into.confidence = Math.max(into.confidence, 0.95);
  }

  if (!into.gate) return;
  const pier = pierFromGate(into.gate);
  if (pier) {
    into.pier = pier;
    into.teamLead = PIER_TO_LEAD[pier];
  }
}

export interface BuildOptions {
  /** Skip the FAA call (used by the cron poller, which fetches it separately). */
  includeNas?: boolean;
}

export async function buildFeed(opts: BuildOptions = {}): Promise<FeedResponse> {
  const includeNas = opts.includeNas ?? true;
  const sources: SourceStatus[] = [];
  const warnings: string[] = [];

  /* —— AeroAPI (optional, authoritative) —— */
  let aero: FeedFlight[] = [];
  if (aeroApiEnabled()) {
    const t0 = Date.now();
    try {
      aero = await fetchAeroApiDepartures();
      sources.push({
        id: "aeroapi",
        ok: true,
        label: "FlightAware AeroAPI",
        detail: "Authoritative schedule, gates and cancellations",
        latencyMs: Date.now() - t0,
        count: aero.length,
      });
    } catch (e) {
      sources.push({
        id: "aeroapi",
        ok: false,
        label: "FlightAware AeroAPI",
        detail: String(e instanceof Error ? e.message : e),
        latencyMs: Date.now() - t0,
      });
      warnings.push("AeroAPI failed; falling back to ADS-B live feed and the seed schedule.");
    }
  } else {
    sources.push({
      id: "aeroapi",
      ok: false,
      label: "FlightAware AeroAPI",
      detail: "Not configured — set AEROAPI_KEY for true cancellation flags and gates",
    });
  }

  /* —— Live ADS-B: adsb.fi primary, OpenSky fallback —————————————————————
   *
   * OpenSky (opensky-network.org) times out from Vercel's serverless network
   * because their servers are on a Swiss university network that blocks cloud
   * provider IP ranges. ADS-B.fi carries the same volunteer radio data via
   * CDN-backed infrastructure that IS reachable from any cloud provider.
   *
   * adsb.fi gives us:
   *   • Every Delta aircraft airborne within 200 nm of KAUS right now.
   *   • Confirmed "Departed" status the moment a flight leaves the field.
   *   • Aircraft on ground/taxiing at AUS (status will update to Departed).
   * ————————————————————————————————————————————————————————————————————— */
  let observed: OpenSkyFlight[] = [];
  const t1 = Date.now();

  const adsbFi = await fetchAdsbFiDepartures();
  if (adsbFi.ok) {
    observed = adsbFi.flights.filter((d) => isDeltaSystem(d.callsign, d.estArrivalAirport));
    sources.push({
      id: "opensky",
      ok: true,
      label: "ADS-B Live (adsb.fi)",
      detail: observed.length > 0
        ? `${observed.length} Delta aircraft near ${STATION.iata} (${adsbFi.latencyMs} ms)`
        : `Connected — no Delta aircraft in range right now (${adsbFi.latencyMs} ms)`,
      latencyMs: adsbFi.latencyMs,
      count: observed.length,
    });
  } else {
    // adsb.fi failed — try OpenSky as a last resort
    try {
      const all = await fetchDepartures();
      observed = all.filter((d) => isDeltaSystem(d.callsign, d.estArrivalAirport));
      sources.push({
        id: "opensky",
        ok: true,
        label: "OpenSky Network",
        detail: `${all.length} departures off ${STATION.icao}; ${observed.length} Delta`,
        latencyMs: Date.now() - t1,
        count: observed.length,
      });
    } catch (e) {
      sources.push({
        id: "opensky",
        ok: false,
        label: "ADS-B Live",
        detail: `adsb.fi: ${adsbFi.detail} | OpenSky: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`,
        latencyMs: Date.now() - t1,
      });
      warnings.push(
        "Live ADS-B unavailable. The board is showing the seed schedule and any pasted flights. Set AEROAPI_KEY for authoritative real-time data.",
      );
    }
  }

  /* —— Learned schedule —— */
  await learnOpportunistically(observed);
  const baseline = await loadBaseline();
  const seenToday = await observedToday();
  for (const d of observed) {
    const cs = (d.callsign ?? "").trim().toUpperCase();
    if (cs) seenToday.add(cs);
  }
  const projected = projectDay(baseline, seenToday);
  sources.push({
    id: "baseline",
    ok: baseline.slots.length > 0,
    label: "Learned schedule",
    detail:
      baseline.slots.length > 0
        ? `${baseline.slots.length} slots from ${baseline.observedDays.length} observed days`
        : "No history yet — run the poller for a few days",
    count: projected.length,
  });

  /* —— Merge —— */
  const byKey = new Map<string, FeedFlight>();
  const push = (rows: FeedFlight[]) => {
    for (const row of rows) {
      const key = mergeKey(row);
      const existing = byKey.get(key);
      if (!existing) {
        const pier = pierFromGate(row.gate);
        if (pier) {
          row.pier = pier;
          row.teamLead = PIER_TO_LEAD[pier];
        }
        byKey.set(key, { ...row });
      } else {
        enrich(existing, row);
      }
    }
  };

  /* —— Seeded schedule (from the board's pasted departure list) —— */
  let seeded: FeedFlight[] = [];
  try {
    seeded = await scheduleForToday();
    sources.push({
      id: "seed",
      ok: seeded.length > 0,
      label: "Seeded schedule",
      detail: (await scheduleStatus()).message,
      count: seeded.length,
    });
  } catch (e) {
    sources.push({
      id: "seed",
      ok: false,
      label: "Seeded schedule",
      detail: String(e instanceof Error ? e.message : e),
    });
  }

  /* —— Built-in AUS seed schedule ————————————————————————————————————————
   *
   * Real Delta AUS daily departures with correct gates, destinations, and
   * Central-time scheduled ETDs. Works from day 1 with zero API keys and
   * zero history. Any higher-priority source (AeroAPI, adsb.fi confirmation,
   * board paste) silently overrides individual rows.
   * ————————————————————————————————————————————————————————————————————— */
  const ausSeeded = buildSeedFlights();
  sources.push({
    id: "seed",
    ok: true,
    label: "AUS seed schedule",
    detail: `${ausSeeded.length} real Delta AUS departures (gates + CDT times built in)`,
    count: ausSeeded.length,
  });

  push(aero);                              // 1. AeroAPI — authoritative (key req'd)
  push(observed.map(departureToFeedFlight)); // 2. adsb.fi — confirms airborne departures
  push(ausSeeded);    // 3. Seed schedule FIRST: establishes Departed/Scheduled status
  push(seeded);       // 4. Board paste enriches gates/times without downgrading status
  push(projected);    // 5. Learned baseline — grows over days

  /**
   * Backfill destinations from the learned schedule.
   *
   * OpenSky only resolves `estArrivalAirport` once the aircraft has landed, so
   * a flight that just left AUS has a blank destination for the next few hours
   * — useless on a bag room board. The baseline knows where that callsign
   * usually goes, so fill it in and say so in the note.
   */
  const learnedDest = new Map<string, string>();
  for (const s of baseline.slots) {
    if (s.destination && !learnedDest.has(s.callsign)) learnedDest.set(s.callsign, s.destination);
  }
  for (const f of byKey.values()) {
    if (f.destination || !f.ident) continue;
    const dest = learnedDest.get(f.ident);
    if (!dest) continue;
    f.destination = dest;
    f.note = `${f.note ?? ""} Destination ${dest} inferred from prior operations of this flight number — ADS-B does not resolve an arrival airport until landing.`.trim();
  }

  /**
   * Age the seeded rows.
   *
   * A scheduled departure that has come and gone with no ADS-B sighting is
   * telling you something. A few minutes past is routine; twenty is a delay
   * worth showing the floor; an hour and a half is very likely a cancellation.
   * None of it is asserted as fact — the note carries the reasoning and the
   * hard `cancelled` flag is never set from inference.
   *
   * Do NOT age rows that the seed already marked "Departed" — those are
   * flights we KNOW left (the seed schedule computed minsAgo > 20 and set
   * actual_out). Only age flights that are still "Scheduled".
   */
  const nowMs = Date.now();
  for (const f of byKey.values()) {
    if (f.status === "Departed" || f.status === "Canceled" || f.cancelled) continue;
    if (f.source === "aeroapi") continue;
    if (!f.scheduled_out) continue;
    const lateBy = Math.round((nowMs - new Date(f.scheduled_out).getTime()) / 60_000);
    if (lateBy > 90) {
      f.status = "Suspected Cancel";
      f.confidence = Math.min(f.confidence, 0.6);
      f.note = `Scheduled ${f.etd_sched_local} but ${lateBy} min past with no ADS-B departure. Suspected cancellation — confirm before pulling bags.`;
    } else if (lateBy > 20) {
      f.status = "Delayed";
      f.delayed = true;
      f.note = `Scheduled ${f.etd_sched_local}, now ${lateBy} min past with no departure observed. Treat as delayed and hold the bags.`;
    }
  }

  /**
   * Time-window filter — only show flights relevant to the current shift.
   *
   * The board is a live operational tool. A completed 6 AM flight has no
   * bagroom value at 9 PM. We keep:
   *   • Departed/Completed flights: up to 90 minutes after their ETD
   *   • Scheduled/Upcoming flights: up to 12 hours ahead
   *   • Cancelled/Diverted: always shown (need awareness)
   *
   * This prevents the board from filling up with yesterday's history and
   * showing the right active window automatically.
   */
  const SHOW_DEPARTED_MINS  = 90;   // keep departed flights for 90 min
  const SHOW_UPCOMING_MINS  = 12 * 60; // show flights up to 12h ahead

  const nowMs2 = Date.now();
  const windowedFlights = [...byKey.values()].filter(f => {
    if (f.cancelled || f.diverted || f.status === "Canceled" || f.status === "Diverted") {
      return true; // always show cancelled/diverted for awareness
    }
    const etdIso = f.estimated_out || f.scheduled_out || f.actual_out;
    if (!etdIso) return true; // keep if no time info
    const etdMs = new Date(etdIso).getTime();
    const minsFromNow = (etdMs - nowMs2) / 60_000; // negative = past, positive = future
    if (f.status === "Departed" || f.actual_out) {
      return minsFromNow >= -SHOW_DEPARTED_MINS; // departed within last 90 min
    }
    return minsFromNow <= SHOW_UPCOMING_MINS; // scheduled within next 12h
  });

  const flights = windowedFlights.sort((a, b) => {
    const ta = new Date(a.estimated_out || a.scheduled_out || a.actual_out || 0).getTime();
    const tb = new Date(b.estimated_out || b.scheduled_out || b.actual_out || 0).getTime();
    return ta - tb;
  });

  /* —— FAA overlay —— */
  let nas: NasSummary | null = null;
  if (includeNas) {
    const t2 = Date.now();
    try {
      nas = await fetchNasStatus();
      sources.push({
        id: "faa",
        ok: true,
        label: "FAA NAS Status",
        detail: `${nas.local.length} local, ${nas.network.length} network programs`,
        latencyMs: Date.now() - t2,
      });
    } catch (e) {
      sources.push({
        id: "faa",
        ok: false,
        label: "FAA NAS Status",
        detail: String(e instanceof Error ? e.message : e),
        latencyMs: Date.now() - t2,
      });
    }
  }

  const degraded = !aeroApiEnabled() && seeded.length === 0;
  if (degraded) {
    warnings.push(
      "Running on OpenSky only. There is no forward schedule yet, so the board has nothing to work before a flight is already airborne. Paste today's Delta departure list into the board once (Ops Entry → Paste) — the platform keeps it, gates included, and projects it forward from then on. Setting AEROAPI_KEY does the same automatically.",
    );
  } else if (!aeroApiEnabled()) {
    warnings.push(
      "Scheduled times and gates come from the departure list pasted into the board, and cancellations are inferred from a missing ADS-B departure rather than reported — those rows are marked Suspected Cancel and must be verified before the team acts on them.",
    );
  }

  const now = new Date();
  return {
    airport: STATION.iata,
    timezone: STATION.timezone,
    generated_at: now.toISOString(),
    generated_at_local: toLocalTime(now.toISOString(), true),
    count: flights.length,
    scheduled_departures: flights,
    flights,
    sources,
    nas,
    degraded,
    warnings,
  };
}
