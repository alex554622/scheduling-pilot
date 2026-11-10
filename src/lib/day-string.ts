/**
 * Calendar-day helpers.
 *
 * Dates are counted in whole calendar days through UTC midnights, so a
 * daylight-saving change never adds or drops a day. Clock times are applied
 * afterwards, in local time, where DST belongs.
 */

/** A calendar day with no time and no timezone: "YYYY-MM-DD". */
export type DayString = string;

export function toDayString(d: Date): DayString {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight for a day string — the anchor for clock times. */
export function fromDayString(day: DayString): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Whole calendar days between two days, counted in UTC so DST cannot shift it. */
export function daysBetween(from: DayString, to: DayString): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const a = Date.UTC(y1, (m1 ?? 1) - 1, d1 ?? 1);
  const b = Date.UTC(y2, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.round((b - a) / 86_400_000);
}

export function addDays(day: DayString, n: number): DayString {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Every day of a month, in order. Handles short months and leap years. */
export function monthDays(year: number, month1to12: number): DayString[] {
  const days: DayString[] = [];
  const count = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let d = 1; d <= count; d++) days.push(`${year}-${pad(month1to12)}-${pad(d)}`);
  return days;
}

/**
 * The clock times for one worked day. Applied in local time, so a shift keeps
 * its wall-clock hours across a daylight-saving change; an end time at or
 * before the start runs into the next day.
 */
export function shiftTimes(
  day: DayString,
  start: string,
  end: string,
): { starts: Date; ends: Date } {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const starts = fromDayString(day);
  starts.setHours(sh ?? 0, sm ?? 0, 0, 0);
  const ends = fromDayString(day);
  ends.setHours(eh ?? 0, em ?? 0, 0, 0);
  if (ends.getTime() <= starts.getTime()) ends.setDate(ends.getDate() + 1);
  return { starts, ends };
}
