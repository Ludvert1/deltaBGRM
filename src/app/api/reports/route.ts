/**
 * GET  /api/reports — list stored report ids, newest first.
 * POST /api/reports — generate one now (body: { date?, shift? }).
 */

import { NextRequest, NextResponse } from "next/server";
import { buildFeed } from "@/lib/providers";
import { generateReport, saveReport, listReports, shiftFor } from "@/lib/report";
import { localDate } from "@/lib/time";
import type { Report } from "@/lib/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const ids = await listReports();
  return NextResponse.json({
    count: ids.length,
    reports: ids.map((id) => ({
      id,
      json: `/api/reports/${id}`,
      html: `/api/reports/${id}?format=html`,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: { date?: string; shift?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }

  const shift = (["AM", "PM", "MID", "DAY"].includes((body.shift ?? "").toUpperCase())
    ? body.shift!.toUpperCase()
    : shiftFor()) as Report["shift"];

  const feed = await buildFeed();
  const report = await generateReport({
    date: body.date ?? localDate(),
    shift,
    flights: feed.flights,
    nas: feed.nas ?? null,
  });
  await saveReport(report);

  return NextResponse.json({
    ok: true,
    id: report.id,
    headline: report.headline,
    url: `/api/reports/${report.id}`,
    html: `/api/reports/${report.id}?format=html`,
  });
}
