/**
 * Seeded schedule.
 *
 * The hard problem with an ADS-B-only feed is that it is entirely backward
 * looking: a flight appears once it is airborne, which is far too late for a
 * bag room that has to have carts moving 53 minutes before pushback.
 *
 * The way out costs nothing. The board already has a bulk-paste parser for the
 * departure list the team pulls from Delta's own system — flight number,
 * scheduled time, gate, destination, equipment. Every time the board syncs, we
 * take the schedule half of that data and keep it:
 *
 *   • as today's schedule, so the board and feed have upcoming flights now
 *   • as a weekday pattern, so tomorrow projects forward on its own
 *
 * That gives you a real forward schedule with real gates, from data the team
 * was already pasting in, with no API key. ADS-B then supplies the one thing a
 * paste cannot: what actually happened, and when the aircraft really left.
 */

import { FeedFlight, OpsFlight, SeededSlot, SeededSchedule } from "./types";
import { BAG_MODEL, DELTA_CARRIERS, pierFromGate, PIER_TO_LEAD } from "./config";
import { localDate, localParts, localMinuteToUtc, toLocalTime } from "./time";
import { parseBoardTime } from "./analytics-time";
import { store } from "./store";

const KEY_DAY = (date: string) => `aus:sched:${date}`;
const KEY_PATTERN = "aus:sched:pattern";

/**
 * Rows worth keeping.
 *
 * Only `sched` counts. `eta` is an *estimate* — and for a row the board created
 * from an ADS-B sighting it is the actual departure time. Seeding from it would
 * record "this flight is scheduled for exactly when it left", which then reads
 * back as a perfect on-time departure. Every flight would score 100%, and the
 * number would be meaningless. A row with no scheduled time is simply not a
 * schedule and is skipped.
 */
function usable(f: OpsFlight): boolean {
  return Boolean(f.flight && f.sched);
}

function normalizeFlight(n: string): string {
  const digits = String(n).replace(/[^0-9]/g, "");
  return digits ? `DL ${digits}` : String(n).trim().toUpperCase();
}

function seatsFor(equipment?: string, flight?: string): number {
  const eq = String(equipment ?? "").toUpperCase();
  // Regional jet gauges seat far fewer people, which halves the bag estimate.
  if (/^(CR[0-9]|CRJ|E7[0-9]|ERJ|E17|175|170|900|700)/.test(eq)) return 76;
  if (/^(319|320|321|32[0-9]|73[0-9]|738|739|753|757|76[0-9])/.test(eq)) return 160;
  // Delta numbers its regional flights in the 3000–5999 band at most stations.
  const num = Number(String(flight ?? "").replace(/[^0-9]/g, ""));
  if (num >= 3000 && num <= 5999) return 76;
  return DELTA_CARRIERS[0].seats;
}

/** Fold a board sync into today's schedule and the weekday pattern. */
export async function seedFromOps(rows: OpsFlight[], ref: Date = new Date()): Promise<{
  date: string;
  today: number;
  pattern: number;
}> {
  const good = rows.filter(usable);
  const date = localDate(ref);
  const { dow } = localParts(ref);

  const today = (await store.get<SeededSchedule>(KEY_DAY(date))) ?? {
    date,
    updatedAt: "",
    slots: [],
  };
  const pattern = (await store.get<Record<string, SeededSlot>>(KEY_PATTERN)) ?? {};

  const byFlight = new Map<string, SeededSlot>();
  for (const s of today.slots) byFlight.set(s.flight, s);

  for (const r of good) {
    const flight = normalizeFlight(r.flight);
    const minute = parseBoardTime(r.sched);
    if (minute === null) continue;

    const gate = String(r.gate ?? "").replace(/^G/i, "").trim();
    const slot: SeededSlot = {
      flight,
      minuteOfDay: minute,
      gate,
      destination: String(r.dest ?? "").toUpperCase(),
      equipment: String(r.equipment ?? ""),
      seats: seatsFor(r.equipment, flight),
      dow,
      updatedAt: new Date().toISOString(),
    };

    byFlight.set(flight, slot);
    pattern[`${flight}|${dow}`] = slot;
  }

  const merged: SeededSchedule = {
    date,
    updatedAt: new Date().toISOString(),
    slots: [...byFlight.values()].sort((a, b) => a.minuteOfDay - b.minuteOfDay),
  };

  await store.set(KEY_DAY(date), merged);
  await store.set(KEY_PATTERN, trimPattern(pattern));

  return { date, today: merged.slots.length, pattern: Object.keys(pattern).length };
}

