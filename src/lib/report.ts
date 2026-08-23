/**
 * Automated report generation.
 *
 * A report is built from three things the platform already holds:
 *   • the day's snapshots (what the feed looked like, every poll)
 *   • the day's ops ingest (what the bag room actually did)
 *   • the FAA picture at the time
 *
 * Reports are generated on a schedule by /api/cron/report, and on demand from
 * /api/reports. Each one is stored as structured JSON plus a standalone HTML
 * rendering, so it can be mailed, printed for the shift handover, or diffed.
 */

import { FeedFlight, FlightStepAnalysis, NasSummary, OpsFlight, OtdSummary, Snapshot } from "./types";
import { analyzeAll, summarizeOtd } from "./steps";
import { BagRoomAnalysis, analyze, shiftFor } from "./analytics";
import { nasHeadline } from "./providers/faa";
import { STATION } from "./config";
import { localDate, toLocalTime } from "./time";
import { store, KEYS, storeIsDurable } from "./store";

export interface Report {
  id: string;
  date: string;
  shift: "AM" | "PM" | "MID" | "DAY";
  generatedAt: string;
  generatedAtLocal: string;
  station: string;
  headline: string;
  faaHeadline: string;
  analysis: BagRoomAnalysis;
  timeline: { at: string; label: string; detail: string }[];
  disruptions: FeedFlight[];
  /** Per-flight step trail with timestamps, owners and fault attribution. */
  steps: FlightStepAnalysis[];
  /** On-time departure roll-up measured against ADS-B off-blocks. */
  otd: OtdSummary | null;
  narrative: string[];
  caveats: string[];
  snapshotCount: number;
}

export async function generateReport(opts: {
  date?: string;
  shift?: Report["shift"];
  flights: FeedFlight[];
  nas: NasSummary | null;
}): Promise<Report> {
  const date = opts.date ?? localDate();
  const shift = opts.shift ?? "DAY";

  const snapshots = (await store.listRange<Snapshot>(KEYS.snapshots, -500, -1)).filter((s) =>
    s.at.startsWith(date.slice(0, 4)) ? localDate(new Date(s.at)) === date : false,
  );
  const ops = (await store.get<OpsFlight[]>(KEYS.opsDay(date))) ?? [];

  const analysis = analyze(opts.flights, opts.nas, ops);
  const steps = ops.length ? analyzeAll(ops, opts.flights) : [];
  const otd = steps.length ? summarizeOtd(steps) : null;
  const disruptions = opts.flights.filter(
    (f) => f.cancelled || f.status === "Suspected Cancel" || f.status === "Delayed" || f.diverted,
  );

  const timeline = buildTimeline(snapshots);
  const narrative = buildNarrative(analysis, disruptions, opts.nas, otd, steps);
  const caveats = buildCaveats(analysis, opts.flights, snapshots.length);
  if (otd && otd.inconclusive > 0) {
    caveats.push(
      `${otd.inconclusive} late departure${otd.inconclusive === 1 ? "" : "s"} could not be attributed: either steps went unlogged, or every logged step met its target and the cause lies outside the bag room. Attribution is only as good as the button presses behind it.`,
    );
  }
  if (steps.length === 0) {
    caveats.push(
      "No step trail was available, so nothing in this report speaks to which part of the chain ran late. That data arrives when agents advance flights on the board.",
    );
  }
  const now = new Date();

  return {
    id: `${date}-${shift}`,
    date,
    shift,
    generatedAt: now.toISOString(),
    generatedAtLocal: toLocalTime(now.toISOString(), true),
    station: STATION.iata,
    headline: headline(analysis),
    faaHeadline: nasHeadline(opts.nas),
    analysis,
    timeline,
    disruptions,
    steps,
    otd,
    narrative,
    caveats,
    snapshotCount: snapshots.length,
  };
}

function headline(a: BagRoomAnalysis): string {
  const t = a.totals;
  const disrupted = t.cancelled + t.suspectedCancel + t.delayed;
  if (disrupted === 0) {
    return `${t.departures} Delta departures tracked, no disruption recorded.`;
  }
  const parts: string[] = [];
  if (t.cancelled) parts.push(`${t.cancelled} cancelled`);
  if (t.suspectedCancel) parts.push(`${t.suspectedCancel} suspected cancelled`);
  if (t.delayed) parts.push(`${t.delayed} delayed`);
  return `${t.departures} Delta departures tracked — ${parts.join(", ")}.`;
}

