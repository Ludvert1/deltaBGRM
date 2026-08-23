/** Shared types for the Delta AUS bag room platform. */

export type FlightStatus =
  | "Scheduled"
  | "Delayed"
  | "Departed"
  | "Canceled"
  | "Suspected Cancel"
  | "Diverted";

export type SourceId = "aeroapi" | "opensky" | "seed" | "baseline" | "manual";

/**
 * A single departure as the bag room board consumes it.
 *
 * Field names intentionally match the board's fetchLiveFeed() reader so the
 * board needs no changes to accept this feed.
 */
export interface FeedFlight {
  /** "DL 1242" — display form. */
  flight: string;
  /** ICAO callsign when known ("DAL1242"). */
  ident?: string;
  destination: string;
  destination_city?: string;
  gate: string;
  terminal?: string;
  tail: string;
  equipment: string;
  status: FlightStatus;
  cancelled: boolean;
  diverted: boolean;

  /** Local (America/Chicago) display strings — what the board renders. */
  etd_sched_local: string;
  etd_est_local: string;
  etd_actual_local: string;
  etd_local: string;
  delayed: boolean;

  /** Raw ISO UTC — for sorting and math only, never displayed. */
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;

  /** Estimated passengers, used for bag math when no live pax count exists. */
  paxCount: number;

  /* ——— platform extensions (ignored by the board, used by analytics) ——— */
  /** Which provider supplied this record. */
  source: SourceId;
  /** 0–1. How much to trust this row; baseline-derived rows score lower. */
  confidence: number;
  /** Operating carrier ICAO prefix, e.g. "DAL", "EDV". */
  operator?: string;
  /** Make-up pier derived from the gate. */
  pier?: string;
  /** Team lead derived from the pier. */
  teamLead?: string;
  /** Estimated checked bags for this departure. */
  bagEstimate?: number;
  /** Estimated carts required. */
  cartEstimate?: number;
  /**
   * Which source supplied `scheduled_out`. On-time performance is only ever
   * measured against a published or pasted schedule — never against a time
   * derived from the aircraft's own movement, which would always score 100%.
   */
  schedSource?: SourceId;
  /** Human-readable note explaining a suspected cancel or inference. */
  note?: string;
}

export interface FeedResponse {
  airport: string;
  timezone: string;
  generated_at: string;
  generated_at_local: string;
  count: number;
  /** Key the board reads first. */
  scheduled_departures: FeedFlight[];
  /** Flat alias the board also accepts. */
  flights: FeedFlight[];
  sources: SourceStatus[];
  nas?: NasSummary | null;
  degraded: boolean;
  warnings: string[];
}

export interface SourceStatus {
  id: SourceId | "faa";
  ok: boolean;
  label: string;
  detail: string;
  latencyMs?: number;
  count?: number;
}

/* ——— FAA National Airspace System status ——— */

export interface NasProgram {
  airport: string;
  kind: "Ground Stop" | "Ground Delay" | "Arrival Delay" | "Departure Delay" | "Closure";
  reason: string;
  avg?: string;
  max?: string;
  endTime?: string;
}

export interface NasSummary {
  updatedAt: string;
  /** Programs affecting AUS itself. */
  local: NasProgram[];
  /** Programs at AUS's Delta destinations — these strand outbound bags. */
  network: NasProgram[];
  fetchedAt: string;
}

/* ——— Learned schedule baseline ——— */

export interface BaselineSlot {
  /** ICAO callsign, e.g. "DAL1684". */
  callsign: string;
  /** 0=Sunday … 6=Saturday, in station local time. */
  dow: number;
  /** Minutes after local midnight of the typical departure. */
  minuteOfDay: number;
  /** Sightings backing this slot. */
  observations: number;
  /** Standard deviation of the observed departure minute. */
  spread: number;
  destination: string;
  operator: string;
  lastSeen: string;
  firstSeen: string;
}

export interface Baseline {
  version: 1;
  updatedAt: string;
  slots: BaselineSlot[];
  /** Distinct local dates that contributed observations. */
  observedDays: string[];
}

