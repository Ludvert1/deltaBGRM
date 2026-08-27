"use client";

import { useEffect, useRef, useState, useCallback } from "react";

/* ─── Types ─────────────────────────────────────────────── */
interface Toast {
  id: string;
  type: "warn" | "alert" | "info" | "ok";
  title: string;
  body: string;
  exiting?: boolean;
}

interface Totals {
  departures: number;
  departed: number;
  delayed: number;
  cancelled: number;
  suspectedCancel: number;
  estimatedBags: number;
  estimatedCarts: number;
}

interface FeedSnapshot {
  totals?: Totals;
  count: number;
  generated_at?: string;
  warnings?: string[];
}

/* ─── Helpers ────────────────────────────────────────────── */
const TONE: Record<Toast["type"], string> = {
  alert: "border-[var(--delta-red)] bg-[var(--red-dim)]",
  warn:  "border-[var(--amber)] bg-[var(--amber-dim)]",
  info:  "border-[var(--blue)] bg-[var(--blue-dim)]",
  ok:    "border-[var(--green)] bg-[var(--green-dim)]",
};
const DOT: Record<Toast["type"], string> = {
  alert: "bg-[var(--red)]",
  warn:  "bg-[var(--amber)]",
  info:  "bg-[var(--blue)]",
  ok:    "bg-[var(--green)]",
};

function centralClock(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}
function centralDate(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
function centralTZ(): string {
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    timeZoneName: "short",
  }).formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "CT";
  return abbr;
}