function buildTimeline(snapshots: Snapshot[]): Report["timeline"] {
  const out: Report["timeline"] = [];
  let prev: Snapshot | null = null;
  for (const s of snapshots) {
    if (!prev) {
      out.push({
        at: toLocalTime(s.at),
        label: "First poll of the day",
        detail: `${s.counts.total} flights in window`,
      });
    } else {
      if (s.counts.cancelled > prev.counts.cancelled) {
        out.push({
          at: toLocalTime(s.at),
          label: "Cancellation confirmed",
          detail: `Confirmed cancellations rose to ${s.counts.cancelled}`,
        });
      }
      if (s.counts.suspected > prev.counts.suspected) {
        out.push({
          at: toLocalTime(s.at),
          label: "Suspected cancellation",
          detail: `Learned-schedule slot went unseen; suspected count now ${s.counts.suspected}`,
        });
      }
      if (s.counts.delayed > prev.counts.delayed + 2) {
        out.push({
          at: toLocalTime(s.at),
          label: "Delay cluster",
          detail: `Delayed departures jumped to ${s.counts.delayed}`,
        });
      }
    }
    prev = s;
  }
  return out.slice(-40);
}

function buildNarrative(
  a: BagRoomAnalysis,
  disruptions: FeedFlight[],
  nas: NasSummary | null,
  otd: OtdSummary | null,
  steps: FlightStepAnalysis[],
): string[] {
  const lines: string[] = [];
  const t = a.totals;

  lines.push(
    `${t.departures} Delta-system departures were tracked off ${STATION.iata}: ${t.departed} confirmed airborne, ${t.scheduled} still to go, ${t.delayed} running late.`,
  );

  lines.push(
    `Estimated outbound workload was ${t.estimatedBags.toLocaleString()} checked bags across roughly ${t.estimatedCarts} carts.`,
  );

  const busiest = [...a.piers].sort((x, y) => y.departures - x.departures)[0];
  if (busiest && busiest.departures > 0) {
    lines.push(
      `Pier ${busiest.pier} (${busiest.lead}) carried the heaviest load with ${busiest.departures} departure${busiest.departures === 1 ? "" : "s"} and about ${busiest.bags.toLocaleString()} bags${
        busiest.peakWindow && busiest.peakConcurrent > 1
          ? `, peaking at ${busiest.peakWindow} with ${busiest.peakConcurrent} departures inside 20 minutes`
          : ""
      }.`,
    );
  }

  const congested = a.piers.filter((p) => p.congested);
  if (congested.length) {
    lines.push(
      `Congestion threshold was crossed on pier${congested.length === 1 ? "" : "s"} ${congested
        .map((p) => p.pier)
        .join(", ")} — worth a staffing look for the same bank tomorrow.`,
    );
  }

  if (a.recovery.flights > 0) {
    lines.push(
      `Cancellations generated an estimated ${a.recovery.bags.toLocaleString()} bags of recovery work, roughly ${a.recovery.laborMinutes} agent-minutes. ${a.recovery.note}`,
    );
  }

  if (a.exposure.length) {
    const top = a.exposure.slice(0, 3);
    lines.push(
      `FAA programs put ${a.exposure.length} departure${a.exposure.length === 1 ? "" : "s"} at risk, led by ${top
        .map((e) => `${e.flight} to ${e.destination} (${e.kind}: ${e.reason})`)
        .join("; ")}.`,
    );
  } else if (nas) {
    const programs = nas.local.length + nas.network.length;
    lines.push(
      programs === 0
        ? "No FAA program touched AUS or its Delta destinations during the period."
        : `${programs} FAA program${programs === 1 ? "" : "s"} were active on the Delta network (${[...nas.local, ...nas.network]
            .slice(0, 3)
            .map((p) => `${p.airport} ${p.kind}`)
            .join(", ")}), but no departure still to go was routed to an affected airport.`,
    );
  }

  if (a.ops) {
    const o = a.ops;
    lines.push(
      `The board recorded workflow on ${o.tracked} flight${o.tracked === 1 ? "" : "s"}. Cart-out was logged on ${o.cartOutRecorded}${
        o.otpPercent !== null ? `, ${o.otpPercent}% of them ahead of the bag cutoff` : ""
      }${o.avgVarianceMinutes !== null ? `, averaging ${o.avgVarianceMinutes} minutes of slack` : ""}.`,
    );
    if (o.missingBags > 0) {
      lines.push(`${o.missingBags} missing-bag event${o.missingBags === 1 ? "" : "s"} were logged.`);
    }
    if (o.worstVariances.length) {
      lines.push(
        `Tightest cart-outs: ${o.worstVariances
          .slice(0, 3)
          .map((w) => `${w.flight} (${w.varianceMinutes} min, ${w.lead})`)
          .join(", ")}.`,
      );
    }
  } else {
    lines.push(
      "No bag room workflow data was received for this period — the board has not pushed ops data to /api/ingest, so cart-out performance and missing-bag counts are absent from this report.",
    );
  }

  if (otd && otd.measured > 0) {
    lines.push(
      `On-time departure: ${otd.percent}% — ${otd.onTime} of ${otd.measured} measured departure${otd.measured === 1 ? "" : "s"} left within a minute of schedule${
        otd.averageDelayMinutes !== null ? `, averaging ${otd.averageDelayMinutes} min against the clock` : ""
      }.`,
    );
    if (otd.late > 0) {
      lines.push(
        `Of ${otd.late} late departure${otd.late === 1 ? "" : "s"}, ${otd.bagRoomAttributable} ${otd.bagRoomAttributable === 1 ? "traces" : "trace"} to a bag room step that missed its target, ${otd.notBagRoom} had a clean bag chain, and ${otd.inconclusive} cannot be attributed either way from the record.`,
      );
    }
    if (otd.byStep.length) {
      lines.push(
        `The steps that cost departures: ${otd.byStep
          .map((s) => `${s.label} (${s.count})`)
          .join(", ")}.`,
      );
    }
    const faults = steps.filter((s) => s.fault);
    if (faults.length) {
      lines.push(
        `Specifics: ${faults
          .slice(0, 4)
          .map(
            (s) =>
              `${s.flight} — ${s.fault!.label} ${s.fault!.lateByMinutes} min late (${s.fault!.owner}), departure ${s.departureDelayMinutes} min late`,
          )
          .join("; ")}${faults.length > 4 ? `, and ${faults.length - 4} more` : ""}.`,
      );
    }
  }

  if (disruptions.length) {
    lines.push(
      `Disrupted flights this period: ${disruptions
        .slice(0, 10)
        .map((f) => `${f.flight} → ${f.destination || "?"} (${f.status})`)
        .join(", ")}${disruptions.length > 10 ? `, and ${disruptions.length - 10} more` : ""}.`,
    );
  }

  return lines;
}

