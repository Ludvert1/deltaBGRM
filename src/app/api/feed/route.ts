/**
 * GET /api/feed
 *
 * The board-facing live feed. Field names match exactly what the Bag Room
 * board's fetchLiveFeed() reads, so the board needs no modification — point its
 * "Live Data Feed URL" at this route and it works.
 *
 * CORS is open because the board may be served from another host
 * (rporteam.com, a TV kiosk, a phone). The payload is public flight data.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildFeed } from "@/lib/providers";
import { POLL } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS });
}

export async function GET(req: NextRequest) {
  const verbose = req.nextUrl.searchParams.get("verbose") === "1";
  try {
    const feed = await buildFeed();

    // The board only needs the flight rows; diagnostics are opt-in so the
    // payload stays small on a 120-second refresh across many devices.
    const body = verbose
      ? feed
      : {
          airport: feed.airport,
          timezone: feed.timezone,
          generated_at: feed.generated_at,
          generated_at_local: feed.generated_at_local,
          count: feed.count,
          scheduled_departures: feed.scheduled_departures,
          flights: feed.flights,
          degraded: feed.degraded,
          warnings: feed.warnings,
        };

    return NextResponse.json(body, {
      headers: {
        ...CORS,
        "Cache-Control": `public, s-maxage=${POLL.feedCacheSeconds}, stale-while-revalidate=120`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), flights: [], scheduled_departures: [] },
      { status: 502, headers: CORS },
    );
  }
}