/** Keep the weekday pattern from growing without bound. */
function trimPattern(pattern: Record<string, SeededSlot>): Record<string, SeededSlot> {
  const entries = Object.entries(pattern);
  if (entries.length <= 2000) return pattern;
  entries.sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : -1));
  return Object.fromEntries(entries.slice(0, 2000));
}

/**
 * Today's schedule as board rows.
 * Prefers an explicit seed for today; falls back to the weekday pattern so a
 * day nobody has pasted yet still projects from the last matching weekday.
 */
export async function scheduleForToday(ref: Date = new Date()): Promise<FeedFlight[]> {
  const date = localDate(ref);
  const { dow } = localParts(ref);

  const today = await store.get<SeededSchedule>(KEY_DAY(date));
  let slots: SeededSlot[] = today?.slots ?? [];
  let fromPattern = false;

  if (slots.length === 0) {
    const pattern = (await store.get<Record<string, SeededSlot>>(KEY_PATTERN)) ?? {};
    slots = Object.values(pattern).filter((s) => s.dow === dow);
    fromPattern = true;
  }

  return slots.map((s) => toFeedFlight(s, ref, fromPattern));
}

function toFeedFlight(slot: SeededSlot, ref: Date, fromPattern: boolean): FeedFlight {
  const iso = localMinuteToUtc(slot.minuteOfDay, ref).toISOString();
  const pier = pierFromGate(slot.gate);
  const pax = Math.round(slot.seats * BAG_MODEL.loadFactor);
  const bags = Math.round(pax * BAG_MODEL.bagsPerPax);

  return {
    flight: slot.flight,
    destination: slot.destination,
    gate: slot.gate,
    tail: "",
    equipment: slot.equipment,
    status: "Scheduled",
    cancelled: false,
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
    source: "seed",
    schedSource: "seed",
    confidence: fromPattern ? 0.75 : 0.95,
    pier: pier || undefined,
    teamLead: pier ? PIER_TO_LEAD[pier] : undefined,
    bagEstimate: bags,
    cartEstimate: Math.max(1, Math.ceil(bags / BAG_MODEL.bagsPerCart)),
    note: fromPattern
      ? `Projected from the last ${dayLabel(slot.dow)} this flight was on the board. Times and gate may have moved — re-paste today's departure list to refresh.`
      : "From the departure list pasted into the board today.",
  };
}

function dayLabel(dow: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow] ?? "day";
}

export async function scheduleStatus(ref: Date = new Date()): Promise<{
  date: string;
  seededToday: number;
  patternSlots: number;
  message: string;
}> {
  const date = localDate(ref);
  const today = await store.get<SeededSchedule>(KEY_DAY(date));
  const pattern = (await store.get<Record<string, SeededSlot>>(KEY_PATTERN)) ?? {};
  const seededToday = today?.slots.length ?? 0;
  const patternSlots = Object.keys(pattern).length;

  return {
    date,
    seededToday,
    patternSlots,
    message: seededToday
      ? `${seededToday} departures seeded for today from the board's departure list.`
      : patternSlots
        ? `Nothing pasted for today yet — projecting from a stored weekday pattern of ${patternSlots} slots. Paste today's list into the board for real times and gates.`
        : "No schedule yet. Paste today's Delta departure list into the board (Ops Entry → Paste) and the platform will keep it, including gates, and project it forward.",
  };
}
