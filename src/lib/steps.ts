/**
 * Step timing, accountability and fault attribution.
 *
 * The board already stamps every step with an ISO time, the agent's initials
 * and their employee id. This turns that raw trail into the answer the station
 * actually wants after a late departure: *which step ran late, and who owned it.*
 *
 * The chain, and what each step means:
 *
 *   assigned          a lead took the flight
 *   exitScanned       bags scanned out of the bag room
 *   cartOut           the cart train physically left the bag room   ← the pivot
 *   deliveredAtGate   carts parked at plane side
 *   complete          loading finished
 *
 * The pivot is cartOut, because it is the only step with a hard, computable
 * deadline: bags must be at the aircraft by the bag cutoff, and the tow takes a
 * known number of minutes from that pier. So
 *
 *   cart must leave by  =  ETD − cutoffBuffer − transit(pier)
 *
 * Everything upstream is judged against its own target; everything downstream is
 * judged against how long it took. A late departure is attributed to the first
 * step that blew its target by more than the tolerance — first, not worst,
 * because a late exit scan is what makes the cart late, and blaming the cart
 * crew for a delay they inherited is exactly the failure mode this is meant to
 * prevent.
 *
 * Where the evidence will not carry an attribution, it says so instead of
 * guessing. `inconclusive` is a real and common outcome and should stay that way.
 */

import { FlightStepAnalysis, OpsFlight, StepRecord, OtdSummary, FeedFlight } from "./types";
import { BAG_MODEL, STEP_TARGETS, cartTransitFor, pierFromGate, PIER_TO_LEAD } from "./config";
import { parseBoardTime, formatBoardTime } from "./analytics-time";
import { localParts, toLocalTime } from "./time";

/** A step counts as late once it misses its target by more than this. */
const TOLERANCE_MINUTES = 3;

/** A departure counts as late at or beyond this many minutes past schedule. */
export const LATE_DEPARTURE_MINUTES = 1;

/** Owner field on the flight record for each step. */
const OWNER_FIELD: Record<string, keyof OpsFlight> = {
  assigned: "teamLead",
  exitScanned: "exitScanAgent",
  cartOut: "bagroomAgent",
  deliveredAtGate: "deliveryAgent",
  complete: "teamLead",
};

/** Minutes before ETD that carts must roll out of the bag room. */
export function cartOutTargetMinutes(pier?: string | null): number {
  return BAG_MODEL.cutoffBufferMinutes + cartTransitFor(pier);
}

function targetFor(status: string, pier?: string | null): number {
  if (status === "cartOut") return cartOutTargetMinutes(pier);
  return STEP_TARGETS.find((s) => s.status === status)?.minutesBeforeEtd ?? 0;
}

/** Minutes-after-midnight of an ISO timestamp, in station local time. */
function localMinuteOf(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return localParts(d).minuteOfDay;
}

/**
 * Difference in minutes accounting for the clock wrapping past midnight.
 * A 11:50 PM departure with a 12:05 AM step is 15 minutes apart, not 1,425.
 */
