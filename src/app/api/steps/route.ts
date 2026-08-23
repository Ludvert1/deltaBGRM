/**
 * GET /api/steps — the accountability view.
 *
 * For every flight the board has worked today: each step with its timestamp
 * and the agent who recorded it, the cart-departure deadline that step was
 * judged against, the real off-blocks time from ADS-B, and — where the evidence
 * supports it — which step a late departure is attributable to.
 *
 * ?date=YYYY-MM-DD  read a past day
 * ?flight=DL1242    a single flight
 * ?late=1           only departures that went out late
 */

import { NextRequest, NextResponse } from "next/server";
import { buildFeed } from "@/lib/providers";
import { analyzeAll, summarizeOtd } from "@/lib/steps";
import { store, KEYS } from "@/lib/store";
import { localDate } from "@/lib/time";
import { OpsFlight } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const date = params.get("date") ?? localDate();
  const flightFilter = params.get("flight")?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const lateOnly = params.get("late") === "1";

  const ops = (await store.get<OpsFlight[]>(KEYS.opsDay(date))) ?? [];
  if (ops.length === 0) {
    return NextResponse.json({
      date,
      count: 0,
      flights: [],
      otd: null,
      message:
        "No bag room workflow recorded for this date. The board syncs its step trail to /api/ingest as agents advance each flight — open the board and work a flight to populate this.",
    });
  }

  const feed = await buildFeed({ includeNas: false });
  let analyses = analyzeAll(ops, feed.flights);

  const otd = summarizeOtd(analyses);

  if (flightFilter) {
    analyses = analyses.filter(
      (a) => a.flight.replace(/[^A-Z0-9]/gi, "").toUpperCase() === flightFilter,
    );
  }
  if (lateOnly) {
    analyses = analyses.filter((a) => a.onTime === false);
  }

  return NextResponse.json(
    {
      date,
      count: analyses.length,
      otd,
      flights: analyses,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
