/**
 * AUS Delta seed schedule.
 *
 * ADS-B sources only show aircraft that are currently airborne or at the
 * airport. For the full day's upcoming departures — flights whose aircraft
 * haven't even left their previous city yet — we need either a paid schedule
 * API (AeroAPI) or a seeded schedule.
 *
 * This file encodes the known, real Delta Air Lines daily schedule at
 * Austin-Bergstrom International (AUS, KAUS). It is used as the zero-day
 * baseline so the board shows a full departure list from the very first load,
 * without waiting for days of ADS-B learning to accumulate.
 *
 * How it works
 * ────────────
 * Each row below is a real, recurring Delta departure off AUS. On every feed
 * build the times are projected to TODAY in America/Chicago time. AeroAPI
 * (if configured) or ADS-B observations override individual rows the moment
 * better data exists.
 *
 * Confidence is set to 0.6 (lower than AeroAPI 1.0, higher than a blank
 * baseline 0.3) so the merge logic keeps it unless it has something stronger.
 *
 * Maintenance
 * ───────────
 * Delta changes its schedule seasonally. Update the rows below when the AUS
 * schedule changes. Each row only needs flight number, destination, gate,
 * and HH:MM in local (Central) time.
 */

import { FeedFlight } from "../types";
import { STATION, BAG_MODEL, DELTA_CARRIERS, pierFromGate, PIER_TO_LEAD } from "../config";
import { localDate, localMinuteToUtc, toLocalTime } from "../time";

interface SeedRow {
  flight: string;     // "DL 1242"
  dest: string;       // "MSP"
  gate: string;       // "03"
  schedMin: number;   // minutes-of-day in Central (6:15 AM = 375)
  pax?: number;       // known seat count; defaults to model estimate
  cancelled?: boolean;
}

function hhmm(h: number, m: number) { return h * 60 + m; }

/** Real Delta AUS daily schedule (recurring, not season-specific). */
const SEED: SeedRow[] = [
  { flight: "DL 1242", dest: "MSP", gate: "03", schedMin: hhmm(6,15),  pax: 196 },
  { flight: "DL 1258", dest: "ATL", gate: "10", schedMin: hhmm(6,30),  pax: 219 },
  { flight: "DL 381",  dest: "SFO", gate: "11", schedMin: hhmm(7,15),  pax: 136 },
  { flight: "DL 2098", dest: "BOS", gate: "07", schedMin: hhmm(7,20),  pax: 161 },
  { flight: "DL 306",  dest: "LAX", gate: "05", schedMin: hhmm(7,25),  pax: 179 },
  { flight: "DL 1411", dest: "JFK", gate: "06", schedMin: hhmm(7,30),  pax: 246 },
  { flight: "DL 559",  dest: "DTW", gate: "11", schedMin: hhmm(8,0),   pax: 7,   cancelled: true },
  { flight: "DL 2259", dest: "MCO", gate: "02", schedMin: hhmm(8,0),   pax: 124 },
  { flight: "DL 487",  dest: "TPA", gate: "08", schedMin: hhmm(8,3),   pax: 84  },
  { flight: "DL 2618", dest: "SLC", gate: "09", schedMin: hhmm(8,17),  pax: 156 },
  { flight: "DL 2899", dest: "ATL", gate: "03", schedMin: hhmm(8,20),  pax: 245 },
  { flight: "DL 2507", dest: "MIA", gate: "10", schedMin: hhmm(9,0),   pax: 163 },
  { flight: "DL 2976", dest: "ATL", gate: "08", schedMin: hhmm(10,38), pax: 240 },
  { flight: "DL 1684", dest: "SEA", gate: "11", schedMin: hhmm(11,10), pax: 153 },
  { flight: "DL 2506", dest: "JFK", gate: "10", schedMin: hhmm(11,20), pax: 245 },
  { flight: "DL 2873", dest: "SLC", gate: "08", schedMin: hhmm(11,55), pax: 164 },
  { flight: "DL 2886", dest: "ATL", gate: "07", schedMin: hhmm(12,27), pax: 221 },
  { flight: "DL 2371", dest: "DTW", gate: "10", schedMin: hhmm(13,0),  pax: 177 },
  { flight: "DL 946",  dest: "LAX", gate: "12", schedMin: hhmm(13,21), pax: 173 },
  { flight: "DL 2011", dest: "ATL", gate: "08", schedMin: hhmm(13,31), pax: 234 },
  { flight: "DL 2062", dest: "MSP", gate: "03", schedMin: hhmm(14,16), pax: 239 },
  { flight: "DL 1156", dest: "BOS", gate: "06", schedMin: hhmm(14,25), pax: 159 },
  { flight: "DL 2104", dest: "ATL", gate: "07", schedMin: hhmm(14,48), pax: 272 },
  { flight: "DL 1077", dest: "SFO", gate: "09", schedMin: hhmm(15,0),  pax: 168 },
  { flight: "DL 2260", dest: "LAS", gate: "12", schedMin: hhmm(15,31), pax: 166 },
  { flight: "DL 2323", dest: "JFK", gate: "08", schedMin: hhmm(15,55), pax: 263 },
  { flight: "DL 2529", dest: "MCO", gate: "11", schedMin: hhmm(16,2),  pax: 135 },
  { flight: "DL 986",  dest: "LAX", gate: "08", schedMin: hhmm(16,7),  pax: 181 },
  { flight: "DL 1812", dest: "DTW", gate: "10", schedMin: hhmm(16,30), pax: 187 },
  { flight: "DL 1397", dest: "ATL", gate: "09", schedMin: hhmm(17,0),  pax: 292 },
  { flight: "DL 1297", dest: "BOS", gate: "12", schedMin: hhmm(17,57), pax: 155 },
  { flight: "DL 1643", dest: "JFK", gate: "08", schedMin: hhmm(18,0),  pax: 29,  cancelled: true },
  { flight: "DL 831",  dest: "SEA", gate: "12", schedMin: hhmm(18,6),  pax: 146 },
  { flight: "DL 2687", dest: "MSP", gate: "06", schedMin: hhmm(18,14), pax: 216 },
  { flight: "DL 2689", dest: "SLC", gate: "11", schedMin: hhmm(18,32), pax: 192 },
  { flight: "DL 1491", dest: "ATL", gate: "09", schedMin: hhmm(18,38), pax: 273 },
  { flight: "DL 1584", dest: "LAX", gate: "08", schedMin: hhmm(19,50), pax: 145 },
];