/* ─── Component ──────────────────────────────────────────── */
export default function LiveConsole({
  initialTotals,
  initialWarnings,
}: {
  initialTotals: Totals;
  initialWarnings: string[];
}) {
  const [clock, setClock]           = useState(centralClock);
  const [date, setDate]             = useState(centralDate);
  const [tz, setTz]                 = useState(centralTZ);
  const [toasts, setToasts]         = useState<Toast[]>([]);
  const [lastPollAgo, setLastPollAgo] = useState<string>("just now");
  const [feedStatus, setFeedStatus] = useState<"ok" | "warn" | "error">("ok");
  const [totals, setTotals]         = useState<Totals>(initialTotals);
  const [warnings, setWarnings]     = useState<string[]>(initialWarnings);
  const prevRef = useRef<FeedSnapshot | null>(null);
  const lastFetchRef = useRef<Date>(new Date());
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /* live clock */
  useEffect(() => {
    const tick = () => {
      setClock(centralClock());
      setDate(centralDate());
      setTz(centralTZ());
      /* "last updated X ago" */
      const secs = Math.round((Date.now() - lastFetchRef.current.getTime()) / 1000);
      if (secs < 60) setLastPollAgo(`${secs}s ago`);
      else setLastPollAgo(`${Math.round(secs / 60)}m ago`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* toast helpers */
  const addToast = useCallback((t: Omit<Toast, "id">) => {
    const id = crypto.randomUUID();
    setToasts(prev => [{ ...t, id }, ...prev].slice(0, 5));
    const timer = setTimeout(() => {
      setToasts(prev => prev.map(x => x.id === id ? { ...x, exiting: true } : x));
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 220);
    }, 6000);
    toastTimers.current.set(id, timer);
  }, []);

  const dismissToast = (id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    setToasts(prev => prev.map(x => x.id === id ? { ...x, exiting: true } : x));
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 220);
  };

  /* poll /api/feed every 60 s, diff for changes */
  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/feed?verbose=0", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FeedSnapshot = await res.json();
      lastFetchRef.current = new Date();
      setFeedStatus("ok");

      const prev = prevRef.current;
      const cur  = data;

      if (cur.totals) setTotals(cur.totals);
      if (cur.warnings) setWarnings(cur.warnings);

      if (prev) {
        const pt = prev.totals;
        const ct = cur.totals;
        if (!pt || !ct) { prevRef.current = cur; return; }

        /* cancellations */
        if (ct.cancelled > pt.cancelled) {
          addToast({ type: "alert", title: "Cancellation", body: `${ct.cancelled - pt.cancelled} new cancellation(s) detected.` });
        }
        /* new delays */
        if (ct.delayed > pt.delayed) {
          addToast({ type: "warn", title: "Delay", body: `${ct.delayed - pt.delayed} new delay(s) — check the board.` });
        }
        /* flights cleared */
        if (ct.delayed < pt.delayed && pt.delayed > 0) {
          addToast({ type: "ok", title: "Delays cleared", body: `${pt.delayed - ct.delayed} delay(s) resolved.` });
        }
        /* new flights */
        if (ct.departures > pt.departures + 2) {
          addToast({ type: "info", title: "Schedule updated", body: `${ct.departures - pt.departures} new flights in feed.` });
        }
        /* suspected cancellations */
        if (ct.suspectedCancel > pt.suspectedCancel) {
          addToast({ type: "warn", title: "Suspected cancel", body: `${ct.suspectedCancel} flight(s) look likely cancelled.` });
        }
      }

      prevRef.current = cur;
    } catch {
      setFeedStatus("error");
      addToast({ type: "alert", title: "Feed error", body: "Could not reach /api/feed. Check the health endpoint." });
    }
  }, [addToast]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [poll]);

  return (
    <>
      {/* ── Topbar ── */}
      <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg-panel)]">
        {/* Main bar */}
        <div className="flex items-center gap-3 px-4 py-2.5">
          {/* Logo */}
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-[var(--delta-red)]">
              <svg viewBox="0 0 20 20" className="h-4 w-4 fill-white">
                <polygon points="10,2 18,18 2,18" />
              </svg>
            </div>
            <div className="hidden sm:block">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--delta-red)]">AUS · Bag Room Ops</div>
              <div className="text-[10px] text-[var(--dim)]">Delta Air Lines · Austin-Bergstrom</div>
            </div>
            <div className="block sm:hidden">
              <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--delta-red)] leading-none">AUS OPS</div>
            </div>
          </div>

          {/* Central time — takes remaining space, centered */}
          <div className="flex flex-1 flex-col items-center">
            <div className="font-mono text-lg font-semibold tabular-nums tracking-tight leading-none">
              {clock}
              <span className="ml-1 text-[10px] font-normal uppercase tracking-widest text-[var(--delta-gold)]">{tz}</span>
            </div>
            <div className="text-[10px] text-[var(--dim)]">{date}</div>
          </div>

          {/* Right: status + CTA */}
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden items-center gap-1.5 text-[11px] text-[var(--dim)] md:flex">
              <span className={`h-2 w-2 rounded-full ${feedStatus === "ok" ? "bg-[var(--green)] pulse" : feedStatus === "warn" ? "bg-[var(--amber)]" : "bg-[var(--red)]"}`} />
              {feedStatus === "ok" ? `${lastPollAgo}` : "Error"}
            </div>
            <a href="/board" target="_blank"
              className="rounded-md border border-[var(--delta-red)] bg-[var(--delta-red-dim)] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--delta-red)] transition hover:bg-[var(--delta-red)] hover:text-white whitespace-nowrap">
              Board ↗
            </a>
          </div>
        </div>
      </header>

      {/* ── Quick-nav tabs ── */}
      <nav className="sticky top-[49px] z-30 flex gap-0.5 overflow-x-auto border-b border-[var(--line)] bg-[var(--bg)] px-3 py-1.5 scrollbar-none"
           style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {[
          { href: "#glance",   label: "Glance" },
          { href: "#connect",  label: "Connect" },
          { href: "#flights",  label: "Departures" },
          { href: "#piers",    label: "Piers" },
          { href: "#sources",  label: "Sources" },
          { href: "#state",    label: "Status" },
          { href: "#tools",    label: "APIs" },
        ].map(({ href, label }) => (
          <a key={href} href={href}
            className="shrink-0 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--fg)] whitespace-nowrap">
            {label}
          </a>
        ))}
      </nav>

      {/* ── Warnings ── */}
      {warnings.length > 0 && (
        <div className="mx-5 mt-5 rounded-xl border border-[var(--amber)] bg-[var(--amber-dim)] p-4">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[var(--amber)]">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            Before trusting the board
          </div>
          <ul className="space-y-1.5 text-sm text-[var(--amber)]">
            {warnings.map((w, i) => <li key={i} className="leading-relaxed opacity-90">· {w}</li>)}
          </ul>
        </div>
      )}

      {/* ── Live stat tiles (client-updated) ── */}
      <section id="glance" className="scroll-mt-28 px-5 pt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--dim)]">Today at a Glance</h2>
          <span className="text-[10px] text-[var(--dim)]">Refreshes every 60 s · {tz} times</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <StatTile label="Departures"  value={totals.departures} />
          <StatTile label="Airborne"    value={totals.departed}          tone="green" />
          <StatTile label="Delayed"     value={totals.delayed}           tone={totals.delayed ? "amber" : undefined} />
          <StatTile label="Cancelled"   value={totals.cancelled}         tone={totals.cancelled ? "red" : undefined} />
          <StatTile label="Suspected"   value={totals.suspectedCancel}   tone={totals.suspectedCancel ? "amber" : undefined} />
          <StatTile label="Est. Bags"   value={totals.estimatedBags.toLocaleString()} />
          <StatTile label="Est. Carts"  value={totals.estimatedCarts} />
        </div>
      </section>

      {/* ── Toast stack ── */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id}
            className={`pointer-events-auto flex w-80 items-start gap-3 rounded-xl border p-4 shadow-2xl ${TONE[t.type]} ${t.exiting ? "toast-exit" : "toast-enter"}`}>
            <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[t.type]}`} />
            <div className="flex-1">
              <div className="text-[12px] font-semibold text-[var(--fg)]">{t.title}</div>
              <div className="text-[11px] text-[var(--mid)]">{t.body}</div>
            </div>
            <button onClick={() => dismissToast(t.id)}
              className="text-[var(--dim)] hover:text-[var(--fg)] text-base leading-none">×</button>
          </div>
        ))}
      </div>
    </>
  );
}

function StatTile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "green" | "amber" | "red" }) {
  const colors: Record<string, string> = {
    green: "text-[var(--green)] bg-[var(--green-dim)] border-[var(--green)]",
    amber: "text-[var(--amber)] bg-[var(--amber-dim)] border-[var(--amber)]",
    red:   "text-[var(--red)]   bg-[var(--red-dim)]   border-[var(--red)]",
  };
  const cls = tone ? colors[tone] : "text-[var(--fg)] border-[var(--line)]";
  return (
    <div className={`rounded-xl border px-4 py-3 ${cls}`}>
      <div className="text-2xl font-bold tabular-nums tracking-tight">{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] opacity-70">{label}</div>
    </div>
  );
}
