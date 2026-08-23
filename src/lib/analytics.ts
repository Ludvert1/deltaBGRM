/**
 * Bag room analytics.
 *
 * Two inputs, deliberately kept separate:
 *   • the live feed — what the airline is doing (schedule, delays, cancels)
 *   • the ops ingest — what the bag room did about it (exit scan, cart out,
 *     delivery, missing bags), pushed up from the board
 *
 * Everything derived from the second is real measured performance. Everything
 * derived from the first, in OpenSky-only mode, carries the inference caveat.
 */

import { FeedFlight, NasSummary, OpsFlight } from "./types";
import { BAG_MODEL, PIER_TO_LEAD, STATION, pierFromGate, cartTransitFor } from "./config";
import { localParts, minutesBetween } from "./time";
import { parseBoardTime } from "./analytics-time";

export interface PierLoad {
  pier: string;
  lead: string;
  departures: number;
  bags: number;
  carts: number;
  peakWindow: string | null;
  peakConcurrent: number;
  congested: boolean;
}

export interface DisruptionExposure {
  flight: string;
  destination: string;
  etd: string;
  reason: string;
  kind: string;
  bagsAtRisk: number;
}

export interface BagRoomAnalysis {
  generatedAt: string;
  station: string;
  totals: {
    departures: number;
    departed: number;
    scheduled: number;
    delayed: number;
    cancelled: number;
    suspectedCancel: number;
    estimatedBags: number;
    estimatedCarts: number;
  };
  piers: PierLoad[];
  /** Flights heading to an airport under an FAA program. */
  exposure: DisruptionExposure[];
  /** Work created by cancellations: bags to strip back off carts. */
  recovery: {
    flights: number;
    bags: number;
    laborMinutes: number;
    note: string;
  };
  ops: OpsPerformance | null;
  confidence: {
    /** Share of rows backed by an authoritative source rather than inference. */
    authoritativeShare: number;
    note: string;
  };
}

export interface OpsPerformance {
  tracked: number;
  cartOutRecorded: number;
  onTimeCartOut: number;
  otpPercent: number | null;
  avgVarianceMinutes: number | null;
  lateCartOut: number;
  missingBags: number;
  reroutes: number;
  completed: number;
  byLead: { lead: string; flights: number; completed: number; missingBags: number }[];
  worstVariances: { flight: string; varianceMinutes: number; lead: string }[];
}

const ACTIVE = (f: FeedFlight) => !f.cancelled && f.status !== "Suspected Cancel";

export function analyze(
  flights: FeedFlight[],
  nas: NasSummary | null,
  ops: OpsFlight[] = [],
): BagRoomAnalysis {
  const departed = flights.filter((f) => f.status === "Departed").length;
  const delayed = flights.filter((f) => f.status === "Delayed").length;
  const cancelled = flights.filter((f) => f.cancelled).length;
  const suspected = flights.filter((f) => f.status === "Suspected Cancel").length;

  const active = flights.filter(ACTIVE);
  const estimatedBags = active.reduce((s, f) => s + (f.bagEstimate ?? 0), 0);
  const estimatedCarts = active.reduce((s, f) => s + (f.cartEstimate ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    station: STATION.iata,
    totals: {
      departures: flights.length,
      departed,
      scheduled: flights.filter((f) => f.status === "Scheduled").length,
      delayed,
      cancelled,
      suspectedCancel: suspected,
      estimatedBags,
      estimatedCarts,
    },
    piers: pierLoads(active),
    exposure: exposure(flights, nas),
    recovery: recovery(flights),
    ops: ops.length ? opsPerformance(ops) : null,
    confidence: confidence(flights),
  };
}

/** Per-pier workload plus the busiest concurrent window on that pier. */
export function pierLoads(flights: FeedFlight[]): PierLoad[] {
  const piers = ["A", "B", "C", "D"];
  return piers.map((pier) => {
    const rows = flights.filter((f) => f.pier === pier);
    const times = rows
      .map((f) => f.estimated_out || f.scheduled_out)
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime())
      .sort((a, b) => a - b);

    let peakConcurrent = 0;
    let peakAt: number | null = null;
    const win = BAG_MODEL.congestionWindowMinutes * 60_000;
    for (const t of times) {
      const n = times.filter((o) => o >= t && o < t + win).length;
      if (n > peakConcurrent) {
        peakConcurrent = n;
        peakAt = t;
      }
    }

    return {
      pier,
      lead: PIER_TO_LEAD[pier] ?? "",
      departures: rows.length,
      bags: rows.reduce((s, f) => s + (f.bagEstimate ?? 0), 0),
      carts: rows.reduce((s, f) => s + (f.cartEstimate ?? 0), 0),
      peakWindow: peakAt
        ? new Intl.DateTimeFormat("en-US", {
            timeZone: STATION.timezone,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }).format(new Date(peakAt))
        : null,
      peakConcurrent,
      congested: peakConcurrent >= BAG_MODEL.pierCongestionThreshold,
    };
  });
}

/**
 * Departures aimed at an airport currently under an FAA program.
 * These are the bags most likely to end up back in the bag room.
 */
