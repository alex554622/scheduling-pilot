/**
 * The scheduling pattern engine.
 *
 * A template describes a repeating cycle of work and off days — 3 on / 4 off /
 * 4 on / 3 off, 4 on / 4 off, Monday to Friday, 24 on / 48 off — and nothing
 * about any particular department. Everything here is generic: the patrol
 * rotation is simply one pattern array among many.
 *
 * Two rules the rest of the app depends on:
 *
 * 1. The cycle runs from the template's anchor date and never restarts. Not on
 *    the 1st of a month, not on the 15th, not on new year's day, and not when
 *    someone changes which day their work week starts on. Those are ways of
 *    *displaying* a schedule; the rotation underneath keeps counting.
 * 2. Dates are counted in whole calendar days through UTC midnights, so a
 *    daylight-saving change never adds or drops a day. Clock times are applied
 *    afterwards, in local time, where DST belongs.
 */

/** A calendar day with no time and no timezone: "YYYY-MM-DD". */
export type DayString = string;

export interface TemplateTeam {
  id?: string;
  name: string;
  /** "HH:MM" local. An end at or before the start finishes the next day. */
  shift_start: string;
  shift_end: string;
  /** How far into the cycle this team starts, in days. */
  pattern_offset: number;
  sort_order: number;
}

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

/**
 * Where `date` falls in the cycle, 0-based. The anchor date is cycle day 0 —
 * "Pattern Day 1" as an admin sees it — and a team's offset moves that team
 * that many days further along the same pattern.
 */
export function cycleDay(
  anchor: DayString,
  date: DayString,
  patternLength: number,
  offset = 0,
): number {
  const len = Math.max(1, Math.trunc(patternLength));
  const raw = daysBetween(anchor, date) + Math.trunc(offset || 0);
  return ((raw % len) + len) % len;
}

/** Whether this team works on this date. */
export function isWorkDay(
  pattern: boolean[],
  anchor: DayString,
  date: DayString,
  offset = 0,
): boolean {
  if (!pattern.length) return false;
  return pattern[cycleDay(anchor, date, pattern.length, offset)] === true;
}

/** Every day of a month, in order. Handles short months and leap years. */
export function monthDays(year: number, month1to12: number): DayString[] {
  const days: DayString[] = [];
  const count = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let d = 1; d <= count; d++) days.push(`${year}-${pad(month1to12)}-${pad(d)}`);
  return days;
}

export interface MonthPeriod {
  label: string;
  days: DayString[];
}

/**
 * A month split for display: two fortnights and whatever is left over. These
 * are reporting groups only — the cycle itself is untouched by them, which is
 * why nothing here looks at the pattern.
 */
export function monthPeriods(year: number, month1to12: number): MonthPeriod[] {
  const days = monthDays(year, month1to12);
  const periods: MonthPeriod[] = [
    { label: "Biweekly period 1", days: days.slice(0, 14) },
    { label: "Biweekly period 2", days: days.slice(14, 28) },
  ];
  const rest = days.slice(28);
  if (rest.length) periods.push({ label: "Remaining days", days: rest });
  return periods.filter((p) => p.days.length > 0);
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

/** Day-of-week column order for a display that starts the week on `startDay` (0 = Sunday). */
export function weekColumnOrder(startDay: number): number[] {
  const s = ((Math.trunc(startDay) % 7) + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => (s + i) % 7);
}

/** "3 work, 4 off, 4 work, 3 off" — a pattern read back in plain words. */
export function describePattern(pattern: boolean[]): string {
  if (!pattern.length) return "No pattern";
  const runs: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const value = pattern[i];
    let n = 0;
    while (i < pattern.length && pattern[i] === value) {
      n++;
      i++;
    }
    runs.push(`${n} ${value ? "work" : "off"}`);
  }
  return runs.join(", ");
}

/** The patrol rotation the app ships with: 3 work, 4 off, 4 work, 3 off. */
export const PATROL_3443: boolean[] = [
  true,
  true,
  true,
  false,
  false,
  false,
  false,
  true,
  true,
  true,
  true,
  false,
  false,
  false,
];