function buildCaveats(a: BagRoomAnalysis, flights: FeedFlight[], snapshots: number): string[] {
  const caveats: string[] = [];
  const inferred = flights.filter((f) => f.source === "baseline").length;

  if (inferred > 0) {
    caveats.push(
      `${inferred} of ${flights.length} rows come from the learned schedule rather than a published one. Their times are historical averages and any "Suspected Cancel" is an inference from an unseen ADS-B departure — verify on delta.com before acting.`,
    );
  }
  if (a.confidence.authoritativeShare < 1) caveats.push(a.confidence.note);
  if (!a.ops) {
    caveats.push(
      "Bag room performance figures are absent: no ops data was ingested. Enable the board's platform sync to include cart-out timing, missing bags and lead performance.",
    );
  }
  if (snapshots === 0) {
    caveats.push(
      "No poll snapshots were stored for this period, so there is no timeline of how the day developed — only its end state. The poller writes one snapshot per run; see the scheduling notes in the README.",
    );
  } else if (snapshots < 12) {
    caveats.push(
      `Only ${snapshots} poll snapshot${snapshots === 1 ? " exists" : "s exist"} for this period, so the timeline is sparse. The poller should be running every few minutes — see the scheduling notes in the README.`,
    );
  }
  if (!storeIsDurable()) {
    caveats.push(
      "The platform is running on the in-memory store. History and the learned schedule reset whenever the serverless instance recycles — attach Vercel KV or Upstash Redis for durable reporting.",
    );
  }
  caveats.push(
    "Bag and cart figures are modelled from seat counts and an assumed load factor, not from live BSM/BPM data. They size the work; they are not a bag count.",
  );
  return caveats;
}

export async function saveReport(report: Report): Promise<void> {
  await store.set(KEYS.report(report.id), report);
  const index = (await store.get<string[]>(KEYS.reportIndex)) ?? [];
  if (!index.includes(report.id)) {
    index.push(report.id);
    await store.set(KEYS.reportIndex, index.sort().slice(-180));
  }
}

export async function listReports(): Promise<string[]> {
  return ((await store.get<string[]>(KEYS.reportIndex)) ?? []).slice().reverse();
}

export async function loadReport(id: string): Promise<Report | null> {
  return store.get<Report>(KEYS.report(id));
}

export { shiftFor };
