/** GET /api/nas — live FAA program status affecting AUS and its Delta destinations. */

import { NextResponse } from "next/server";
import { fetchNasStatus, nasHeadline } from "@/lib/providers/faa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const nas = await fetchNasStatus();
    return NextResponse.json(
      { ...nas, headline: nasHeadline(nas) },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