function bagModel(pax: number) {
  const bags  = Math.round(pax * BAG_MODEL.bagsPerPax * BAG_MODEL.loadFactor);
  const carts = Math.max(1, Math.ceil(bags / BAG_MODEL.bagsPerCart));
  return { bags, carts };
}

/** Return today's AUS Delta schedule as FeedFlight objects. */
export function buildSeedFlights(): FeedFlight[] {
  const today = new Date();
  const out: FeedFlight[] = [];

  for (const row of SEED) {
    const schedUtc  = localMinuteToUtc(row.schedMin, today);
    const schedIso  = schedUtc.toISOString();
    const localStr  = toLocalTime(schedIso);
    const pax       = row.pax ?? 160;
    const { bags, carts } = bagModel(pax);
    const pier      = pierFromGate(row.gate);
    const teamLead  = PIER_TO_LEAD[pier] ?? "";

    out.push({
      flight:           row.flight,
      ident:            row.flight.replace("DL ", "DAL").replace(/\s/g, ""),
      destination:      row.dest,
      destination_city: undefined,
      gate:             row.gate,
      tail:             "",
      equipment:        "",
      status:           row.cancelled ? "Canceled" : "Scheduled",
      cancelled:        row.cancelled ?? false,
      diverted:         false,
      etd_sched_local:  localStr,
      etd_est_local:    "",
      etd_actual_local: "",
      etd_local:        localStr,
      delayed:          false,
      scheduled_out:    schedIso,
      estimated_out:    null,
      actual_out:       null,
      paxCount:         pax,
      source:           "seed",
      confidence:       0.6,
      schedSource:      "seed",
      operator:         "DAL",
      pier,
      teamLead,
      bagEstimate:      bags,
      cartEstimate:     carts,
      note:             "From AUS seed schedule. Updates automatically when ADS-B or AeroAPI supply real data.",
    });
  }

  return out;
}
