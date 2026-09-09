/**
 * Who is overdue for a break.
 *
 * Derived from the punch history rather than stored, so it needs no background
 * job: an employee is flagged once they have been on the clock longer than the
 * company's rule without a break, and the flag disappears the moment they take
 * one. A manager's dismissal is pinned to the stretch it was made in, so it
 * silences the current alert without muting the next one.
 */

export type ReminderKind = "break" | "lunch";

export interface ReminderPunch {
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  break_minutes: number | null;
}

export interface ReminderDismissal {
  user_id: string;
  kind: ReminderKind;
  stretch_start: string;
}

export interface BreakAlert {
  kind: ReminderKind;
  /** When the current unbroken stretch began — the anchor a dismissal pins to. */
  stretchStart: number;
  /** How long they've been going without one. */
  workedMs: number;
  message: string;
}

/** A 10-minute break is the paid one; anything longer counts as lunch. */
const LUNCH_MINUTES = 30;

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Walk one employee's day and find where each kind of break last ended.
 *
 * Returns null for someone who isn't currently clocked in — you can't be overdue
 * for a break when you aren't working.
 */
function currentStretch(punches: ReminderPunch[], now: number) {
  let clockedInAt: number | null = null;
  let onBreak = false;
  let lastAnyBreakEnd: number | null = null;
  let lastLunchEnd: number | null = null;

  for (const p of [...punches].sort((a, b) => a.at.localeCompare(b.at))) {
    const at = new Date(p.at).getTime();
    if (at > now) continue;
    if (p.kind === "in") {
      clockedInAt = at;
      onBreak = false;
      // A fresh shift starts both clocks over.
      lastAnyBreakEnd = null;
      lastLunchEnd = null;
    } else if (p.kind === "out") {
      clockedInAt = null;
      onBreak = false;
    } else if (p.kind === "break_start") {
      if (clockedInAt != null) onBreak = true;
    } else if (p.kind === "break_end") {
      if (clockedInAt != null) {
        onBreak = false;
        lastAnyBreakEnd = at;
        if ((p.break_minutes ?? 0) >= LUNCH_MINUTES) lastLunchEnd = at;
      }
    }
  }

  if (clockedInAt == null) return null;
  return { clockedInAt, onBreak, lastAnyBreakEnd, lastLunchEnd };
}

/**
 * The alerts for one employee, worst first. Someone on a break right now is
 * never flagged — they are doing the thing the reminder would ask for.
 */
export function breakAlertsFor(
  punches: ReminderPunch[],
  rules: { break_reminder_hours: number; lunch_reminder_hours: number },
  dismissals: ReminderDismissal[],
  now: number = Date.now(),
): BreakAlert[] {
  const stretch = currentStretch(punches, now);
  if (!stretch || stretch.onBreak) return [];

  const alerts: BreakAlert[] = [];

  const consider = (kind: ReminderKind, hours: number, since: number | null, label: string) => {
    if (!hours || hours <= 0) return;
    const stretchStart = since ?? stretch.clockedInAt;
    const workedMs = now - stretchStart;
    if (workedMs < hours * 3_600_000) return;

    // A dismissal only counts for the stretch it was made in. Once a break moves
    // the anchor forward, the old dismissal no longer matches and the flag
    // returns — which is also how "taking a break clears it" works.
    const dismissed = dismissals.some(
      (d) => d.kind === kind && Math.abs(new Date(d.stretch_start).getTime() - stretchStart) < 1000,
    );
    if (dismissed) return;

    alerts.push({
      kind,
      stretchStart,
      workedMs,
      message: `${label} — ${fmtDuration(workedMs)} since ${since ? "their last one" : "clocking in"}`,
    });
  };

  consider("lunch", rules.lunch_reminder_hours, stretch.lastLunchEnd, "No lunch break");
  consider("break", rules.break_reminder_hours, stretch.lastAnyBreakEnd, "No break");

  // Lunch is the more serious of the two, so it leads.
  return alerts.sort((a, b) => b.workedMs - a.workedMs);
}
