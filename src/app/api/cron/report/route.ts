/**
 * GET /api/cron/report — automated report generation.
 *
 * Runs on a schedule (see vercel.json): once at each shift change and once at
 * end of day. Builds the report from the day's snapshots plus whatever ops data
 * the board has pushed, stores it, and returns the summary.
 *
 * ?shift=AM|PM|MID|DAY overrides the shift the current time implies.
 * ?date=YYYY-MM-DD regenerates a past day.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorized } from "@/lib/auth";
import { buildFeed } from "@/lib/providers";
import { generateReport, saveReport, shiftFor } from "@/lib/report";
import { localDate } from "@/lib/time";
import type { Report } from "@/lib/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const shiftParam = params.get("shift")?.toUpperCase();
  const shift = (["AM", "PM", "MID", "DAY"].includes(shiftParam ?? "")
    ? shiftParam
    : shiftFor()) as Report["shift"];
  const date = params.get("date") ?? localDate();

  const feed = await buildFeed();
  const report = await generateReport({ date, shift, flights: feed.flights, nas: feed.nas ?? null });
  await saveReport(report);

  return NextResponse.json({
    ok: true,
    id: report.id,
    date: report.date,
    shift: report.shift,
    headline: report.headline,
    faaHeadline: report.faaHeadline,
    totals: report.analysis.totals,
    caveats: report.caveats,
    url: `/api/reports/${report.id}`,
    html: `/api/reports/${report.id}?format=html`,
  });
}