/* ——— Snapshots and ops ingest ——— */

export interface Snapshot {
  at: string;
  flights: FeedFlight[];
  nas: NasSummary | null;
  counts: {
    total: number;
    departed: number;
    delayed: number;
    cancelled: number;
    suspected: number;
  };
}

/** One row as the board holds it, POSTed to /api/ingest. */
export interface OpsFlight {
  flight: string;
  tail?: string;
  sched?: string;
  eta?: string;
  gate?: string;
  dest?: string;
  carts?: string;
  pierSide?: string;
  teamLead?: string;
  bagroomAgent?: string;
  exitScanAgent?: string;
  deliveryAgent?: string;
  cartOutActual?: string;
  delayReason?: string;
  missingBags?: number;
  rerouteNotes?: string;
  status?: string;
  /** Every step the board recorded: what, when, by whom, employee id. */
  statusHistory?: { status: string; at: string; by?: string; empId?: string }[];
  /** Local time carts actually left the bag room, e.g. "5:27 AM". */
  gateArrivalTime?: string;
  equipment?: string;
  paxCount?: number;
}

export interface OpsIngest {
  station: string;
  postedAt: string;
  device?: string;
  flights: OpsFlight[];
}

/* ——— Seeded schedule (from the board's pasted departure list) ——— */

export interface SeededSlot {
  /** "DL 1242" */
  flight: string;
  /** Minutes after local midnight of the scheduled departure. */
  minuteOfDay: number;
  gate: string;
  destination: string;
  equipment: string;
  /** Seats assumed for this gauge, used for bag estimation. */
  seats: number;
  /** 0=Sunday … 6=Saturday, station local. */
  dow: number;
  updatedAt: string;
}

export interface SeededSchedule {
  date: string;
  updatedAt: string;
  slots: SeededSlot[];
}

/* ——— Step timing and accountability ——— */

export interface StepRecord {
  status: string;
  label: string;
  /** ISO timestamp the step was recorded. */
  at: string | null;
  /** Local display time, e.g. "5:27 AM". */
  atLocal: string;
  /** Initials of whoever pressed the button. */
  by: string;
  /** Employee id captured alongside the initials. */
  empId: string;
  /** Minutes before ETD this step was completed (negative = after ETD). */
  minutesBeforeEtd: number | null;
  /** The target for this step on this flight. */
  targetMinutesBeforeEtd: number;
  /** Positive = ahead of target, negative = late. */
  varianceMinutes: number | null;
  /** Minutes since the previous completed step. */
  durationFromPreviousMinutes: number | null;
  late: boolean;
  missing: boolean;
}

export interface FlightStepAnalysis {
  flight: string;
  destination: string;
  gate: string;
  pier: string;
  teamLead: string;
  scheduledLocal: string;
  etdLocal: string;
  /** When carts had to leave the bag room: ETD − cutoff − pier transit. */
  cartDepartByLocal: string;
  cartTransitMinutes: number;
  steps: StepRecord[];
  /** Actual off-blocks from ADS-B, when the platform saw it. */
  actualDepartureLocal: string | null;
  /** Minutes late off the scheduled time. Negative = early. */
  departureDelayMinutes: number | null;
  onTime: boolean | null;
  /** The step the evidence points at when the departure went late. */
  fault: {
    step: string;
    label: string;
    owner: string;
    lateByMinutes: number;
    explanation: string;
  } | null;
  /** Set when the record cannot support an attribution. */
  inconclusive: string | null;
}

export interface OtdSummary {
  measured: number;
  onTime: number;
  late: number;
  percent: number | null;
  averageDelayMinutes: number | null;
  /** How many late departures the bag chain appears responsible for. */
  bagRoomAttributable: number;
  /** Late departures where the bag chain was demonstrably clean. */
  notBagRoom: number;
  inconclusive: number;
  byStep: { step: string; label: string; count: number; owner: string }[];
  byEmployee: {
    initials: string;
    empId: string;
    steps: number;
    lateSteps: number;
    faultedDepartures: number;
  }[];
}
