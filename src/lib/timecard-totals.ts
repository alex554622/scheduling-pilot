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

/**
 * Someone on the clock tapping the location they have moved to. From `at`
 * until their next move or their clock-out, their time counts there. A move is
 * not a punch: the shift stays one clock-in and one clock-out, one time card.
 */
export interface LocationMove {
  user_id: string;
  at: string;
  location_id: string;
}

export interface SimplePunch {
  user_id: string;
  kind: PunchKind;
  at: string;
  break_minutes: number | null;
  /**
   * Where the shift was clocked in. Only the clock-in's is read; a move during
   * the shift is a `LocationMove`, not a change to this.
   */
  location_id?: string | null;
}

/**
 * Longest a shift can run and still claim the punches after its clock-in. Past
 * this the clock-in is taken as a forgotten clock-out, and whatever comes next
 * counts on its own day rather than being dragged back onto an old one.
 */
export const MAX_SHIFT_MS = 24 * 3_600_000;

/**
 * The day each punch counts toward: the day its shift was clocked in on.
 *
 * A shift that runs past midnight belongs to the day it started — in at 8 pm,
 * out at 2 am is six hours on the first day, not an open clock-in on one day
 * and a stray clock-out on the next that between them pay nothing. Its breaks
 * and its clock-out are filed under the clock-in's day.
 *
 * Keys are `Date.toDateString()` in local time, parallel to `punches`. Handles
 * several people at once; `punches` must be oldest first.
 */
export function shiftDayKeys<T extends { user_id: string; kind: PunchKind; at: string }>(
  punches: T[],
): string[] {
  const openIn = new Map<string, number>();
  return punches.map((p) => {
    const t = new Date(p.at).getTime();
    let dayOf = t;
    if (p.kind === "in") {
      openIn.set(p.user_id, t);
    } else {
      const start = openIn.get(p.user_id);
      if (start != null && t - start <= MAX_SHIFT_MS) dayOf = start;
      if (p.kind === "out" || (start != null && t - start > MAX_SHIFT_MS)) {
        openIn.delete(p.user_id);
      }
    }
    return new Date(dayOf).toDateString();
  });
}

/**
 * The punches whose shift was clocked in during [from, to). Fetch from
 * `MAX_SHIFT_MS` either side of the period and pass the lot: the extra hours
 * after `to` hold the clock-out of a shift started on the period's last night,
 * and the hours before `from` say which early-morning punches finish a shift
 * from the period before (and so are not this period's to pay).
 */
export function punchesInPeriod<T extends { user_id: string; kind: PunchKind; at: string }>(
  punches: T[],
  from: Date,
  to: Date,
): T[] {
  const ordered = [...punches].sort((a, b) => a.at.localeCompare(b.at));
  const keys = shiftDayKeys(ordered);
  return ordered.filter((_, i) => {
    const day = new Date(keys[i]).getTime();
    return day >= from.getTime() && day < to.getTime();
  });
}

/** One person's or several people's punches, grouped by `shiftDayKeys`. */
export function groupByShiftDay<T extends { user_id: string; kind: PunchKind; at: string }>(
  punches: T[],
): Map<string, T[]> {
  const ordered = [...punches].sort((a, b) => a.at.localeCompare(b.at));
  const keys = shiftDayKeys(ordered);
  const byDay = new Map<string, T[]>();
  ordered.forEach((p, i) => {
    const list = byDay.get(keys[i]);
    if (list) list.push(p);
    else byDay.set(keys[i], [p]);
  });
  return byDay;
}

/** One clock-in to clock-out. `outAt` is null while someone is still on the clock. */
export interface ShiftSpan {
  inAt: string;
  outAt: string | null;
  /** Clock-out minus clock-in, breaks included. */
  grossMs: number;
  /** What gets paid: gross less unpaid break time. */
  workedMs: number;
  /** The clock-in's location; null when it was never filed under one. */
  locationId: string | null;
  /**
   * The paid time split at each move, in the order they were worked. Adds up
   * to `workedMs`. Empty while still on the clock.
   */
  byLocation: LocationHours[];
}

/** Paid time at one location. `locationId` null is time filed under none. */
export interface LocationHours {
  locationId: string | null;
  workedMs: number;
}

/**
 * One finished shift's paid time, split at each move. Clock time from the
 * clock-in to the first move is at the clock-in's location, from there to the
 * next move at that move's location, and so on to the clock-out. An unpaid
 * break comes off the part of the shift it started in. Moves outside the shift
 * are ignored. Places are listed in the order they were first worked, each
 * once.
 *
 * @param unpaidBreaks when each unpaid break started, and what it took off.
 */
