/**
 * AUS Delta Bag Room — Ops Console
 * Server-rendered shell + LiveConsole client component for real-time updates.
 */

import { buildFeed }          from "@/lib/providers";
import { loadBaseline, baselineMaturity } from "@/lib/baseline";
import { analyze }            from "@/lib/analytics";
import { nasHeadline }        from "@/lib/providers/faa";
import { storeDriverName, storeIsDurable, store, KEYS } from "@/lib/store";
import { STATION }            from "@/lib/config";
import { localDate }          from "@/lib/time";
import { OpsFlight }          from "@/lib/types";
import { FeedUrlBox }         from "@/components/FeedUrlBox";
import { GenerateReportButton } from "@/components/GenerateReportButton";
import LiveConsole            from "@/components/LiveConsole";

export const dynamic    = "force-dynamic";
export const revalidate = 0;

const STATUS_TONE: Record<string, string> = {
  Departed:         "text-[var(--green)]",
  Delayed:          "text-[var(--amber)]",
  Canceled:         "text-[var(--red)]",
  "Suspected Cancel": "text-[var(--amber)]",
  Diverted:         "text-[var(--red)]",
  Scheduled:        "text-[var(--dim)]",
};

/* ── Layout primitives ─────────────────────────────────── */
function Section({ id, title, aside, children }: {
  id?: string; title: string; aside?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--line)] px-5 py-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--dim)]">{title}</h2>
        {aside}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "amber" | "red" | "green" | "blue" }) {
  const cls = {
    amber: "bg-[var(--amber-dim)] text-[var(--amber)] border-[var(--amber)]",
    red:   "bg-[var(--red-dim)]   text-[var(--red)]   border-[var(--red)]",
    green: "bg-[var(--green-dim)] text-[var(--green)] border-[var(--green)]",
    blue:  "bg-[var(--blue-dim)]  text-[var(--blue)]  border-[var(--blue)]",
  }[tone ?? "blue"] ?? "";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${cls}`}>
      {children}
    </span>
  );
}

/* ── Page ──────────────────────────────────────────────── */
export default async function Console() {
  const feed     = await buildFeed();
  const baseline = await loadBaseline();
  const maturity = baselineMaturity(baseline);
  const ops      = (await store.get<OpsFlight[]>(KEYS.opsDay(localDate()))) ?? [];
  const analysis = analyze(feed.flights, feed.nas ?? null, ops);
  const lastPoll = await store.get<string>(KEYS.lastPoll);
  const t        = analysis.totals;
  const nasNote  = nasHeadline(feed.nas ?? null);
  const durable  = storeIsDurable();

  const upcoming = feed.flights.filter(f => f.status !== "Departed").slice(0, 16);

  /* Last poll in Central */
  const lastPollLocal = lastPoll
    ? new Date(lastPoll).toLocaleTimeString("en-US", {
        timeZone: STATION.timezone,
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      })
    : "never";

  return (
    <>
      {/* LiveConsole renders: sticky topbar + quick nav + glance tiles + toasts */}
      <LiveConsole
        initialTotals={t}
        initialWarnings={feed.warnings}
      />

      {/* ── Body ── */}
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-3 py-4 pb-16 sm:px-5 sm:py-5">

        {/* FAA banner */}
        {nasNote && nasNote !== "No FAA programs affecting AUS or its Delta destinations" && (
          <div className="flex items-start gap-3 rounded-xl border border-[var(--blue)] bg-[var(--blue-dim)] px-4 py-3 text-sm text-[var(--blue)]">
            <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd"/>
            </svg>
            <span><strong className="font-semibold">FAA: </strong>{nasNote}</span>
          </div>
        )}

        {/* ── Connect the board ── */}
        <Section id="connect" title="Connect the Board"
          aside={<a href="/board" target="_blank" className="text-[11px] text-[var(--accent)] hover:underline">Open board ↗</a>}
        >
          <FeedUrlBox />
        </Section>

        {/* ── Upcoming departures ── */}
        <Section id="flights" title="Upcoming Departures"
          aside={<span className="text-[11px] text-[var(--dim)]">{analysis.confidence.note}</span>}
        >
          {upcoming.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--line)] px-5 py-10 text-center">
              <p className="text-sm text-[var(--mid)]">No upcoming flights in feed yet.</p>
              <p className="mt-1 text-xs text-[var(--dim)]">Paste today's schedule via Ops Entry → Bulk Paste on the board, or wait for the poller to observe departures.</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
                    {["Flight","Dest","ETD (CT)","Gate","Pier · Lead","Bags","Status","Source"].map(h => (
                      <th key={h} className="pb-3 pr-4 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((f, i) => {
                    const rowBg = i % 2 === 0 ? "" : "bg-[var(--bg-raised)] bg-opacity-50";
                    return (
                      <tr key={`${f.flight}-${i}`} className={`border-t border-[var(--line)] ${rowBg}`}>
                        <td className="py-2.5 pr-4 font-semibold tracking-tight">{f.flight}</td>
                        <td className="py-2.5 pr-4 text-[var(--mid)]">{f.destination || "—"}</td>
                        <td className="py-2.5 pr-4 font-mono text-[13px]">{f.etd_local || f.etd_sched_local || "—"}</td>
                        <td className="py-2.5 pr-4">
                          {f.gate ? <span className="rounded bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[12px]">G{f.gate}</span> : "—"}
                        </td>
                        <td className="py-2.5 pr-4 text-[var(--mid)]">{f.pier ? `${f.pier} · ${f.teamLead}` : "—"}</td>
                        <td className="py-2.5 pr-4 tabular-nums">{f.bagEstimate ?? "—"}</td>
                        <td className={`py-2.5 pr-4 font-semibold ${STATUS_TONE[f.status] ?? ""}`}>
                          {f.status === "Delayed" && <span className="mr-1">⚠</span>}
                          {f.status === "Canceled" && <span className="mr-1">✕</span>}
                          {f.status}
                        </td>
                        <td className="py-2.5 text-[11px] text-[var(--dim)]">
                          {f.source}{f.confidence < 1 && ` · ${Math.round(f.confidence * 100)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* ── Pier load ── */}
        <Section id="piers" title="Pier Load">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {analysis.piers.map(p => {
              const bar = Math.min(100, Math.round((p.departures / Math.max(1, t.departures)) * 100));
              return (
                <div key={p.pier} className="rounded-xl border border-[var(--line)] bg-[var(--bg-raised)] p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--dim)]">Pier {p.pier}</div>
                      <div className="mt-0.5 text-2xl font-bold tabular-nums">{p.departures}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-[var(--dim)]">Lead</div>
                      <div className="font-mono text-lg font-bold text-[var(--delta-gold)]">{p.lead}</div>
                    </div>
                  </div>
                  {/* Load bar */}
                  <div className="mt-3 h-1 rounded-full bg-[var(--line)]">
                    <div className="h-1 rounded-full bg-[var(--delta-red)] transition-all" style={{ width: `${bar}%` }} />
                  </div>
                  <div className="mt-2 text-[11px] text-[var(--dim)]">
                    {p.bags.toLocaleString()} bags est.
                  </div>
                  {p.peakWindow && (
                    <div className="mt-0.5 text-[11px] text-[var(--dim)]">Peak {p.peakWindow}</div>
                  )}
                  {p.congested && <Badge tone="amber">Congested</Badge>}
                </div>
              );
            })}
          </div>
        </Section>

        {/* ── Data sources + Platform state ── */}
        <div className="grid gap-5 lg:grid-cols-2">
          <Section id="sources" title="Data Sources">
            <ul className="space-y-3">
              {feed.sources.map(s => (
                <li key={s.id} className="flex items-start gap-3">
                  <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${s.ok ? "bg-[var(--green)] pulse" : "bg-[var(--red)]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{s.label}</span>
                      {s.latencyMs !== undefined && (
                        <span className="text-[10px] text-[var(--dim)]">{s.latencyMs} ms</span>
                      )}
                      {!s.ok && <Badge tone="red">Down</Badge>}
                    </div>
                    <div className="text-[12px] text-[var(--dim)] mt-0.5">{s.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="state" title="Platform State">
            <dl className="space-y-3 text-sm">
              {[
                {
                  label: "Storage",
                  value: (
                    <>
                      {storeDriverName()}
                      {!durable && (
                        <div className="mt-0.5 text-[11px] text-[var(--amber)]">
                          Resets on cold start — attach Vercel KV or Upstash for persistence
                        </div>
                      )}
                    </>
                  ),
                  warn: !durable,
                },
                { label: "Last poll", value: lastPollLocal },
                { label: "Learned slots", value: `${maturity.trusted} trusted / ${maturity.slots} total` },
                { label: "Days observed", value: String(maturity.days) },
              ].map(({ label, value, warn }) => (
                <div key={label} className="flex justify-between gap-4 rounded-lg border border-[var(--line)] px-3 py-2.5">
                  <dt className="text-[var(--dim)]">{label}</dt>
                  <dd className={`text-right text-sm ${warn ? "text-[var(--amber)]" : ""}`}>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--bg-raised)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--dim)]">
              {maturity.message}
            </p>
          </Section>
        </div>

        {/* ── Reports ── */}
        <Section id="reports" title="Shift Reports"
          aside={<GenerateReportButton />}
        >
          <p className="text-[13px] text-[var(--dim)]">
            Reports are generated automatically at shift boundaries by <code className="mono text-[11px]">report.yml</code>.
            Use the button above to generate one now, or hit <code className="mono text-[11px]">POST /api/reports</code> with <code className="mono text-[11px]">{"{ \"shift\": \"DAY\" }"}</code>.
          </p>
          <a href="/reports" className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent)] bg-[var(--blue-dim)] px-4 py-2 text-[12px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)] hover:text-white">
            View all reports →
          </a>
        </Section>

        {/* ── Tools & APIs ── */}
        <Section id="tools" title="Tools & API Endpoints">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { path: "/board",              label: "Bag room board",        desc: "The team-facing departures display",          badge: "Primary" as const },
              { path: "/api/feed",           label: "Departures feed",       desc: "Board-compatible live flight data (JSON)",    badge: undefined },
              { path: "/api/feed?verbose=1", label: "Feed (verbose)",        desc: "Same feed with source diagnostics",           badge: undefined },
              { path: "/api/health",         label: "Health check",          desc: "Feed sources status and latency",             badge: undefined },
              { path: "/api/analysis",       label: "Bag room analysis",     desc: "Disruption and pier load calculations",       badge: undefined },
              { path: "/api/nas",            label: "FAA NAS programs",      desc: "Ground stops, delays affecting AUS + Delta",  badge: undefined },
              { path: "/api/reports",        label: "Reports",               desc: "List and generate shift reports",             badge: undefined },
              { path: "/api/steps",          label: "Accountability view",   desc: "Operator step log for the current shift",    badge: undefined },
              { path: "/api/ingest",         label: "Ingest (POST)",         desc: "Board pushes workflow state here",            badge: undefined },
              { path: "/api/cron/poll",      label: "Poll (GET)",            desc: "Heartbeat: learn schedule, snapshot state",  badge: undefined },
              { path: "/api/cron/report",    label: "Report cron (GET)",     desc: "Trigger shift report on schedule",            badge: undefined },
            ].map(({ path, label, desc, badge }) => (
              <a key={path} href={path} target="_blank"
                className="group flex flex-col gap-1 rounded-xl border border-[var(--line)] bg-[var(--bg-raised)] px-4 py-3 transition hover:border-[var(--accent)] hover:bg-[var(--blue-dim)]">
                <div className="flex items-start justify-between gap-2">
                  <code className="mono text-[12px] text-[var(--accent)] group-hover:underline">{path}</code>
                  {badge && <Badge tone="red">{badge}</Badge>}
                </div>
                <div className="font-semibold text-[13px]">{label}</div>
                <div className="text-[11px] text-[var(--dim)]">{desc}</div>
              </a>
            ))}
          </div>
        </Section>

        {/* ── Footer ── */}
        <footer className="border-t border-[var(--line)] pt-5 text-[11px] leading-relaxed text-[var(--dim)]">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>Flight data: OpenSky Network (ADS-B), FAA NAS Status, FlightAware AeroAPI (when configured)</span>
            <span>Bag/cart figures are modelled estimates, not live counts</span>
            <span>Not affiliated with Delta Air Lines</span>
          </div>
        </footer>
      </main>
    </>
  );
}
