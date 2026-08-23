/**
 * Station, carrier and bag-room configuration for the Delta AUS bag room platform.
 *
 * This file is the single place to retune the platform for a different station,
 * carrier, gate layout or crew structure. Nothing below is hard-coded elsewhere.
 */

export const STATION = {
  iata: "AUS",
  icao: "KAUS",
  name: "Austin-Bergstrom International Airport",
  city: "Austin, TX",
  timezone: "America/Chicago",
  terminal: "Barbara Jordan Terminal",
  /** Bounding box for live ADS-B state-vector queries around the field. */
  bbox: { lamin: 29.95, lomin: -98.15, lamax: 30.45, lomax: -97.35 },
} as const;

/** Gate → make-up pier mapping. Mirrors the board's pierFromGate(). */
export function pierFromGate(gate: string | number | null | undefined): "A" | "B" | "C" | "D" | "" {
  const n = parseInt(String(gate ?? ""), 10);
  if (Number.isNaN(n)) return "";
  if (n >= 2 && n <= 4) return "A";
  if (n >= 5 && n <= 7) return "B";
  if (n >= 8 && n <= 9) return "C";
  if (n >= 10 && n <= 12) return "D";
  return "";
}

/** Pier → team lead initials. Mirrors the board's PIER_TO_LEAD. */
export const PIER_TO_LEAD: Record<string, string> = { A: "EP", B: "MS", C: "AM", D: "SR" };

/**
 * ICAO callsign prefixes. ADS-B reports ICAO callsigns (DAL1684), never IATA
 * flight numbers (DL1684) — this mapping is what turns raw ADS-B into Delta traffic.
 */
export type CarrierConfidence = "mainline" | "connection" | "candidate";

export interface CarrierDef {
  prefix: string;
  name: string;
  marketing: string;
  confidence: CarrierConfidence;
  /** Typical seat count, used for bag-count estimation when pax data is absent. */
  seats: number;
  /** Shared regionals only count as Delta when the other end is a Delta hub. */
  hubGated?: boolean;
}

export const DELTA_CARRIERS: CarrierDef[] = [
  { prefix: "DAL", name: "Delta Air Lines", marketing: "DL", confidence: "mainline", seats: 160 },
  { prefix: "EDV", name: "Endeavor Air (Delta Connection)", marketing: "DL", confidence: "connection", seats: 76 },
  { prefix: "SKW", name: "SkyWest", marketing: "DL", confidence: "candidate", seats: 76, hubGated: true },
  { prefix: "RPA", name: "Republic Airways", marketing: "DL", confidence: "candidate", seats: 76, hubGated: true },
  { prefix: "GJS", name: "GoJet Airlines", marketing: "DL", confidence: "candidate", seats: 70, hubGated: true },
];

/** Delta hubs / focus cities (ICAO). Gates the shared regional operators. */
export const DELTA_HUBS = new Set([
  "KATL", "KDTW", "KMSP", "KSLC", "KLAX", "KJFK", "KLGA", "KSEA", "KBOS", "KCVG", "KRDU",
]);

/** ICAO → IATA for the destinations AUS actually sees on Delta metal. */
export const ICAO_TO_IATA: Record<string, string> = {
  KATL: "ATL", KDTW: "DTW", KMSP: "MSP", KSLC: "SLC", KLAX: "LAX", KJFK: "JFK",
  KLGA: "LGA", KSEA: "SEA", KBOS: "BOS", KCVG: "CVG", KRDU: "RDU", KAUS: "AUS",
  KMCO: "MCO", KSFO: "SFO", KDFW: "DFW", KIAH: "IAH", KORD: "ORD", KDEN: "DEN",
  KPHX: "PHX", KLAS: "LAS", KSAN: "SAN", KEWR: "EWR", KCLT: "CLT", KBNA: "BNA",
};

/** Outbound bag-room operating assumptions. Tune to your station's actuals. */
export const BAG_MODEL = {
  /** Average checked bags per passenger on a domestic Delta segment. */
  bagsPerPax: 0.62,
  /** Assumed load factor when live pax counts are unavailable. */
  loadFactor: 0.85,
  /** Bags per cart used to size the cart pull. */
  bagsPerCart: 40,
  /** Minutes before ETD that the bag cutoff falls (board default: 45). */
  cutoffBufferMinutes: 45,
  /** Minutes before ETD the exit scan should be complete. */
  exitScanMinutes: 55,
  /** Minutes of concurrent-departure window used for pier congestion. */
  congestionWindowMinutes: 20,
  /** Concurrent departures on one pier before it is called congested. */
  pierCongestionThreshold: 3,
  /** Minutes of work to strip a cancelled flight's bags back off the cart. */
  cancellationRecoveryMinutes: 45,
} as const;

/** Disruption-detection tuning for the learned-schedule engine. */
export const DETECTION = {
  /** A learned slot needs at least this many prior sightings to be trusted. */
  minObservations: 3,
  /** How many same-weekday occurrences the learner looks back over. */
  lookbackWeeks: 4,
  /** Minutes past the expected time before a missing slot is flagged. */
  graceMinutes: 75,
  /** Minutes of spread allowed when matching an observation to a learned slot. */
  slotToleranceMinutes: 45,
  /** Minutes late before a departure is called delayed. */
  delayThresholdMinutes: 15,
} as const;

export const POLL = {
  /** Lookback per OpenSky flights query. Anonymous access rejects windows > ~6h. */
  windowSeconds: 6 * 3600,
  /** Snapshots retained in the store (~7 days at a 5-minute cadence). */
  retainSnapshots: 2016,
  /** Board-facing feed cache, seconds. */
  feedCacheSeconds: 60,
} as const;

export function carrierForCallsign(callsign: string): CarrierDef | undefined {
  const cs = callsign.trim().toUpperCase();
  return DELTA_CARRIERS.find((c) => cs.startsWith(c.prefix));
}

export function toIata(icao?: string | null): string {
  if (!icao) return "";
  return ICAO_TO_IATA[icao] ?? icao.replace(/^K/, "");
}
