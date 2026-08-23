#!/usr/bin/env node
/**
 * Builds public/board.html from the operations board source.
 *
 * The board ships as one self-contained HTML file with demo data baked in and
 * a feed URL that has to be pasted in by hand. This script makes three changes
 * and nothing else, so the board stays the file the team already knows:
 *
 *   1. Strips the demo flights and demo handoff notes. The board comes up empty
 *      and fills from the live feed instead of showing invented cancellations.
 *   2. Points the feed at this deployment's own /api/feed by default, so a
 *      device needs no configuration at all.
 *   3. Pushes the team's workflow state to /api/ingest so the automated reports
 *      can describe what the bag room actually did, not just what the airline did.
 *
 * Usage:  node scripts/build-board.mjs [sourceBoard.html]
 * Default source: board/source/Delta_AUS_Bagroom_Operations_LIVE_Mobile.html
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source =
  process.argv[2] ??
  resolve(root, "board/source/Delta_AUS_Bagroom_Operations_LIVE_Mobile.html");
const target = resolve(root, "public/board.html");

if (!existsSync(source)) {
  console.error(`✗ Board source not found: ${source}`);
  process.exit(1);
}

let html = readFileSync(source, "utf8");
const original = html.length;
const changes = [];

/* 1 — strip the demo data ------------------------------------------------- */

const stripArray = (name) => {
  const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`);
  if (!re.test(html)) {
    console.error(`✗ Could not find ${name} in the board source.`);
    process.exit(1);
  }
  html = html.replace(
    re,
    `const ${name} = []; /* demo data removed by scripts/build-board.mjs — live feed populates this */`,
  );
  changes.push(`cleared ${name}`);
};

stripArray("DEFAULT_FLIGHTS");
stripArray("DEFAULT_HANDOFF");

/* 2 + 3 — platform bootstrap ---------------------------------------------- */

const bootstrap = `
/* ═══════════════════════════════════════════════════════════════════════
   PLATFORM BOOTSTRAP — added by scripts/build-board.mjs
   Self-configures the feed and syncs workflow state for automated reports.
   ═══════════════════════════════════════════════════════════════════════ */
(function platformBootstrap() {
  var ORIGIN = window.location.origin;
  var FEED = ORIGIN + '/api/feed';
  var INGEST = ORIGIN + '/api/ingest';
  var SYNC_MS = 300000; // five minutes

  /* --- point the board at this deployment unless told otherwise --- */
  try {
    var stale = settings.feedUrl && /workers\\.dev/i.test(settings.feedUrl);
    if (!settings.feedUrl || stale) {
      settings.feedUrl = FEED;
      if (!settings.feedInterval || settings.feedInterval < 30) settings.feedInterval = 120;
      saveSettings();
      var input = document.getElementById('s-feedurl');
      if (input) input.value = settings.feedUrl;
      startFeedPolling();
      fetchLiveFeed();
    }
  } catch (e) {}

  /* --- stable per-device id so several devices can post without clashing --- */
  var deviceId;
  try {
    deviceId = localStorage.getItem('aus_bagroom_device');
    if (!deviceId) {
      deviceId = 'dev-' + Math.random().toString(36).slice(2, 9);
      localStorage.setItem('aus_bagroom_device', deviceId);
    }
  } catch (e) {
    deviceId = 'dev-anon';
  }

  /* --- push what this device knows so reports can measure the bag room --- */
  function syncOps() {
    try {
      if (!Array.isArray(flights) || flights.length === 0) return;
      fetch(INGEST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'AUS',
          postedAt: new Date().toISOString(),
          device: deviceId,
          flights: flights
        }),
        keepalive: true
      }).catch(function () { /* offline is fine; next tick retries */ });
    } catch (e) {}
  }

  setTimeout(syncOps, 15000);
  setInterval(syncOps, SYNC_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') syncOps();
  });
  window.addEventListener('pagehide', syncOps);
})();
`;

const anchor = html.lastIndexOf("</script>");
if (anchor === -1) {
  console.error("✗ Could not find a closing </script> tag to append the bootstrap to.");
  process.exit(1);
}
html = html.slice(0, anchor) + bootstrap + "\n" + html.slice(anchor);
changes.push("injected platform bootstrap (auto feed URL + ops sync)");

html = html.replace(
  /<title>[\s\S]*?<\/title>/,
  "<title>Delta AUS Bagroom · Live Operations</title>",
);
changes.push("updated <title>");

/* — write — */

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html, "utf8");

console.log("✓ Board built");
for (const c of changes) console.log(`  · ${c}`);
console.log(`  → ${target}`);
console.log(`  ${(original / 1024).toFixed(0)} KB source → ${(html.length / 1024).toFixed(0)} KB output`);
