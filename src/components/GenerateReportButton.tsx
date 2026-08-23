"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GenerateReportButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [shift, setShift] = useState("DAY");

  async function generate() {
    setState("working");
    setMessage(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shift }),
      });
      const json = (await res.json()) as { id?: string; headline?: string; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setState("idle");
      setMessage(json.headline ?? `Generated ${json.id}`);
      router.refresh();
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-[var(--dim)]" htmlFor="shift">
          Shift
        </label>
        <select
          id="shift"
          value={shift}
          onChange={(e) => setShift(e.target.value)}
          className="rounded-md border border-[var(--line)] bg-transparent px-2.5 py-1.5 text-sm"
        >
          <option value="DAY">Full day</option>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
          <option value="MID">MID</option>
        </select>
        <button
          onClick={generate}
          disabled={state === "working"}
          className="rounded-md border border-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
        >
          {state === "working" ? "Generating…" : "Generate report now"}
        </button>
      </div>
      {message && (
        <p
          className={`mt-3 text-sm ${state === "error" ? "text-[var(--red)]" : "text-[var(--dim)]"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
