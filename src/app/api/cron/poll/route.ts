/**
 * GET /api/cron/poll — the heartbeat.
 *
 * Every run: pulls observed departures from OpenSky, folds them into the
 * learned schedule, records which callsigns have operated today, fetches the
 * FAA picture, and stores a snapshot. The snapshots are what the daily report
 * and the timeline are built from.
 *
 * Wired to Vercel Cron in vercel.json. Also safe to hit by hand.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorized } from "@/lib/auth";
import { fetchDepartures, fetchArrivals, isDeltaSystem } from "@/lib/providers/opensky";
import { fetchNasStatus } from "@/lib/providers/faa";
import { buildFeed } from "@/lib/providers";
import { loadBaseline, saveBaseline, learn, recordObserved, baselineMaturity } from "@/lib/baseline";
import { store, KEYS } from "@/lib/store";
import { POLL } from "@/lib/config";
import { NasSummary, Snapshot } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const errors: string[] = [];

  /* —— observed departures → learned schedule —— */
  let learned = 0;
  try {
    const departures = await fetchDepartures(POLL.windowSeconds);
    const delta = departures.filter((d) => isDeltaSystem(d.callsign, d.estArrivalAirport));
    learned = delta.length;

    const baseline = learn(await loadBaseline(), delta);
    await saveBaseline(baseline);
    await recordObserved(delta);
  } catch (e) {
    errors.push(`departures: ${e instanceof Error ? e.message : e}`);
  }

  /* —— arrivals: the aircraft that become the next departure bank ——
     Off by default. Every OpenSky query spends a credit, and anonymous access
     only has 400 a day — a five-minute poll of departures alone is already 288.
     Turn this on once OAuth2 credentials are set: POLL_ARRIVALS=1. */
  let inbound: number | null = null;
  if (process.env.POLL_ARRIVALS === "1") {
    try {
      const arrivals = await fetchArrivals(POLL.windowSeconds);
      inbound = arrivals.filter((a) => isDeltaSystem(a.callsign, a.estDepartureAirport)).length;
    } catch (e) {
      errors.push(`arrivals: ${e instanceof Error ? e.message : e}`);
    }
  }

  /* —— FAA —— */
  let nas: NasSummary | null = null;
  try {
    nas = await fetchNasStatus();
  } catch (e) {
    errors.push(`faa: ${e instanceof Error ? e.message : e}`);
  }

  /* —— snapshot —— */
  const feed = await buildFeed({ includeNas: false });
  const snapshot: Snapshot = {
    at: new Date().toISOString(),
    flights: feed.flights,
    nas,
    counts: {
      total: feed.flights.length,
      departed: feed.flights.filter((f) => f.status === "Departed").length,
      delayed: feed.flights.filter((f) => f.status === "Delayed").length,
      cancelled: feed.flights.filter((f) => f.cancelled).length,
      suspected: feed.flights.filter((f) => f.status === "Suspected Cancel").length,
    },
  };
  await store.listPush(KEYS.snapshots, snapshot, POLL.retainSnapshots);
  await store.set(KEYS.lastPoll, snapshot.at);

  return NextResponse.json({
    ok: errors.length === 0,
    at: snapshot.at,
    elapsedMs: Date.now() - started,
    observedDeltaDepartures: learned,
    observedDeltaArrivals: inbound,
    arrivalsPolling: process.env.POLL_ARRIVALS === "1",
    counts: snapshot.counts,
    baseline: baselineMaturity(await loadBaseline()),
    errors,
  });
}
