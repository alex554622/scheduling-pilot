/**
 * Copy and paste for schedules.
 *
 * A copy keeps shifts relative to the start of whatever was copied — day 0,
 * day 1, minutes past midnight, how long it runs — so the same clipboard can
 * be pasted onto a different day, a different week, a different month, or onto
 * a different person, and land correctly every time.
 *
 * It lives in localStorage rather than React state so it survives moving
 * between the schedule builder and the monthly sheet, and a custom event keeps
 * both screens showing the same clipboard in the same tab.
 */
import { addDays, daysBetween, fromDayString, type DayString } from "@/lib/schedule-pattern";

const KEY = "sp-schedule-clipboard";
const EVENT = "sp-schedule-clipboard-change";

export interface ClipboardShift {
  employee_id: string | null;
  position: string;
  color: string;
  /** Days from the start of the copied range. */
  dayOffset: number;
  /** Local minutes past midnight, and how long the shift runs. */
  startMinutes: number;
  durationMinutes: number;
}

export type ClipboardScope = "day" | "week" | "month" | "range" | "person";

export interface ScheduleClipboard {
  label: string;
  scope: ClipboardScope;
  /** Set when the copy was one person's shifts, so a paste can re-target it. */
  singleEmployee: string | null;
  dayCount: number;
  shifts: ClipboardShift[];
  copiedAt: number;
}

export interface SourceShift {
  employee_id: string | null;
  position: string;
  color: string;
  starts_at: string;
  ends_at: string;
}

/** Encode real shifts against the first day of the range they came from. */
export function encodeShifts(shifts: SourceShift[], rangeStart: DayString): ClipboardShift[] {
  const startOfRange = fromDayString(rangeStart).getTime();
  return shifts
    .map((s) => {
      const starts = new Date(s.starts_at);
      const ends = new Date(s.ends_at);
      const dayStart = new Date(starts);
      dayStart.setHours(0, 0, 0, 0);
      return {
        employee_id: s.employee_id,
        position: s.position,
        color: s.color,
        dayOffset: Math.round((dayStart.getTime() - startOfRange) / 86_400_000),
        startMinutes: starts.getHours() * 60 + starts.getMinutes(),
        durationMinutes: Math.max(1, Math.round((ends.getTime() - starts.getTime()) / 60_000)),
      };
    })
    .sort((a, b) => a.dayOffset - b.dayOffset || a.startMinutes - b.startMinutes);
}

export interface PasteRow {
  company_id: string;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string;
  color: string;
  published: boolean;
}

/**
 * Turn a clipboard into rows ready to insert, anchored on `targetStart`.
 * `employeeOverride` re-targets every shift onto one person, which is what a
 * paste into somebody's row means.
 */
export function materialize(
  clip: ScheduleClipboard,
  targetStart: DayString,
  companyId: string,
  employeeOverride?: string | null,
): PasteRow[] {
  return clip.shifts.map((s) => {
    const day = addDays(targetStart, s.dayOffset);
    const starts = fromDayString(day);
    starts.setMinutes(s.startMinutes);
    const ends = new Date(starts.getTime() + s.durationMinutes * 60_000);
    return {
      company_id: companyId,
      employee_id: employeeOverride !== undefined ? employeeOverride : s.employee_id,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      position: s.position,
      color: s.color,
      // A pasted schedule is a draft until someone publishes it, the same as
      // one built by hand.
      published: false,
    };
  });
}

/** Rows that already exist at the target, so a double paste doesn't duplicate. */
export function dropDuplicates(rows: PasteRow[], existing: SourceShift[]): PasteRow[] {
  const seen = new Set(
    existing.map(
      (e) => `${e.employee_id ?? "open"}|${e.position}|${new Date(e.starts_at).getTime()}`,
    ),
  );
  return rows.filter(
    (r) => !seen.has(`${r.employee_id ?? "open"}|${r.position}|${new Date(r.starts_at).getTime()}`),
  );
}

export function readClipboard(): ScheduleClipboard | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScheduleClipboard;
    return Array.isArray(parsed?.shifts) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeClipboard(clip: ScheduleClipboard): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(clip));
  } catch {
    /* private mode — the copy just won't outlive this page */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function clearClipboard(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to clipboard changes, in this tab and in others. */
export function subscribeClipboard(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** "3 shifts · week of Sep 7" — what the paste button should say it will do. */
export function describeClipboard(clip: ScheduleClipboard | null): string {
  if (!clip) return "Nothing copied yet";
  const n = clip.shifts.length;
  return `${n} shift${n === 1 ? "" : "s"} · ${clip.label}`;
}

/** How many days a copied range covered, for a friendly warning on paste. */
export function clipboardSpan(clip: ScheduleClipboard): number {
  return Math.max(clip.dayCount, ...clip.shifts.map((s) => s.dayOffset + 1), 1);
}

export { daysBetween };
