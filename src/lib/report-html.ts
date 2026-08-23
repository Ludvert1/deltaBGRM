import { Report } from "./report";
import { STATION } from "./config";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Standalone, printable HTML rendering of a report. No external assets. */
export function renderReportHtml(r: Report): string {
  const t = r.analysis.totals;
  const stat = (label: string, value: string | number, tone = "") =>
    `<div class="stat ${tone}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(STATION.iata)} Bag Room Report · ${esc(r.date)} · ${esc(r.shift)}</title>
<style>
:root{--bg:#fff;--fg:#12161c;--dim:#5b6472;--line:#e3e7ec;--accent:#003268;--red:#c0392b;--amber:#b8860b;--green:#1e7a45;--card:#f7f9fb}
@media(prefers-color-scheme:dark){:root{--bg:#0e1216;--fg:#e8edf3;--dim:#93a0b0;--line:#232c36;--accent:#8ab4f8;--card:#161c23}}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:36px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}
.sub{color:var(--dim);font-size:14px;margin-bottom:20px}
.headline{font-size:19px;font-weight:600;line-height:1.4;margin:20px 0;padding:16px 18px;background:var(--card);border-left:3px solid var(--accent);border-radius:0 6px 6px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
.stat .v{font-size:24px;font-weight:650;letter-spacing:-.02em}
.stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-top:4px}
.stat.red .v{color:var(--red)}.stat.amber .v{color:var(--amber)}.stat.green .v{color:var(--green)}
table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.scroll{overflow-x:auto}
ul{padding-left:20px;margin:8px 0}li{margin:6px 0}
.caveats{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;font-size:13.5px;color:var(--dim)}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;letter-spacing:.03em}
.pill.cancel{background:var(--red);color:#fff}.pill.susp{background:var(--amber);color:#fff}
.pill.delay{background:#8a6d00;color:#fff}.pill.dep{background:var(--green);color:#fff}
.foot{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}
@media print{body{padding:0}.stat{break-inside:avoid}}
</style></head><body><div class="wrap">

<h1>${esc(STATION.iata)} Delta Bag Room — ${esc(r.shift === "DAY" ? "Daily" : r.shift + " Shift")} Report</h1>
<div class="sub">${esc(r.date)} · generated ${esc(r.generatedAtLocal)} · ${esc(r.snapshotCount)} poll snapshots</div>

<div class="headline">${esc(r.headline)}</div>
<div class="sub">FAA: ${esc(r.faaHeadline)}</div>

<h2>Departure picture</h2>
<div class="stats">
${stat("Departures", t.departures)}
${stat("Airborne", t.departed, "green")}
${stat("Delayed", t.delayed, t.delayed ? "amber" : "")}
${stat("Cancelled", t.cancelled, t.cancelled ? "red" : "")}
${stat("Suspected", t.suspectedCancel, t.suspectedCancel ? "amber" : "")}
${stat("Est. bags", t.estimatedBags.toLocaleString())}
${stat("Est. carts", t.estimatedCarts)}
</div>

<h2>What happened</h2>
<ul>${r.narrative.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>

<h2>Pier load</h2>
<div class="scroll"><table>
<tr><th>Pier</th><th>Lead</th><th>Departures</th><th>Est. bags</th><th>Carts</th><th>Peak</th><th>Status</th></tr>
${r.analysis.piers
  .map(
    (p) => `<tr><td><strong>${esc(p.pier)}</strong></td><td>${esc(p.lead)}</td><td>${p.departures}</td>
<td>${p.bags.toLocaleString()}</td><td>${p.carts}</td>
<td>${esc(p.peakWindow ?? "—")}${p.peakConcurrent ? ` (${p.peakConcurrent})` : ""}</td>
<td>${p.congested ? '<span class="pill susp">Congested</span>' : "Normal"}</td></tr>`,
  )
  .join("")}
</table></div>

${
  r.disruptions.length
    ? `<h2>Disrupted flights</h2><div class="scroll"><table>
<tr><th>Flight</th><th>Dest</th><th>ETD</th><th>Status</th><th>Bags</th><th>Basis</th></tr>
${r.disruptions
  .map((f) => {
    const cls =
      f.status === "Canceled" ? "cancel" : f.status === "Suspected Cancel" ? "susp" : f.status === "Departed" ? "dep" : "delay";
    return `<tr><td><strong>${esc(f.flight)}</strong></td><td>${esc(f.destination || "—")}</td>
<td>${esc(f.etd_local || f.etd_sched_local || "—")}</td>
<td><span class="pill ${cls}">${esc(f.status)}</span></td>
<td>${esc(f.bagEstimate ?? "—")}</td>
<td>${esc(f.source)}${f.confidence < 1 ? ` · ${Math.round(f.confidence * 100)}%` : ""}</td></tr>`;
  })
  .join("")}
</table></div>`
    : ""
}

${
  r.analysis.exposure.length
    ? `<h2>FAA exposure</h2><div class="scroll"><table>
<tr><th>Flight</th><th>Dest</th><th>ETD</th><th>Program</th><th>Reason</th><th>Bags at risk</th></tr>
${r.analysis.exposure
  .map(
    (e) =>
      `<tr><td><strong>${esc(e.flight)}</strong></td><td>${esc(e.destination)}</td><td>${esc(e.etd)}</td>
<td>${esc(e.kind)}</td><td>${esc(e.reason)}</td><td>${e.bagsAtRisk}</td></tr>`,
  )
  .join("")}
</table></div>`
    : ""
}

${
  r.analysis.ops
    ? `<h2>Bag room performance</h2>
<div class="stats">
${stat("Flights worked", r.analysis.ops.tracked)}
${stat("Cart-out logged", r.analysis.ops.cartOutRecorded)}
${stat("Ahead of cutoff", r.analysis.ops.otpPercent !== null ? r.analysis.ops.otpPercent + "%" : "—", (r.analysis.ops.otpPercent ?? 100) >= 90 ? "green" : "amber")}
${stat("Avg slack (min)", r.analysis.ops.avgVarianceMinutes ?? "—")}
${stat("Late cart-out", r.analysis.ops.lateCartOut, r.analysis.ops.lateCartOut ? "red" : "")}
${stat("Missing bags", r.analysis.ops.missingBags, r.analysis.ops.missingBags ? "red" : "")}
</div>
<div class="scroll"><table>
<tr><th>Lead</th><th>Flights</th><th>Complete</th><th>Missing bags</th></tr>
${r.analysis.ops.byLead
  .map((l) => `<tr><td><strong>${esc(l.lead)}</strong></td><td>${l.flights}</td><td>${l.completed}</td><td>${l.missingBags}</td></tr>`)
  .join("")}
</table></div>`
    : ""
}

${
  r.timeline.length
    ? `<h2>Timeline</h2><div class="scroll"><table>
<tr><th>Time</th><th>Event</th><th>Detail</th></tr>
${r.timeline.map((e) => `<tr><td>${esc(e.at)}</td><td><strong>${esc(e.label)}</strong></td><td>${esc(e.detail)}</td></tr>`).join("")}
</table></div>`
    : ""
}

<h2>Read this before quoting the numbers</h2>
<div class="caveats"><ul>${r.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>

<div class="foot">${esc(STATION.name)} · ${esc(STATION.timezone)} · report id <code>${esc(r.id)}</code></div>
</div></body></html>`;
}
