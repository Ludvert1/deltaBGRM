/**
 * Learned schedule engine.
 *
 * OpenSky has no schedule. So the platform grows one: every time the poller
 * sees DAL1684 roll off KAUS at 07:42 local on a Tuesday, that becomes evidence
 * for a Tuesday 07:42 slot. After a few weeks the station's own operating
 * pattern is the schedule — and a slot that is due, past its grace window, and
 * unseen is the signal that something got cancelled.
 *
 * This is inference, not truth, and the platform says so everywhere it surfaces:
 * such rows are labelled "Suspected Cancel", carry a confidence below 1, and
 * never overwrite a real `cancelled` flag from AeroAPI.
 */

import { Baseline, BaselineSlot, FeedFlight } from "./types";
import { DETECTION, BAG_MODEL, DELTA_CARRIERS, toIata } from "./config";
import { localParts, localMinuteToUtc, toLocalTime, localDate } from "./time";
import { OpenSkyFlight, isDeltaSystem, callsignToFlightNumber } from "./providers/opensky";
import { store, KEYS } from "./store";

export function emptyBaseline(): Baseline {
  return { version: 1, updatedAt: new Date().toISOString(), slots: [], observedDays: [] };
}

export async function loadBaseline(): Promise<Baseline> {
  return (await store.get<Baseline>(KEYS.baseline)) ?? emptyBaseline();
}

export async function saveBaseline(b: Baseline): Promise<void> {
  await store.set(KEYS.baseline, b);
}

function slotKey(callsign: string, dow: number): string {
  return `${callsign}|${dow}`;
}

/**
 * Fold newly observed departures into the baseline.
 * Uses an incremental mean plus a Welford-style spread so a slot that drifts
 * (a seasonal retime) converges instead of oscillating.
 */
export function learn(baseline: Baseline, departures: OpenSkyFlight[]): Baseline {
  const index = new Map<string, BaselineSlot>();
  for (const s of baseline.slots) index.set(slotKey(s.callsign, s.dow), s);
  const days = new Set(baseline.observedDays);

  for (const d of departures) {
    const callsign = (d.callsign ?? "").trim().toUpperCase();
    if (!callsign) continue;
    if (!isDeltaSystem(callsign, d.estArrivalAirport)) continue;

    const when = new Date(d.firstSeen * 1000);
    const parts = localParts(when);
    days.add(parts.date);

    const key = slotKey(callsign, parts.dow);
    const existing = index.get(key);

    if (!existing) {
      index.set(key, {
        callsign,
        dow: parts.dow,
        minuteOfDay: parts.minuteOfDay,
        observations: 1,
        spread: 0,
        destination: toIata(d.estArrivalAirport),
        operator: callsign.slice(0, 3),
        firstSeen: when.toISOString(),
        lastSeen: when.toISOString(),
      });
      continue;
    }

    // Ignore a sighting that is nowhere near the learned slot — it is a
    // different rotation on the same flight number, not the same slot drifting.
    const delta = parts.minuteOfDay - existing.minuteOfDay;
    if (Math.abs(delta) > 6 * 60) continue;

    const n = existing.observations + 1;
    const mean = existing.minuteOfDay + delta / n;
    const variance =
      (existing.spread * existing.spread * existing.observations +
        (parts.minuteOfDay - mean) * (parts.minuteOfDay - existing.minuteOfDay)) /
      n;

    existing.observations = n;
    existing.minuteOfDay = Math.round(mean);
    existing.spread = Math.round(Math.sqrt(Math.max(0, variance)));
    existing.lastSeen = when.toISOString();
    if (!existing.destination && d.estArrivalAirport) {
      existing.destination = toIata(d.estArrivalAirport);
    }
  }

  // Drop slots that have gone quiet for longer than the lookback window —
  // a route that ended should stop generating phantom cancellations.
  const staleBefore = Date.now() - DETECTION.lookbackWeeks * 7 * 86_400_000;
  const slots = [...index.values()].filter(
    (s) => new Date(s.lastSeen).getTime() >= staleBefore || s.observations >= 10,
  );

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    slots: slots.sort((a, b) => a.dow - b.dow || a.minuteOfDay - b.minuteOfDay),
    observedDays: [...days].sort().slice(-60),
  };
}

/** Slots the baseline expects to operate on the given local day. */
export function slotsForDay(baseline: Baseline, ref: Date = new Date()): BaselineSlot[] {
  const { dow } = localParts(ref);
  return baseline.slots.filter(
    (s) => s.dow === dow && s.observations >= DETECTION.minObservations,
  );
}

