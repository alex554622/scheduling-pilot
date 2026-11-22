/**
 * Lateness: a clock-in read against the employee's published schedule.
 *
 * Worked out on the fly from `shifts` and `time_punches`, never stored on the
 * punch. A manager moving a shift after someone has clocked in changes the
 * answer straight away, the same way on every screen, and turning the rule off
 * leaves nothing behind. The kiosk asks the database the same question through
 * `punch_late_minutes()`, which follows the rule below line for line.
 *
 * The rule:
 * - Only published shifts count. A draft is not a schedule anyone was given.
 * - A clock-in belongs to the shift it falls in, or failing that to the next
 *   one starting within `MATCH_EARLY_MS` (someone arriving early).
 * - Only the first clock-in of a shift is judged. Coming back from clocking
 *   out mid-shift is not arriving late.
 * - Late means more than `graceMinutes` whole minutes after the shift start.
 *   With a 5-minute grace, 9:05 is on time and 9:06 is six minutes late.
 * - The raw punch time is used, not the rounded one: rounding is about pay,
 *   and the grace period is the allowance for a minute or two.
 */

export interface ScheduledShift {
  id: string;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  published: boolean;
}

export interface ClockIn {
  id: string;
  user_id: string;
  kind: string;
  at: string;
}

export interface Lateness {
  shiftId: string;
  shiftStart: string;
  /** Whole minutes after the shift start; 0 when early or on the dot. */
  minutesLate: number;
  /** Past the grace period. */
  late: boolean;
}

/** How early a clock-in can be and still belong to the shift after it. */
export const MATCH_EARLY_MS = 4 * 3_600_000;

/**
 * The shift a clock-in at `atMs` belongs to, if any. A shift already under way
 * wins (the one that started last, if two overlap); otherwise the next one to
 * start within `MATCH_EARLY_MS`.
 */
export function matchShift<S extends ScheduledShift>(
  shifts: S[],
  userId: string,
  atMs: number,
): S | undefined {
  let running: S | undefined;
  let runningStart = -Infinity;
  let upcoming: S | undefined;
  let upcomingStart = Infinity;
  for (const s of shifts) {
    if (!s.published || s.employee_id !== userId) continue;
    const start = new Date(s.starts_at).getTime();
    const end = new Date(s.ends_at).getTime();
    if (atMs >= end) continue;
    if (start <= atMs) {
      if (start > runningStart) {
        running = s;
        runningStart = start;
      }
    } else if (start - atMs <= MATCH_EARLY_MS && start < upcomingStart) {
      upcoming = s;
      upcomingStart = start;
    }
  }
  return running ?? upcoming;
}

function judge(shift: ScheduledShift, atMs: number, graceMinutes: number): Lateness {
  const minutesLate = Math.max(
    0,
    Math.floor((atMs - new Date(shift.starts_at).getTime()) / 60_000),
  );
  return {
    shiftId: shift.id,
    shiftStart: shift.starts_at,
    minutesLate,
    late: minutesLate > Math.max(0, graceMinutes),
  };
}

/**
 * Every judged clock-in, keyed by punch id. Clock-ins with no shift, and the
 * second and later clock-ins of a shift, are left out.
 */
export function latenessByPunch(
  punches: ClockIn[],
  shifts: ScheduledShift[],
  graceMinutes: number,
): Map<string, Lateness> {
  const out = new Map<string, Lateness>();
  const judgedShifts = new Set<string>();
  const ins = punches
    .filter((p) => p.kind === "in")
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  for (const p of ins) {
    const atMs = new Date(p.at).getTime();
    const shift = matchShift(shifts, p.user_id, atMs);
    if (!shift || judgedShifts.has(shift.id)) continue;
    judgedShifts.add(shift.id);
    out.set(p.id, judge(shift, atMs, graceMinutes));
  }
  return out;
}

/**
 * Clock-ins that belong to no published shift at all — worked without being
 * on the schedule. A second clock-in inside a shift (back from lunch) still
 * belongs to that shift, so it is not here.
 */
export function unscheduledClockIns(punches: ClockIn[], shifts: ScheduledShift[]): Set<string> {
  const out = new Set<string>();
  for (const p of punches) {
    if (p.kind !== "in") continue;
    if (!matchShift(shifts, p.user_id, new Date(p.at).getTime())) out.add(p.id);
  }
  return out;
}
