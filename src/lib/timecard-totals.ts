/**
 * Worked time per person, for the roster-wide timecard view.
 *
 * The rules match a single timecard exactly, because the two are read side by
 * side and any difference between them reads as a bug: an unpaid break comes
 * off the shift, a 10-minute break is paid and does not, and a shift with no
 * clock-out contributes nothing until someone closes it.
 */

/**
 * Round a Date to the nearest N minutes (0 = no rounding).
 *
 * Nearest, not up and not down: with a 5-minute rule 2:23 reads 2:25 and 2:22
 * reads 2:20, so the rounding costs the employee no more than it costs the
 * company. Lives here rather than with the rest of the rules because this
 * module is the one that turns punches into hours, and it has to stay free of
 * React and Supabase imports so the test script can run it under bun.
 */
export function roundToMinutes(d: Date, minutes: number): Date {
  if (!minutes || minutes <= 0) return d;
  const ms = minutes * 60_000;
  return new Date(Math.round(d.getTime() / ms) * ms);
}

/**
 * The same punches as the rounding rule says they read.
 *
 * Hours are counted from these, not from the raw rows — a card that printed
 * "in 8:00, out 4:25" while paying from 7:58 to 4:23 was showing one thing and
 * paying another. The raw punch is never overwritten; only this reading of it
 * is rounded, so a manager editing a day still sees what the clock recorded.
 */
export function roundPunches<T extends { at: string }>(punches: T[], minutes: number): T[] {
  if (!minutes || minutes <= 0) return punches;
  return punches.map((p) => ({
    ...p,
    at: roundToMinutes(new Date(p.at), minutes).toISOString(),
  }));
}

/** A paid 10-minute break still counts as time worked; 30 and 60 do not. */
export const PAID_BREAK_MINUTES = 10;

export interface BreakReading {
  /** Clock time actually spent away from the floor. */
  elapsedMs: number;
  /** What the break is recorded as, once the company's rules are applied. */
  countedMs: number;
  /** How far past the picked length it ran; 0 when it stayed inside. */
  overMs: number;
  /** How far short they came back; 0 when they took the whole break. */
  shortMs: number;
  /** Back on the clock before the break was up — a break that did not happen. */
  incomplete: boolean;
  /** A 10 stays in the paid column; a 30 or a 60 comes off the shift. */
  paid: boolean;
}

/**
 * How one break reads once the company's rules are applied. Both rules are
 * about the length the employee picked when they started it:
 *
 *  - **A break that runs long is recorded as the length that was picked.** A 30
 *    that ran 37 comes off the shift as 30, not 37, so an overrun is the
 *    company's to manage rather than the employee's to pay for. The overrun is
 *    still reported in `overMs` — capped is not hidden.
 *  - **A break cut short is recorded as what it was, and flagged.** A 30-minute
 *    meal break taken in 22 minutes is a break that did not happen, so the
 *    shorter time is what comes off the shift and `incomplete` says why the
 *    card should be looked at.
 *
 * With no length on the punch — an older row, or a break opened before lengths
 * existed — there is nothing to measure against: the clock time stands and
 * nothing is flagged.
 *
 * @param cap the company's `cap_break_to_length` rule. Off, the clock time is
 * recorded as it was and only the flag survives.
 */
export function readBreak(
  elapsedMs: number,
  pickedMinutes: number | null,
  cap = true,
): BreakReading {
  const elapsed = Math.max(0, elapsedMs);
  const allowance = pickedMinutes && pickedMinutes > 0 ? pickedMinutes * 60_000 : null;
  const overMs = allowance == null ? 0 : Math.max(0, elapsed - allowance);
  const shortMs = allowance == null ? 0 : Math.max(0, allowance - elapsed);
  return {
    elapsedMs: elapsed,
    countedMs: cap && allowance != null ? Math.min(elapsed, allowance) : elapsed,
    overMs,
    shortMs,
    incomplete: shortMs > 0,
    paid: pickedMinutes === PAID_BREAK_MINUTES,
  };
}

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
  /** Breaks the person came back from early — see `readBreak`. */
  incompleteBreaks: number;
  /** Break time run past the picked length and not charged to them. */
  overBreakMs: number;
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
  /** Breaks cut short across the whole period — the number a card is flagged by. */
  incompleteBreaks: number;
  /** Break time run past the picked length and not charged to them. */
  overBreakMs: number;
}

/**
 * @param roundMinutes the company's punch-rounding rule; 0 counts raw times.
 * @param capBreaks the company's `cap_break_to_length` rule — see `readBreak`.
 */
export function totalsByPerson(
  punches: SimplePunch[],
  roundMinutes = 0,
  capBreaks = true,
): Map<string, PersonTotals> {
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
      incompleteBreaks: 0,
      overBreakMs: 0,
    };
    for (const [key, list] of days) {
      // Grouped by the day the punch actually happened, then rounded — a
      // rounding that crosses midnight must not move someone's shift onto the
      // next day's card.
      const ordered = roundPunches(
        [...list].sort((a, b) => a.at.localeCompare(b.at)),
        roundMinutes,
      );
      const detail: DayDetail = {
        key,
        date: new Date(key),
        spans: [],
        grossMs: 0,
        workedMs: 0,
        unpaidMs: 0,
        paidMs: 0,
        incompleteBreaks: 0,
        overBreakMs: 0,
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
            const read = readBreak(
              new Date(p.at).getTime() - new Date(openBreak.at).getTime(),
              openBreak.break_minutes,
              capBreaks,
            );
            if (read.paid) paid += read.countedMs;
            else unpaid += read.countedMs;
            if (read.incomplete) {
              detail.incompleteBreaks += 1;
              totals.incompleteBreaks += 1;
            }
            detail.overBreakMs += read.overMs;
            totals.overBreakMs += read.overMs;
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
