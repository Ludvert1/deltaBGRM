/**
 * POST /api/ingest — the board pushes its workflow state up here.
 *
 * Everything the bag room actually does (exit scan, cart out, delivery at gate,
 * missing bags, reroutes) lives in the board's localStorage on one device. Until
 * it reaches the server, reports can describe the airline's day but not the bag
 * room's. This route closes that gap.
 *
 * Merges by flight number for the local day, last write wins per flight, so
 * several devices can post without clobbering each other's rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorized } from "@/lib/auth";
import { store, KEYS } from "@/lib/store";
import { localDate } from "@/lib/time";
import { OpsFlight, OpsIngest } from "@/lib/types";
import { opsPerformance } from "@/lib/analytics";
import { seedFromOps } from "@/lib/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cron-Secret",
};

export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS });
}

function key(f: OpsFlight): string {
  return String(f.flight ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  let body: OpsIngest;
  try {
    body = (await req.json()) as OpsIngest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400, headers: CORS });
  }

  const incoming = Array.isArray(body?.flights) ? body.flights : [];
  if (!incoming.length) {
    return NextResponse.json(
      { error: "body.flights must be a non-empty array" },
      { status: 400, headers: CORS },
    );
  }

  const date = localDate();
  const existing = (await store.get<OpsFlight[]>(KEYS.opsDay(date))) ?? [];

  const merged = new Map<string, OpsFlight>();
  for (const f of existing) merged.set(key(f), f);
  for (const f of incoming) {
    const k = key(f);
    if (!k) continue;
    merged.set(k, { ...merged.get(k), ...f });
  }

  const rows = [...merged.values()];
  await store.set(KEYS.opsDay(date), rows);

  // The same payload carries the schedule half of each row — flight number,
  // scheduled time, gate, destination, equipment. Keeping it is what gives the
  // platform a forward schedule without a paid API key.
  const seeded = await seedFromOps(rows);

  return NextResponse.json(
    {
      ok: true,
      date,
      received: incoming.length,
      stored: rows.length,
      device: body.device ?? null,
      schedule: seeded,
      performance: opsPerformance(rows),
    },
    { headers: CORS },
  );
}

/** GET /api/ingest?date=YYYY-MM-DD — read back what has been ingested. */
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? localDate();
  const rows = (await store.get<OpsFlight[]>(KEYS.opsDay(date))) ?? [];
  return NextResponse.json(
    { date, count: rows.length, flights: rows, performance: rows.length ? opsPerformance(rows) : null },
    { headers: CORS },
  );
}
