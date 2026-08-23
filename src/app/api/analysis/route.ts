/** GET /api/analysis — the current bag room analysis without generating a report. */

import { NextRequest, NextResponse } from "next/server";
import { buildFeed } from "@/lib/providers";
import { analyze } from "@/lib/analytics";
import { nasHeadline } from "@/lib/providers/faa";
import { store, KEYS } from "@/lib/store";
import { localDate } from "@/lib/time";
import { OpsFlight } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? localDate();
  const feed = await buildFeed();
  const ops = (await store.get<OpsFlight[]>(KEYS.opsDay(date))) ?? [];

  return NextResponse.json(
    {
      date,
      faaHeadline: nasHeadline(feed.nas ?? null),
      degraded: feed.degraded,
      warnings: feed.warnings,
      sources: feed.sources,
      analysis: analyze(feed.flights, feed.nas ?? null, ops),
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
