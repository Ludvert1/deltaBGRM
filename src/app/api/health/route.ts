/**
 * GET /api/health — one call that tells you whether the platform is actually
 * working: which sources answered, how mature the learned schedule is, whether
 * storage survives a cold start, and when the poller last ran.
 */

import { NextResponse } from "next/server";
import { buildFeed } from "@/lib/providers";
import { loadBaseline, baselineMaturity } from "@/lib/baseline";
import { store, KEYS, storeDriverName, storeIsDurable } from "@/lib/store";
import { aeroApiEnabled } from "@/lib/providers/aeroapi";
import { STATION } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const feed = await buildFeed();
  const baseline = await loadBaseline();
  const lastPoll = await store.get<string>(KEYS.lastPoll);

  const openskyAuthed = Boolean(
    process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET,
  );

  return NextResponse.json({
    ok: feed.sources.some((s) => s.ok),
    station: { iata: STATION.iata, icao: STATION.icao, timezone: STATION.timezone },
    elapsedMs: Date.now() - started,
    flights: feed.count,
    degraded: feed.degraded,
    warnings: feed.warnings,
    sources: feed.sources,
    baseline: baselineMaturity(baseline),
    storage: {
      driver: storeDriverName(),
      durable: storeIsDurable(),
      note: storeIsDurable()
        ? "History and the learned schedule persist across invocations."
        : "In-memory store: history resets when the serverless instance recycles. Attach Vercel KV or Upstash Redis.",
    },
    config: {
      aeroapi: aeroApiEnabled() ? "configured" : "not configured",
      openskyAuth: openskyAuthed ? "oauth2 (4,000 credits/day)" : "anonymous (400 credits/day)",
      cronSecret: process.env.CRON_SECRET ? "set" : "not set",
    },
    lastPoll: lastPoll ?? null,
  });
}
