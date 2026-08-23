# AUS Delta Bag Room — Live Ops Platform

A Vercel-deployable Next.js app that feeds the Austin (AUS) Delta bag room board with **real** flight data, tracks disruption, and writes shift reports on its own.

It replaces two things from the old package: the Cloudflare Worker (now a Next.js API route) and the board's baked-in demo flights (now gone — the board comes up empty and fills from the live feed).

---

## What's in the box

| Path | What it is |
|---|---|
| `/` | Ops console — source health, learned-schedule maturity, pier load, the feed URL to hand out |
| `/board` | The bag room board itself, demo data stripped, self-configuring |
| `/api/feed` | Board-compatible live departures feed. **This is the URL the board wants.** |
| `/api/health` | One call that tells you whether everything actually works |
| `/api/nas` | FAA ground stops / ground delay programs affecting AUS and its Delta destinations |
| `/api/analysis` | Current bag room analysis as JSON |
| `/api/ingest` | Where the board pushes its workflow state |
| `/api/reports` | List reports · `POST` to generate one |
| `/api/reports/{id}?format=html` | A printable report |
| `/api/cron/poll` | Heartbeat: learn the schedule, snapshot state |
| `/api/cron/report` | Build and store a report |

---

## Deploy in five minutes

```bash
git add -A && git commit -m "AUS bag room platform"
gh repo create aus-bagroom --private --source=. --push   # or push to a repo you made in the UI

npm i -g vercel
vercel --prod
```

Then open the deployment. The console shows two links:

* the **feed URL** (`https://…/api/feed`) — paste into the board under Ops Entry → Settings → Live Data Feed URL
* a **self-configuring board link** — send it to the team; the first open saves the feed on that device, and `https://…/board` works plain afterwards

If you use the bundled `/board`, you don't even need that: it points at its own deployment automatically.

---

## Read this before you trust a cancellation

You picked **OpenSky** as the data source. It is genuinely free and genuinely live — the platform is pulling real Delta departures off Austin right now. But it is an **ADS-B network, not an airline feed**, and that has a hard consequence:

> **OpenSky has no schedules, no gates, and no cancellation field.**
> A cancelled flight doesn't appear as cancelled. It simply never appears.

So the platform does the only honest thing available:

1. **It learns your schedule.** Every observed departure teaches it that, say, `DAL1684` leaves AUS around 07:42 on Tuesdays. After a week or so of polling, the station's own operating pattern *is* the schedule.
2. **It flags gaps, not facts.** When a learned slot is past its grace window and no ADS-B departure was seen, the row is marked **`Suspected Cancel`** — never `cancelled: true`. It carries a confidence score and a note saying how many prior observations back it and how late it is.
3. **It never lets inference outrank observation.** A real departure seen on ADS-B always beats a guess.

**What you give up without a schedule source:** gate numbers (so pier and team-lead auto-assignment stays blank), published scheduled times for flights the platform has not yet observed, and any authoritative cancellation flag.

**How to get all of that back:** set `AEROAPI_KEY`. FlightAware AeroAPI is the only source here with real `cancelled` flags, gates and published times; its Personal tier includes a monthly usage credit. The driver is already written and dark — one env var and it becomes primary, with OpenSky dropping to a cross-check role. Nothing else changes.

The console, `/api/feed?verbose=1`, and every generated report state this in plain language wherever inference is involved. That is deliberate: a bag room that pulls bags off a flight because a dashboard guessed wrong is worse off than one with no dashboard.

---

## Environment

Everything is optional; see `.env.example` for the annotated list.

| Variable | Why you want it |
|---|---|
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | **Strongly recommended.** Anonymous OpenSky gets 400 API credits/day and starts returning 503 well before that in practice. An account raises it to 4,000. Free: register at opensky-network.org → Account → API Clients. |
| `AEROAPI_KEY` | Real cancellations, gates and schedules (see above) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | **Recommended.** Without a store, the learned schedule and all report history live in one lambda's memory and vanish on recycle. Add Vercel KV from the Marketplace (Upstash) and these appear automatically. |
| `POLL_ARRIVALS` | `1` to also track inbound aircraft. Doubles credit use — turn on only after the OpenSky credentials are set. |
| `CRON_SECRET` | Protects `/api/cron/*` and `/api/ingest` |