export function splitByLocation(
  inAt: string,
  outAt: string,
  startLocation: string | null,
  moves: { at: string; location_id: string }[],
  unpaidBreaks: { at: string; ms: number }[] = [],
): LocationHours[] {
  const start = new Date(inAt).getTime();
  const end = new Date(outAt).getTime();
  const cuts = moves
    .map((m) => ({ t: new Date(m.at).getTime(), loc: m.location_id }))
    .filter((m) => m.t > start && m.t < end)
    .sort((a, b) => a.t - b.t);
  const parts: { from: number; to: number; loc: string | null; ms: number }[] = [];
  let from = start;
  let loc: string | null = startLocation;
  for (const c of cuts) {
    parts.push({ from, to: c.t, loc, ms: c.t - from });
    from = c.t;
    loc = c.loc;
  }
  parts.push({ from, to: end, loc, ms: end - from });
  for (const b of unpaidBreaks) {
    const t = new Date(b.at).getTime();
    const part = parts.find((p) => t >= p.from && t < p.to) ?? parts[parts.length - 1];
    part.ms -= b.ms;
  }
  const out: LocationHours[] = [];
  for (const p of parts) {
    const ms = Math.max(0, p.ms);
    const seen = out.find((o) => o.locationId === p.loc);
    if (seen) seen.workedMs += ms;
    else if (ms > 0 || parts.length === 1) out.push({ locationId: p.loc, workedMs: ms });
  }
  return out;
}

/**
 * Paid time per location across several shifts, most hours first. Only
 * finished shifts count — one still on the clock is worth nothing yet, exactly
 * as in the totals — so the lines always add up to the total beside them.
 */
export function hoursByLocation(spans: { byLocation: LocationHours[] }[]): LocationHours[] {
  const byLoc = new Map<string | null, number>();
  for (const s of spans)
    for (const l of s.byLocation) byLoc.set(l.locationId, (byLoc.get(l.locationId) ?? 0) + l.workedMs);
  return [...byLoc]
    .map(([locationId, workedMs]) => ({ locationId, workedMs }))
    .sort((a, b) => b.workedMs - a.workedMs);
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
  /** The period's paid time split by where it was worked — see `hoursByLocation`. */
  byLocation: LocationHours[];
}

/** A clock-in with no clock-out yet: shown, worth nothing. */
function openSpan(p: SimplePunch): ShiftSpan {
  return {
    inAt: p.at,
    outAt: null,
    grossMs: 0,
    workedMs: 0,
    locationId: p.location_id ?? null,
    byLocation: [],
  };
}

/**
 * @param roundMinutes the company's punch-rounding rule; 0 counts raw times.
 * @param capBreaks the company's `cap_break_to_length` rule — see `readBreak`.
 * @param moves mid-shift location changes, for splitting each shift's hours
 * by place. Rounded by the same rule as the punches.
 */
export function totalsByPerson(
  punches: SimplePunch[],
  roundMinutes = 0,
  capBreaks = true,
  moves: LocationMove[] = [],
): Map<string, PersonTotals> {
  const movesByUser = new Map<string, LocationMove[]>();
  for (const m of roundPunches(moves, roundMinutes)) {
    const list = movesByUser.get(m.user_id);
    if (list) list.push(m);
    else movesByUser.set(m.user_id, [m]);
  }

  // Grouped by the day each shift was clocked in on, so a shift past midnight
  // is counted whole on its first day — see `shiftDayKeys`.
  const byUser = new Map<string, Map<string, SimplePunch[]>>();
  for (const [day, list] of groupByShiftDay(punches)) {
    for (const p of list) {
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, new Map());
      const days = byUser.get(p.user_id)!;
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(p);
    }
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
      byLocation: [],
    };
    for (const [key, list] of days) {
      // Grouped by the shift's clock-in day, then rounded — a rounding that
      // crosses midnight must not move someone's shift onto the next day's card.
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
      let unpaidBreaks: { at: string; ms: number }[] = [];
      for (const p of ordered) {
        if (p.kind === "in") {
          // A second clock-in without a clock-out abandons the first: it is
          // still shown as an open span so the gap is visible rather than
          // silently swallowed.
          if (openIn) {
            detail.spans.push(openSpan(openIn));
          }
          openIn = p;
          unpaid = 0;
          paid = 0;
          unpaidBreaks = [];
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            const worked = Math.max(0, gross - unpaid);
            dayMs += worked;
            detail.spans.push({
              inAt: openIn.at,
              outAt: p.at,
              grossMs: gross,
              workedMs: worked,
              locationId: openIn.location_id ?? null,
              byLocation: splitByLocation(
                openIn.at,
                p.at,
                openIn.location_id ?? null,
                movesByUser.get(userId) ?? [],
                unpaidBreaks,
              ),
            });
            detail.grossMs += gross;
            detail.unpaidMs += unpaid;
            detail.paidMs += paid;
            totals.grossMs += gross;
            totals.unpaidMs += unpaid;
            totals.paidMs += paid;
            openIn = null;
            unpaid = 0;
            paid = 0;
            unpaidBreaks = [];
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
            else {
              unpaid += read.countedMs;
              unpaidBreaks.push({ at: openBreak.at, ms: read.countedMs });
            }
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
      if (openIn) detail.spans.push(openSpan(openIn));

      detail.workedMs = dayMs;
      totals.workedMs += dayMs;
      totals.dayTotals.push(dayMs);
      totals.days.push(detail);
    }
    totals.days.sort((a, b) => a.date.getTime() - b.date.getTime());
    totals.byLocation = hoursByLocation(totals.days.flatMap((d) => d.spans));
    out.set(userId, totals);
  }
  return out;
}