/** How much to trust a learned slot: more sightings and tighter spread → higher. */
export function slotConfidence(slot: BaselineSlot): number {
  const byCount = Math.min(1, slot.observations / (DETECTION.minObservations * 3));
  const bySpread = 1 / (1 + slot.spread / DETECTION.slotToleranceMinutes);
  return Math.round(byCount * bySpread * 100) / 100;
}

/**
 * Turn learned slots into board rows, and flag the ones that should have gone
 * by now but never appeared in the observed set.
 *
 * `observedCallsigns` are the Delta callsigns actually seen departing today.
 */
export function projectDay(
  baseline: Baseline,
  observedCallsigns: Set<string>,
  now: Date = new Date(),
): FeedFlight[] {
  const rows: FeedFlight[] = [];

  for (const slot of slotsForDay(baseline, now)) {
    const expectedUtc = localMinuteToUtc(slot.minuteOfDay, now);
    const iso = expectedUtc.toISOString();
    const minutesLate = Math.round((now.getTime() - expectedUtc.getTime()) / 60_000);
    const seen = observedCallsigns.has(slot.callsign);

    // Already observed departing — the live layer owns this row, skip it.
    if (seen) continue;

    const grace = DETECTION.graceMinutes + slot.spread;
    const overdue = minutesLate > grace;
    const confidence = slotConfidence(slot);

    // Not overdue yet: this is simply an upcoming scheduled departure.
    // Overdue and unseen: suspected cancellation.
    const carrier = DELTA_CARRIERS.find((c) => c.prefix === slot.operator);
    const pax = Math.round((carrier?.seats ?? 160) * BAG_MODEL.loadFactor);
    const bags = Math.round(pax * BAG_MODEL.bagsPerPax);

    rows.push({
      flight: callsignToFlightNumber(slot.callsign),
      ident: slot.callsign,
      destination: slot.destination,
      gate: "",
      tail: "",
      equipment: "",
      status: overdue ? "Suspected Cancel" : "Scheduled",
      cancelled: false, // never assert a hard cancel from inference
      diverted: false,
      etd_sched_local: toLocalTime(iso),
      etd_est_local: "",
      etd_actual_local: "",
      etd_local: toLocalTime(iso),
      delayed: false,
      scheduled_out: iso,
      estimated_out: null,
      actual_out: null,
      paxCount: pax,
      source: "baseline",
      schedSource: "baseline",
      confidence: overdue ? confidence : Math.round(confidence * 0.9 * 100) / 100,
      operator: slot.operator,
      bagEstimate: bags,
      cartEstimate: Math.max(1, Math.ceil(bags / BAG_MODEL.bagsPerCart)),
      note: overdue
        ? `Learned slot from ${slot.observations} prior ${dayName(slot.dow)}s (±${slot.spread} min). ${minutesLate} min past expected pushback with no ADS-B departure — suspected cancellation. Verify on delta.com before acting.`
        : `Learned slot from ${slot.observations} prior ${dayName(slot.dow)}s (±${slot.spread} min). Not yet due.`,
    });
  }

  return rows;
}

/** Record the callsigns seen departing on a given local date. */
export async function recordObserved(departures: OpenSkyFlight[]): Promise<void> {
  const byDate = new Map<string, Set<string>>();
  for (const d of departures) {
    const cs = (d.callsign ?? "").trim().toUpperCase();
    if (!cs || !isDeltaSystem(cs, d.estArrivalAirport)) continue;
    const date = localDate(new Date(d.firstSeen * 1000));
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date)!.add(cs);
  }
  for (const [date, set] of byDate) {
    const key = `aus:obs:${date}`;
    const prev = (await store.get<string[]>(key)) ?? [];
    await store.set(key, [...new Set([...prev, ...set])]);
  }
}

export async function observedToday(ref: Date = new Date()): Promise<Set<string>> {
  const list = (await store.get<string[]>(`aus:obs:${localDate(ref)}`)) ?? [];
  return new Set(list);
}

export function dayName(dow: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow] ?? "day";
}

/** How usable the learned schedule currently is, for the dashboard banner. */
export function baselineMaturity(b: Baseline): {
  days: number;
  slots: number;
  trusted: number;
  ready: boolean;
  message: string;
} {
  const trusted = b.slots.filter((s) => s.observations >= DETECTION.minObservations).length;
  const days = b.observedDays.length;
  const ready = days >= 7 && trusted >= 10;
  return {
    days,
    slots: b.slots.length,
    trusted,
    ready,
    message: ready
      ? `Schedule learned from ${days} days of observations — ${trusted} trusted slots.`
      : `Still learning: ${days} day${days === 1 ? "" : "s"} observed, ${trusted} trusted slot${trusted === 1 ? "" : "s"}. Suspected-cancellation detection needs roughly a week of polling before it is dependable.`,
  };
}
