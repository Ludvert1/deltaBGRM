import Link from "next/link";
import { listReports } from "@/lib/report";
import { STATION } from "@/lib/config";
import { GenerateReportButton } from "@/components/GenerateReportButton";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const ids = await listReports();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8">
      <header className="mb-6">
        <Link href="/" className="text-sm text-[var(--accent)] hover:underline">
          ← Ops platform
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {STATION.iata} Bag Room Reports
        </h1>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Generated automatically at shift change and end of day, and on demand below.
        </p>
      </header>

      <div className="mb-6">
        <GenerateReportButton />
      </div>

      {ids.length === 0 ? (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5 text-sm leading-relaxed text-[var(--dim)]">
          <p className="mb-2 font-medium text-[var(--fg)]">No reports stored yet.</p>
          <p>
            Generate one above, or wait for the scheduled run. If reports keep disappearing, the
            platform is on the in-memory store — attach Vercel KV or Upstash Redis so history
            survives a cold start.
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {ids.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-4 py-3"
            >
              <span className="mono text-sm">{id}</span>
              <span className="flex gap-3 text-sm">
                <a
                  className="text-[var(--accent)] hover:underline"
                  href={`/api/reports/${id}?format=html`}
                >
                  Read
                </a>
                <a className="text-[var(--dim)] hover:underline" href={`/api/reports/${id}`}>
                  JSON
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
