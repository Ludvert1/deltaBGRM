"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

/**
 * Shows the deployment's own feed URL and the one-tap link that configures a
 * board device. The origin is read from the browser so it is correct on
 * localhost, on a preview deployment and in production with no env var.
 */

const subscribeToNothing = () => () => {};
const getOrigin = () => window.location.origin;
const getServerOrigin = () => "";

function CopyRow({
  label,
  url,
  hint,
  copied,
  onCopy,
}: {
  label: string;
  url: string;
  hint: string;
  copied: string | null;
  onCopy: (url: string, label: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--dim)]">
          {label}
        </span>
        <button
          onClick={() => onCopy(url, label)}
          className="rounded-md border border-[var(--line)] px-2.5 py-1 text-xs hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          {copied === label ? "Copied" : "Copy"}
        </button>
      </div>
      <code className="block break-all text-[12.5px] text-[var(--accent)]">{url}</code>
      <p className="mt-1.5 text-xs text-[var(--dim)]">{hint}</p>
    </div>
  );
}

export function FeedUrlBox() {
  const origin = useSyncExternalStore(subscribeToNothing, getOrigin, getServerOrigin);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied("Copy failed — select the text manually");
      setTimeout(() => setCopied(null), 2400);
    }
  }, []);

  if (!origin) {
    return <p className="text-sm text-[var(--dim)]">Resolving deployment URL…</p>;
  }

  const feedUrl = `${origin}/api/feed`;
  const boardUrl = `${origin}/board?feed=${encodeURIComponent(feedUrl)}&interval=120`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <CopyRow
        label="Feed URL"
        url={feedUrl}
        hint="Paste into the board: Ops Entry → Settings → Live Data Feed URL. Refresh 120 s."
        copied={copied}
        onCopy={copy}
      />
      <CopyRow
        label="Self-configuring board link"
        url={boardUrl}
        hint="Send this to the team. The first open saves the feed on that device; afterwards the plain /board URL works."
        copied={copied}
        onCopy={copy}
      />
      {copied?.startsWith("Copy failed") && (
        <p className="text-xs text-[var(--amber)] sm:col-span-2">{copied}</p>
      )}
    </div>
  );
}