export function exposure(flights: FeedFlight[], nas: NasSummary | null): DisruptionExposure[] {
  if (!nas) return [];
  const byAirport = new Map<string, { kind: string; reason: string }>();
  for (const p of [...nas.local, ...nas.network]) {
    // Keep the most severe program per airport.
    const rank = (k: string) => (k === "Closure" ? 4 : k === "Ground Stop" ? 3 : k === "Ground Delay" ? 2 : 1);
    const prev = byAirport.get(p.airport);
    if (!prev || rank(p.kind) > rank(prev.kind)) {
      byAirport.set(p.airport, { kind: p.kind, reason: p.reason });
    }
  }

  return flights
    .filter(ACTIVE)
    .filter((f) => f.status !== "Departed" && byAirport.has(f.destination))
    .map((f) => {
      const p = byAirport.get(f.destination)!;
      return {
        flight: f.flight,
        destination: f.destination,
        etd: f.etd_local || f.etd_sched_local,
        kind: p.kind,
        reason: p.reason,
        bagsAtRisk: f.bagEstimate ?? 0,
      };
    })
    .sort((a, b) => b.bagsAtRisk - a.bagsAtRisk);
}

/** Labour created by cancellations — bags already carted that must come back. */
export function recovery(flights: FeedFlight[]): BagRoomAnalysis["recovery"] {
  const hard = flights.filter((f) => f.cancelled);
  const soft = flights.filter((f) => f.status === "Suspected Cancel");
  const rows = [...hard, ...soft];
  const bags = rows.reduce((s, f) => s + (f.bagEstimate ?? 0), 0);

  return {
    flights: rows.length,
    bags,
    laborMinutes: rows.length * BAG_MODEL.cancellationRecoveryMinutes,
    note: soft.length
      ? `${hard.length} confirmed cancellation${hard.length === 1 ? "" : "s"} and ${soft.length} suspected. Suspected rows are inferred from the learned schedule — confirm before pulling bags.`
      : `${hard.length} confirmed cancellation${hard.length === 1 ? "" : "s"}.`,
  };
}

/** Measured bag room performance from the board's own workflow entries. */
export function opsPerformance(ops: OpsFlight[]): OpsPerformance {
  const active = ops.filter((f) => f.status !== "canceled");
  const withCartOut = active.filter((f) => f.cartOutActual);

  const variances = withCartOut
    .map((f) => ({ f, v: cartOutVariance(f) }))
    .filter((x): x is { f: OpsFlight; v: number } => x.v !== null);

  const onTime = variances.filter((x) => x.v >= 0).length;
  const avg =
    variances.length > 0
      ? Math.round((variances.reduce((s, x) => s + x.v, 0) / variances.length) * 10) / 10
      : null;

  const leads = new Map<string, { flights: number; completed: number; missingBags: number }>();
  for (const f of active) {
    const lead = f.teamLead || "—";
    const rec = leads.get(lead) ?? { flights: 0, completed: 0, missingBags: 0 };
    rec.flights++;
    if (f.status === "complete") rec.completed++;
    rec.missingBags += Number(f.missingBags ?? 0);
    leads.set(lead, rec);
  }

  return {
    tracked: ops.length,
    cartOutRecorded: withCartOut.length,
    onTimeCartOut: onTime,
    otpPercent: withCartOut.length ? Math.round((onTime / withCartOut.length) * 100) : null,
    avgVarianceMinutes: avg,
    lateCartOut: variances.filter((x) => x.v < 0).length,
    missingBags: active.reduce((s, f) => s + Number(f.missingBags ?? 0), 0),
    reroutes: active.filter((f) => (f.rerouteNotes ?? "").trim()).length,
    completed: active.filter((f) => f.status === "complete").length,
    byLead: [...leads.entries()]
      .map(([lead, v]) => ({ lead, ...v }))
      .sort((a, b) => b.flights - a.flights),
    worstVariances: variances
      .filter((x) => x.v < 0)
      .sort((a, b) => a.v - b.v)
      .slice(0, 8)
      .map((x) => ({
        flight: x.f.flight,
        varianceMinutes: x.v,
        lead: x.f.teamLead || "—",
      })),
  };
}

/**
 * Minutes of slack at cart-out: positive means the carts rolled with time in
 * hand, negative means they left too late to make the cutoff.
 *
 * The deadline is ETD − bag cutoff − tow time from that pier, because what
 * matters is when the bags reach the aircraft, not when they leave the room.
 * The board's own computeVariance() is overridden to match, so the KPI on the
 * floor and the KPI in the report are the same number.
 */
export function cartOutVariance(f: OpsFlight): number | null {
  const etd = parseBoardTime(f.eta || f.sched);
  const actual = parseBoardTime(f.cartOutActual);
  if (etd === null || actual === null) return null;
  const pier = (f.pierSide || pierFromGate(f.gate) || "").toUpperCase();
  const mustLeaveBy = etd - BAG_MODEL.cutoffBufferMinutes - cartTransitFor(pier);
  return mustLeaveBy - actual;
}



function confidence(flights: FeedFlight[]): BagRoomAnalysis["confidence"] {
  if (!flights.length) {
    return { authoritativeShare: 0, note: "No flights in the current window." };
  }
  const authoritative = flights.filter((f) => f.source === "aeroapi" || f.source === "opensky").length;
  const share = Math.round((authoritative / flights.length) * 100) / 100;
  return {
    authoritativeShare: share,
    note:
      share === 1
        ? "Every row is backed by an authoritative or observed source."
        : `${Math.round((1 - share) * 100)}% of rows come from the learned schedule and are inference, not reported fact.`,
  };
}

/** Which operating shift a moment falls in, for shift reports. */
export function shiftFor(at: Date = new Date()): "AM" | "PM" | "MID" {
  const { hour } = localParts(at);
  if (hour >= 4 && hour < 13) return "AM";
  if (hour >= 13 && hour < 22) return "PM";
  return "MID";
}

export { minutesBetween, parseBoardTime };
