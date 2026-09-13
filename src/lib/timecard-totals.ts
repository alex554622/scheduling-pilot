/**
 * Worked time per person, for the roster-wide timecard view.
 *
 * The rules match a single timecard exactly, because the two are read side by
 * side and any difference between them reads as a bug: an unpaid break comes
 * off the shift, a 10-minute break is paid and does not, and a shift with no
 * clock-out contributes nothing until someone closes it.
 */

export type PunchKind = "in" | "out" | "break_start" | "break_end";

export interface SimplePunch {
  user_id: string;
  kind: PunchKind;
  at: string;
  break_minutes: number | null;
}

/** One clock-in to clock-out. `outAt` is null while someone is still on the clock. */
export interface ShiftSpan {
  inAt: string;
  outAt: string | null;
  /** Clock-out minus clock-in, breaks included. */
  grossMs: number;
  /** What gets paid: gross less unpaid break time. */
  workedMs: number;
}

/** A person's day, expanded under their row in the roster-wide table. */
export interface DayDetail {
  /** `Date.toDateString()` — stable, and how the punches were grouped. */
  key: string;
  /** Midnight local on that day, for sorting and formatting. */
  date: Date;
  spans: ShiftSpan[];
  grossMs: number;
  workedMs: number;
  unpaidMs: number;
  paidMs: number;
}

export interface PersonTotals {
  /** Clock time, breaks included — what a wall clock would have shown. */
  grossMs: number;
  workedMs: number;
  unpaidMs: number;
  paidMs: number;
  /** One entry per day with punches — what the overtime split reads. */
  dayTotals: number[];
  /** The same days, with their punch times, oldest first. */
  days: DayDetail[];
}

export function totalsByPerson(punches: SimplePunch[]): Map<string, PersonTotals> {
  const byUser = new Map<string, Map<string, SimplePunch[]>>();
  for (const p of punches) {
    const day = new Date(p.at).toDateString();
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, new Map());
    const days = byUser.get(p.user_id)!;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(p);
  }

  const out = new Map<string, PersonTotals>();
  for (const [userId, days] of byUser) {
    const totals: PersonTotals = {
      grossMs: 0,
      workedMs: 0,
      unpaidMs: 0,
      paidMs: 0,
      dayTotals: [],
      days: [],
    };
    for (const [key, list] of days) {
      const ordered = [...list].sort((a, b) => a.at.localeCompare(b.at));
      const detail: DayDetail = {
        key,
        date: new Date(key),
        spans: [],
        grossMs: 0,
        workedMs: 0,
        unpaidMs: 0,
        paidMs: 0,
      };
      let dayMs = 0;
      let openIn: SimplePunch | null = null;
      let openBreak: SimplePunch | null = null;
      let unpaid = 0;
      let paid = 0;
      for (const p of ordered) {
        if (p.kind === "in") {
          // A second clock-in without a clock-out abandons the first: it is
          // still shown as an open span so the gap is visible rather than
          // silently swallowed.
          if (openIn) {
            detail.spans.push({ inAt: openIn.at, outAt: null, grossMs: 0, workedMs: 0 });
          }
          openIn = p;
          unpaid = 0;
          paid = 0;
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            const worked = Math.max(0, gross - unpaid);
            dayMs += worked;
            detail.spans.push({ inAt: openIn.at, outAt: p.at, grossMs: gross, workedMs: worked });
            detail.grossMs += gross;
            detail.unpaidMs += unpaid;
            detail.paidMs += paid;
            totals.grossMs += gross;
            totals.unpaidMs += unpaid;
            totals.paidMs += paid;
            openIn = null;
            unpaid = 0;
            paid = 0;
            openBreak = null;
          }
        } else if (p.kind === "break_start") {
          if (openIn && !openBreak) openBreak = p;
        } else if (p.kind === "break_end") {
          if (openBreak) {
            const elapsed = new Date(p.at).getTime() - new Date(openBreak.at).getTime();
            if (openBreak.break_minutes === 10) paid += elapsed;
            else unpaid += elapsed;
            openBreak = null;
          }
        }
      }
      // Still on the clock when the period ended — shown, worth nothing.
      if (openIn) detail.spans.push({ inAt: openIn.at, outAt: null, grossMs: 0, workedMs: 0 });

      detail.workedMs = dayMs;
      totals.workedMs += dayMs;
      totals.dayTotals.push(dayMs);
      totals.days.push(detail);
    }
    totals.days.sort((a, b) => a.date.getTime() - b.date.getTime());
    out.set(userId, totals);
  }
  return out;
}
