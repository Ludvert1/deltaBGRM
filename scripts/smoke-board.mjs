#!/usr/bin/env node
/**
 * End-to-end smoke test: does the board actually come up on live data?
 *
 * Opens /board in a real browser against a running deployment and checks the
 * full loop — the board self-configures its feed URL, pulls the live feed,
 * renders rows, and posts its workflow state back to /api/ingest.
 *
 *   npx playwright install chromium      # once
 *   node scripts/smoke-board.mjs http://localhost:3000
 *
 * Playwright is intentionally NOT a dependency of this project: it would pull a
 * browser download into every Vercel build. Install it ad hoc to run this.
 */

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("✗ playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const api = [];
const failed = [];
page.on("response", (r) => {
  if (r.url().includes("/api/")) api.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
});
page.on("requestfailed", (r) => {
  // Google Fonts failing offline is cosmetic, not a fault in the platform.
  if (!r.url().includes("fonts.googleapis.com")) {
    failed.push(`${r.url()} :: ${r.failure()?.errorText}`);
  }
});

await page.goto(`${base}/board`, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(20_000); // the ops sync fires at 15 s

const state = await page.evaluate(() => ({
  title: document.title,
  rows: document.querySelectorAll("#rows .row").length,
  feedStatus: document.getElementById("feed-status")?.textContent ?? null,
}));

await browser.close();

const gotFeed = api.some((a) => a.includes("/api/feed") && a.endsWith("200"));
const gotIngest = api.some((a) => a.includes("/api/ingest") && a.endsWith("200"));

console.log(`title       ${state.title}`);
console.log(`rows        ${state.rows}`);
console.log(`feedStatus  ${state.feedStatus}`);
console.log(`api         ${api.join("\n            ") || "(none)"}`);
if (failed.length) console.log(`failed      ${failed.join("\n            ")}`);

const problems = [];
if (!gotFeed) problems.push("the board never fetched /api/feed successfully");
if (!gotIngest) problems.push("the board never posted to /api/ingest");
if (state.rows === 0) problems.push("no flight rows rendered (may simply mean no Delta departures in the window)");
if (failed.length) problems.push(`${failed.length} request(s) failed`);

if (problems.length) {
  console.error(`\n✗ ${problems.join("; ")}`);
  process.exit(state.rows === 0 && gotFeed && gotIngest ? 0 : 1);
}
console.log("\n✓ Board, feed and ops sync all working.");
