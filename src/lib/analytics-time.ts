/**
 * The board speaks in local wall-clock strings ("6:15 AM"). These two helpers
 * are the only bridge between that and minutes-after-midnight arithmetic, and
 * they live in their own module so both the analytics and schedule layers can
 * use them without importing each other.
 */

/** "6:15 AM" → minutes after local midnight. Returns null on anything else. */
export function parseBoardTime(s?: string | null): number | null {
  if (!s) return null;
  const m = String(s).trim().toUpperCase().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3];
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes after local midnight → "6:15 AM". Wraps across midnight. */
export function formatBoardTime(minuteOfDay: number): string {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return `${h12}:${mm} ${ampm}`;
}
