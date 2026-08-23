#!/usr/bin/env node
/**
 * Builds public/board.html from the operations board source.
 *
 * The board ships as one self-contained HTML file with demo data baked in and
 * a feed URL that has to be pasted in by hand. This script makes four changes
 * and nothing else, so the board stays the file the team already knows:
 *
 *   1. Strips the demo flights and demo handoff notes, so the board comes up
 *      empty and fills from the live feed rather than showing invented
 *      cancellations.
 *   2. Injects the platform add-on stylesheet.
 *   3. Injects the platform add-on script: cart-departure deadlines, escalating
 *      alerts, the next-out bar, and the sync that carries every timestamped
 *      step — and whoever recorded it — up to the platform.
 *   4. Retitles the page.
 *
 * Everything the board already did is untouched. Drop a newer board revision
 * into board/source/ and re-run.
 *
 * Usage:  node scripts/build-board.mjs [sourceBoard.html]
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
const addonJs = resolve(root, "board/platform-addon.js");
const addonCss = resolve(root, "board/platform-addon.css");

for (const [label, path] of [
  ["Board source", source],
  ["Add-on script", addonJs],
  ["Add-on stylesheet", addonCss],
]) {
  if (!existsSync(path)) {
    console.error(`✗ ${label} not found: ${path}`);
    process.exit(1);
  }
}

let html = readFileSync(source, "utf8");
const originalSize = html.length;
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
    `const ${name} = []; /* demo data removed by scripts/build-board.mjs — the live feed populates this */`,
  );
  changes.push(`cleared ${name}`);
};

stripArray("DEFAULT_FLIGHTS");
stripArray("DEFAULT_HANDOFF");

/* 2 — inject the stylesheet ----------------------------------------------- */

const css = readFileSync(addonCss, "utf8");
const headClose = html.lastIndexOf("</head>");
if (headClose === -1) {
  console.error("✗ Could not find </head> to inject the add-on stylesheet.");
  process.exit(1);
}
html =
  html.slice(0, headClose) +
  `<style id="platform-addon-styles">\n${css}\n</style>\n` +
  html.slice(headClose);
changes.push(`injected add-on stylesheet (${(css.length / 1024).toFixed(1)} KB)`);

/* 3 — inject the add-on script -------------------------------------------- */

const js = readFileSync(addonJs, "utf8");
const scriptClose = html.lastIndexOf("</script>");
if (scriptClose === -1) {
  console.error("✗ Could not find a closing </script> tag to append the add-on to.");
  process.exit(1);
}
html = html.slice(0, scriptClose) + "\n" + js + "\n" + html.slice(scriptClose);
changes.push(`injected add-on script (${(js.length / 1024).toFixed(1)} KB)`);

/* 4 — retitle -------------------------------------------------------------- */

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
console.log(
  `  ${(originalSize / 1024).toFixed(0)} KB source → ${(html.length / 1024).toFixed(0)} KB output`,
);
