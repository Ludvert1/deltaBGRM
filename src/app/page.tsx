/**
 * Platform console.
 *
 * Not the bag room board — that lives at /board and is the team-facing screen.
 * This page is for whoever owns the deployment: is the feed alive, which
 * sources answered, how mature is the learned schedule, what is the FAA doing,
 * and what does the current bag room picture look like.
 */

import { buildFeed } from "@/lib/providers";
import { loadBaseline, baselineMaturity } from "@/lib/baseline";
import { analyze } from "@/lib/analytics";
import { nasHeadline } from "@/lib/providers/faa";
import { storeDriverName, storeIsDurable, store, KEYS } from "@/lib/store";
import { STATION } from "@/lib/config";
import { localDate } from "@/lib/time";
import { OpsFlight } from "@/lib/types";
import { FeedUrlBox } from "@/components/FeedUrlBox";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STATUS_TONE: Record<string, string> = {
  Departed: "text-[var(--green)]",
  Delayed: "text-[var(--amber)]",
  Canceled: "text-[var(--red)]",
  "Suspected Cancel": "text-[var(--amber)]",
  Diverted: "text-[var(--red)]",
  Scheduled: "text-[var(--dim)]",
};

function Panel({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--dim)]">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-[var(--line)] px-4 py-3">
      <div className={`text-2xl font-semibold tracking-tight ${tone ?? ""}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.07em] text-[var(--dim)]">{label}</div>
    </div>
  );
}

export default async function Console() {
  const feed = await buildFeed();
  const baseline = await loadBaseline();
  const maturity = baselineMaturity(baseline);
  const ops = (await store.get<OpsFlight[]>(KEYS.opsDay(localDate()))) ?? [];
  const analysis = analyze(feed.flights, feed.nas ?? null, ops);
  const lastPoll = await store.get<string>(KEYS.lastPoll);
  const t = analysis.totals;

  const upcoming = feed.flights.filter((f) => f.status !== "Departed").slice(0, 14);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">
      <header className="mb-7">
        <h1 className="text-2xl font-semibold tracking-tight">
          {STATION.iata} Delta Bag Room — Ops Platform
        </h1>
        <p className="mt-1 text-sm text-[var(--dim)]">
          {STATION.name} · {STATION.timezone} · feed generated {feed.generated_at_local}
        </p>
      </header>

      {feed.warnings.length > 0 && (
        <div className="mb-6 rounded-xl border border-[var(--amber)] p-4 text-sm leading-relaxed">
          <div className="mb-1 font-semibold text-[var(--amber)]">
            Read this before trusting the board
          </div>
          <ul className="list-disc space-y-1 pl-5 text-[var(--dim)]">
            {feed.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5">
        <Panel
          title="Today at a glance"
          aside={<span className="text-xs text-[var(--dim)]">{nasHeadline(feed.nas ?? null)}</span>}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Departures" value={t.departures} />
            <Stat label="Airborne" value={t.departed} tone="text-[var(--green)]" />
            <Stat
              label="Delayed"
              value={t.delayed}
              tone={t.delayed ? "text-[var(--amber)]" : undefined}
            />
            <Stat
              label="Cancelled"
              value={t.cancelled}
              tone={t.cancelled ? "text-[var(--red)]" : undefined}
            />
            <Stat
              label="Suspected"
              value={t.suspectedCancel}
              tone={t.suspectedCancel ? "text-[var(--amber)]" : undefined}
            />
            <Stat label="Est. bags" value={t.estimatedBags.toLocaleString()} />
            <Stat label="Est. carts" value={t.estimatedCarts} />
          </div>
        </Panel>

        <Panel title="Connect the board">
          <FeedUrlBox />
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Data sources">
            <ul className="space-y-2.5">
              {feed.sources.map((s) => (
                <li key={s.id} className="flex items-start gap-3 text-sm">
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      s.ok ? "bg-[var(--green)]" : "bg-[var(--dim)]"
                    }`}
                  />
                  <span>
                    <span className="font-medium">{s.label}</span>
                    {s.latencyMs !== undefined && (
                      <span className="ml-2 text-xs text-[var(--dim)]">{s.latencyMs} ms</span>
                    )}
                    <span className="block text-[13px] text-[var(--dim)]">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Platform state">
            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--dim)]">Storage</dt>
                <dd className="text-right">
                  {storeDriverName()}
                  {!storeIsDurable() && (
                    <span className="block text-xs text-[var(--amber)]">
                      resets on cold start — attach Vercel KV or Upstash
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--dim)]">Last poll</dt>
                <dd>
                  {lastPoll
                    ? new Date(lastPoll).toLocaleTimeString("en-US", { timeZone: STATION.timezone })
                    : "never"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--dim)]">Learned slots</dt>
                <dd>
                  {maturity.trusted} trusted / {maturity.slots} total
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--dim)]">Days observed</dt>
                <dd>{maturity.days}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t border-[var(--line)] pt-3 text-[13px] leading-relaxed text-[var(--dim)]">
              {maturity.message}
            </p>
          </Panel>
        </div>

        <Panel
          title="Next departures"
          aside={<span className="text-xs text-[var(--dim)]">{analysis.confidence.note}</span>}
        >
          {upcoming.length === 0 ? (
            <p className="text-sm text-[var(--dim)]">
              Nothing upcoming in the current window. On OpenSky alone the platform only knows about
              a departure once it has been observed at least once, so an empty list on a fresh
              deployment is expected rather than a fault.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.07em] text-[var(--dim)]">
                    <th className="pb-2 pr-3 font-medium">Flight</th>
                    <th className="pb-2 pr-3 font-medium">Dest</th>
                    <th className="pb-2 pr-3 font-medium">ETD</th>
                    <th className="pb-2 pr-3 font-medium">Gate</th>
                    <th className="pb-2 pr-3 font-medium">Pier</th>
                    <th className="pb-2 pr-3 font-medium">Bags</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 font-medium">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((f, i) => (
                    <tr key={`${f.flight}-${i}`} className="border-t border-[var(--line)]">
                      <td className="py-2 pr-3 font-medium">{f.flight}</td>
                      <td className="py-2 pr-3">{f.destination || "—"}</td>
                      <td className="py-2 pr-3">{f.etd_local || f.etd_sched_local || "—"}</td>
                      <td className="py-2 pr-3">{f.gate || "—"}</td>
                      <td className="py-2 pr-3">{f.pier ? `${f.pier} · ${f.teamLead}` : "—"}</td>
                      <td className="py-2 pr-3">{f.bagEstimate ?? "—"}</td>
                      <td className={`py-2 pr-3 font-medium ${STATUS_TONE[f.status] ?? ""}`}>
                        {f.status}
                      </td>
                      <td className="py-2 text-xs text-[var(--dim)]">
                        {f.source}
                        {f.confidence < 1 && ` · ${Math.round(f.confidence * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Pier load">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {analysis.piers.map((p) => (
              <div key={p.pier} className="rounded-lg border border-[var(--line)] p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold">Pier {p.pier}</span>
                  <span className="text-xs text-[var(--dim)]">{p.lead}</span>
                </div>
                <div className="mt-2 text-sm">
                  {p.departures} departures · {p.bags.toLocaleString()} bags
                </div>
                <div className="mt-1 text-xs text-[var(--dim)]">
                  {p.peakWindow ? `Peak ${p.peakWindow} (${p.peakConcurrent})` : "No peak recorded"}
                </div>
                {p.congested && (
                  <div className="mt-2 inline-block rounded-full bg-[var(--amber)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    Congested
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Endpoints">
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {[
              ["/board", "The bag room board itself"],
              ["/api/feed", "Board-compatible live departures feed"],
              ["/api/feed?verbose=1", "Same, with source diagnostics"],
              ["/api/health", "Is everything actually working?"],
              ["/api/nas", "FAA programs affecting AUS and Delta destinations"],
              ["/api/analysis", "Current bag room analysis"],
              ["/api/reports", "List reports · POST to generate one"],
              ["/api/ingest", "Board pushes its workflow state here"],
              ["/api/cron/poll", "Heartbeat: learn schedule, snapshot state"],
            ].map(([path, desc]) => (
              <li key={path} className="rounded-lg border border-[var(--line)] px-3 py-2">
                <a className="mono text-[13px] text-[var(--accent)] hover:underline" href={path}>
                  {path}
                </a>
                <div className="text-xs text-[var(--dim)]">{desc}</div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <footer className="mt-10 border-t border-[var(--line)] pt-4 text-xs leading-relaxed text-[var(--dim)]">
        Flight data from the OpenSky Network (ADS-B), the FAA NAS Status service, and — when a key
        is configured — FlightAware AeroAPI. Bag and cart figures are modelled from seat counts and
        an assumed load factor; they size the work, they are not a bag count. Not affiliated with
        Delta Air Lines.
      </footer>
    </main>
  );
}