---

## Scheduling — the Vercel Hobby catch

Vercel's Hobby plan allows **2 cron jobs, once per day each**. A `*/5` schedule is rejected at deploy time. So:

* **`vercel.json` ships Hobby-safe** — one daily poll, one daily report.
* **The board is the real poller.** Every `/api/feed` build folds what it just fetched into the learned schedule, throttled to once a minute per instance. With boards refreshing every 120 seconds on the floor, the schedule learns itself during operating hours with no cron at all.
* **On Vercel Pro**, `mv vercel.pro.json vercel.json` and redeploy for a 5-minute poll and per-shift reports.
* **Staying on Hobby but want a real interval?** Two GitHub Actions workflows are included (`.github/workflows/poll.yml`, `report.yml`). Set repo secrets `PLATFORM_URL` and `CRON_SECRET`. Note that on a *private* repo a 15-minute schedule exceeds the free Actions minutes — make the repo public, widen the interval, or point a free pinger such as cron-job.org at `/api/cron/poll`.

---

## Automated reports

Reports are built from the day's poll snapshots plus whatever the board has pushed to `/api/ingest`, and stored as JSON with a printable HTML rendering.

Each one carries: the departure picture, a written narrative, pier load with peak windows, disrupted flights with their evidential basis, FAA exposure, measured bag room performance (cart-out against the 45-minute bag cutoff, on-time share, missing bags, per-lead breakdown), a timeline, and an explicit caveats block.

Generate one now:

```bash
curl -X POST https://your-app.vercel.app/api/reports \
     -H 'Content-Type: application/json' -d '{"shift":"AM"}'
```

**The ops half depends on ingest.** The board keeps its workflow in each device's `localStorage`. The bundled `/board` posts it up every five minutes so reports can measure the bag room and not just the airline. If you host the board elsewhere, run it through `scripts/build-board.mjs` or add the same POST yourself — otherwise reports will say, accurately, that no ops data was received.

### Protecting the endpoints

Setting `CRON_SECRET` locks `/api/cron/*` **and** `/api/ingest`. The board can't hold a secret (it is public HTML), so if you set one, either front the board with an authenticated proxy or accept that ops sync stops. For a deployment behind Vercel's own protection, leaving `CRON_SECRET` unset is reasonable.

---

## Rebuilding the board

`public/board.html` is generated, not hand-edited:

```bash
npm run build-board            # or: node scripts/build-board.mjs path/to/source.html
```

The source of record is `board/source/Delta_AUS_Bagroom_Operations_LIVE_Mobile.html`. The script makes exactly three changes — clears `DEFAULT_FLIGHTS` and `DEFAULT_HANDOFF`, points the feed at the deployment's own origin, and injects the ops sync — so the board stays the file the team already knows. Drop in a newer board revision and re-run.

---

## Tuning it to your station

`src/lib/config.ts` is the only file you should need:

* `STATION` — airport, timezone, bounding box
* `pierFromGate` / `PIER_TO_LEAD` — gate → pier → lead, mirroring the board
* `DELTA_CARRIERS` — which ICAO callsign prefixes count as Delta. `SKW`, `RPA` and `GJS` fly for several mainlines, so they are `hubGated`: counted only when the other end is a Delta hub.
* `BAG_MODEL` — bags per passenger, load factor, bags per cart, the 45-minute cutoff
* `DETECTION` — how many sightings a slot needs before it is trusted, and how overdue is overdue

---

## Local development

```bash
npm install
npm run dev          # http://localhost:3000
npm run build-board  # regenerate public/board.html
```

## Honest limits

* **Bag and cart numbers are modelled**, from seat counts and an assumed load factor — not from BSM/BPM data. They size the work; they are not a bag count.
* **Destinations fill in late.** OpenSky only resolves a flight's arrival airport after it lands, so a just-departed flight shows a blank destination until either the baseline has learned that route or AeroAPI is configured.
* **The learned schedule needs about a week** before suspected-cancellation detection is dependable. The console tells you exactly where it stands.
* **Not affiliated with Delta Air Lines.** Flight data comes from the OpenSky Network, the FAA NAS Status service, and optionally FlightAware.
