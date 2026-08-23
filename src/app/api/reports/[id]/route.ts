/**
 * GET /api/reports/{id}            → the report as JSON
 * GET /api/reports/{id}?format=html → a standalone printable HTML rendering
 *
 * Ids look like "2026-08-23-AM".
 */

import { NextRequest, NextResponse } from "next/server";
import { loadReport } from "@/lib/report";
import { renderReportHtml } from "@/lib/report-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const report = await loadReport(id);

  if (!report) {
    return NextResponse.json(
      { error: `No report stored with id "${id}". Generate one with POST /api/reports.` },
      { status: 404 },
    );
  }

  if (req.nextUrl.searchParams.get("format") === "html") {
    return new NextResponse(renderReportHtml(report), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return NextResponse.json(report);
}
