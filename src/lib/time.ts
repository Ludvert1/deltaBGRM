import { STATION } from "./config";

const TZ = STATION.timezone;

/** UTC ISO → "6:15 AM" in station local time. DST-safe. */
export function toLocalTime(iso?: string | null, withDate = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  if (withDate) {
    opts.month = "short";
    opts.day = "numeric";
  }
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

/** Local calendar date at the station, "2026-08-23". */
export function localDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Parts of a Date expressed in station local time. */
export function localParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(p.hour) % 24; // Intl can emit "24" at midnight
  return {
    dow: dowMap[p.weekday] ?? 0,
    hour,
    minute: Number(p.minute),
    minuteOfDay: hour * 60 + Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/**
 * Build a UTC instant for "today at HH:MM station-local".
 * Works across DST by probing the offset at the target instant.
 */
export function localMinuteToUtc(minuteOfDay: number, ref: Date = new Date()): Date {
  const dateStr = localDate(ref);
  const [y, m, d] = dateStr.split("-").map(Number);
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  // First guess: treat local wall time as UTC, then correct by the real offset.
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMinutes(new Date(guess));
    const corrected = Date.UTC(y, m - 1, d, hh, mm) - offset * 60_000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/** Station UTC offset in minutes at a given instant (e.g. -300 for CDT). */
export function tzOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 60_000);
}

export function nowIso(): string {
  return new Date().toISOString();
}