function wrapDiff(a: number, b: number): number {
  let d = a - b;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

export function analyzeFlightSteps(
  f: OpsFlight,
  live?: FeedFlight,
): FlightStepAnalysis {
  const pier = (f.pierSide || pierFromGate(f.gate) || "").toUpperCase();
  const transit = cartTransitFor(pier);
  const etdMinute = parseBoardTime(f.eta || f.sched);
  const schedMinute = parseBoardTime(f.sched);

  const history = Array.isArray(f.statusHistory) ? f.statusHistory : [];
  const firstOf = (status: string) =>
    history.find((h) => h.status === status) ?? null;

  let previousMinute: number | null = null;

  const steps: StepRecord[] = STEP_TARGETS.map((def) => {
    const hit = firstOf(def.status);
    const target = targetFor(def.status, pier);

    if (!hit) {
      return {
        status: def.status,
        label: def.label,
        at: null,
        atLocal: "",
        by: String(f[OWNER_FIELD[def.status]] ?? ""),
        empId: "",
        minutesBeforeEtd: null,
        targetMinutesBeforeEtd: target,
        varianceMinutes: null,
        durationFromPreviousMinutes: null,
        late: false,
        missing: true,
      };
    }

    const stepMinute = localMinuteOf(hit.at);
    const minutesBeforeEtd =
      stepMinute !== null && etdMinute !== null ? wrapDiff(etdMinute, stepMinute) : null;
    const variance = minutesBeforeEtd !== null ? minutesBeforeEtd - target : null;
    const duration =
      stepMinute !== null && previousMinute !== null ? wrapDiff(stepMinute, previousMinute) : null;
    if (stepMinute !== null) previousMinute = stepMinute;

    return {
      status: def.status,
      label: def.label,
      at: hit.at,
      atLocal: toLocalTime(hit.at),
      by: (hit.by || String(f[OWNER_FIELD[def.status]] ?? "")).toUpperCase(),
      empId: String(hit.empId ?? ""),
      minutesBeforeEtd,
      targetMinutesBeforeEtd: target,
      varianceMinutes: variance,
      late: variance !== null && variance < -TOLERANCE_MINUTES,
      missing: false,
      durationFromPreviousMinutes: duration,
    };
  });

  // The board also writes cartOutActual directly, which survives even if the
  // status history was trimmed. Use it when the history has no cartOut entry.
  const cartStep = steps.find((s) => s.status === "cartOut")!;
  if (cartStep.missing && f.cartOutActual) {
    const m = parseBoardTime(f.cartOutActual);
    if (m !== null && etdMinute !== null) {
      cartStep.missing = false;
      cartStep.atLocal = f.cartOutActual;
      cartStep.minutesBeforeEtd = wrapDiff(etdMinute, m);
      cartStep.varianceMinutes = cartStep.minutesBeforeEtd - cartStep.targetMinutesBeforeEtd;
      cartStep.late = cartStep.varianceMinutes < -TOLERANCE_MINUTES;
    }
  }

  /* —— actual departure, from ADS-B ——
     On-time performance is measured only where the scheduled time came from a
     real schedule: a pasted departure list or AeroAPI. A time the platform
     inferred from the aircraft's own movement would score every flight as
     perfectly on time, which is worse than reporting nothing. */
  const actualIso = live?.actual_out ?? null;
  const actualMinute = actualIso ? localMinuteOf(actualIso) : null;
  const scheduleIsTrustworthy =
    !live || live.schedSource === undefined || live.schedSource === "seed" || live.schedSource === "aeroapi";
  const departureDelay =
    actualMinute !== null && schedMinute !== null && scheduleIsTrustworthy
      ? wrapDiff(actualMinute, schedMinute)
      : null;
  const onTime = departureDelay === null ? null : departureDelay < LATE_DEPARTURE_MINUTES;

  const cartDepartByLocal =
    etdMinute !== null ? formatBoardTime(etdMinute - cartOutTargetMinutes(pier)) : "";

  const analysis: FlightStepAnalysis = {
    flight: f.flight,
    destination: String(f.dest ?? ""),
    gate: String(f.gate ?? ""),
    pier,
    teamLead: String(f.teamLead ?? (pier ? PIER_TO_LEAD[pier] : "") ?? ""),
    scheduledLocal: String(f.sched ?? ""),
    etdLocal: String(f.eta || f.sched || ""),
    cartDepartByLocal,
    cartTransitMinutes: transit,
    steps,
    actualDepartureLocal: actualIso ? toLocalTime(actualIso) : null,
    departureDelayMinutes: departureDelay,
    onTime,
    fault: null,
    inconclusive: null,
  };

  attribute(analysis, f);
  return analysis;
}

/** Decide what, if anything, the record can fairly be said to show. */
function attribute(a: FlightStepAnalysis, f: OpsFlight): void {
  if (f.status === "canceled") {
    a.inconclusive = "Flight cancelled — no departure to attribute.";
    return;
  }
  if (a.departureDelayMinutes === null) {
    a.inconclusive = a.actualDepartureLocal
      ? `Departed ${a.actualDepartureLocal}, but there is no published scheduled time to measure it against — this flight was not on a pasted departure list. On-time performance needs a real schedule; paste the day's list into the board, or set AEROAPI_KEY.`
      : "No confirmed off-blocks time yet. ADS-B reports a departure only once the aircraft is rolling, so this fills in shortly after pushback.";
    return;
  }
  if (a.onTime) return; // nothing to attribute

  const recorded = a.steps.filter((s) => !s.missing);
  if (recorded.length === 0) {
    a.inconclusive = `Departed ${a.departureDelayMinutes} min late, but no bag room steps were recorded for this flight — nothing to attribute.`;
    return;
  }

  // First step to blow its target, not the worst one: a late exit scan is what
  // makes the cart late, and the cart crew should not carry an inherited delay.
  const firstLate = a.steps.find((s) => !s.missing && s.late);

  if (!firstLate) {
    const missingCritical = a.steps.filter((s) => s.missing && s.status !== "complete");
    if (missingCritical.length > 0) {
      a.inconclusive = `Departed ${a.departureDelayMinutes} min late. Every recorded step met its target, but ${missingCritical
        .map((s) => s.label)
        .join(", ")} ${missingCritical.length === 1 ? "was" : "were"} never logged, so the chain cannot be cleared or blamed.`;
      return;
    }
    a.inconclusive = `Departed ${a.departureDelayMinutes} min late with every bag room step inside target${
      f.delayReason ? ` — recorded delay reason: ${f.delayReason}` : ""
    }. The delay does not appear to originate in the bag room.`;
    return;
  }

  const owner = firstLate.by || String(f[OWNER_FIELD[firstLate.status]] ?? "") || "unassigned";
  const lateBy = Math.abs(firstLate.varianceMinutes ?? 0);

  const detail =
    firstLate.status === "cartOut"
      ? `Carts had to leave the bag room by ${a.cartDepartByLocal} to make the ${BAG_MODEL.cutoffBufferMinutes}-minute cutoff with ${a.cartTransitMinutes} minutes of tow time from pier ${a.pier || "?"}. They left at ${firstLate.atLocal} — ${lateBy} min late.`
      : `${firstLate.label} was due ${firstLate.targetMinutesBeforeEtd} min before departure and was recorded at ${firstLate.atLocal}, ${lateBy} min behind target.`;

  a.fault = {
    step: firstLate.status,
    label: firstLate.label,
    owner,
    lateByMinutes: lateBy,
    explanation: `${detail} Departure went ${a.departureDelayMinutes} min late.`,
  };
}

/* ————————————————————————— roll-up ————————————————————————— */

export function summarizeOtd(analyses: FlightStepAnalysis[]): OtdSummary {
  const measured = analyses.filter((a) => a.departureDelayMinutes !== null);
  const late = measured.filter((a) => a.onTime === false);
  const delays = measured
    .map((a) => a.departureDelayMinutes)
    .filter((d): d is number => d !== null);

  const attributable = late.filter((a) => a.fault !== null);
  const cleared = late.filter((a) => a.fault === null && a.inconclusive?.includes("does not appear"));
  const inconclusive = late.length - attributable.length - cleared.length;

  const stepCounts = new Map<string, { label: string; count: number; owner: string }>();
  for (const a of attributable) {
    const f = a.fault!;
    const rec = stepCounts.get(f.step) ?? {
      label: f.label,
      count: 0,
      owner: STEP_TARGETS.find((s) => s.status === f.step)?.owner ?? "",
    };
    rec.count++;
    stepCounts.set(f.step, rec);
  }

  const people = new Map<
    string,
    { initials: string; empId: string; steps: number; lateSteps: number; faultedDepartures: number }
  >();
  const touch = (initials: string, empId: string) => {
    const key = initials.toUpperCase();
    if (!key) return null;
    if (!people.has(key)) {
      people.set(key, { initials: key, empId, steps: 0, lateSteps: 0, faultedDepartures: 0 });
    }
    const rec = people.get(key)!;
    if (empId && !rec.empId) rec.empId = empId;
    return rec;
  };

  for (const a of analyses) {
    for (const s of a.steps) {
      if (s.missing || !s.by) continue;
      const rec = touch(s.by, s.empId);
      if (!rec) continue;
      rec.steps++;
      if (s.late) rec.lateSteps++;
    }
    if (a.fault) {
      const rec = touch(a.fault.owner, "");
      if (rec) rec.faultedDepartures++;
    }
  }

  return {
    measured: measured.length,
    onTime: measured.length - late.length,
    late: late.length,
    percent: measured.length
      ? Math.round(((measured.length - late.length) / measured.length) * 100)
      : null,
    averageDelayMinutes: delays.length
      ? Math.round((delays.reduce((s, d) => s + d, 0) / delays.length) * 10) / 10
      : null,
    bagRoomAttributable: attributable.length,
    notBagRoom: cleared.length,
    inconclusive,
    byStep: [...stepCounts.entries()]
      .map(([step, v]) => ({ step, ...v }))
      .sort((a, b) => b.count - a.count),
    byEmployee: [...people.values()].sort(
      (a, b) => b.faultedDepartures - a.faultedDepartures || b.lateSteps - a.lateSteps,
    ),
  };
}

/** Match the board's rows to live feed rows so ADS-B actuals reach the analysis. */
export function analyzeAll(ops: OpsFlight[], live: FeedFlight[]): FlightStepAnalysis[] {
  const key = (s: string) => s.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const byFlight = new Map(live.map((f) => [key(f.flight), f]));
  return ops.map((f) => analyzeFlightSteps(f, byFlight.get(key(f.flight))));
}
