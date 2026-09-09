/**
 * Splitting worked time into regular, overtime and double time.
 *
 * Three rules stack, in the order payroll applies them:
 *
 *   - daily overtime      — hours past N in a single day (default 8)
 *   - daily double time   — hours past N in a single day (default 12)
 *   - weekly overtime     — hours past N across the period (default 40)
 *
 * The weekly rule only ever promotes hours that are still *regular*, which is
 * what stops a long day being counted twice: an 14-hour day already gave up its
 * hours to daily overtime and double time, so they can't also be swept up by
 * the weekly threshold.
 *
 * Any threshold set to 0 switches that rule off.
 */

const HOUR = 3_600_000;

export interface OvertimeRules {
  /** Hours in a day before overtime starts. 0 = off. */
  daily_overtime_hours: number;
  /** Hours in a day before double time starts. 0 = off. */
  daily_double_time_hours: number;
  /** Hours in the period before overtime starts. 0 = off. */
  overtime_threshold_hours: number;
}

export interface OvertimeSplit {
  regularMs: number;
  overtimeMs: number;
  doubleTimeMs: number;
}

/** One day's hours split by the daily rules alone. */
export function splitDay(workedMs: number, rules: OvertimeRules): OvertimeSplit {
  const otAt = rules.daily_overtime_hours > 0 ? rules.daily_overtime_hours * HOUR : Infinity;
  const dtAt = rules.daily_double_time_hours > 0 ? rules.daily_double_time_hours * HOUR : Infinity;
  // A double-time threshold below the overtime one would otherwise produce
  // negative overtime; treat the lower of the two as where overtime begins.
  const otStart = Math.min(otAt, dtAt);

  const doubleTimeMs = Math.max(0, workedMs - dtAt);
  const overtimeMs = Math.max(0, Math.min(workedMs, dtAt) - otStart);
  const regularMs = Math.max(0, workedMs - overtimeMs - doubleTimeMs);
  return { regularMs, overtimeMs, doubleTimeMs };
}

/**
 * The period total, daily rules first and the weekly threshold applied to
 * whatever regular time is left.
 */
export function splitPeriod(dailyWorkedMs: number[], rules: OvertimeRules, applyWeekly: boolean): OvertimeSplit {
  const totals = dailyWorkedMs.reduce<OvertimeSplit>(
    (acc, ms) => {
      const day = splitDay(ms, rules);
      return {
        regularMs: acc.regularMs + day.regularMs,
        overtimeMs: acc.overtimeMs + day.overtimeMs,
        doubleTimeMs: acc.doubleTimeMs + day.doubleTimeMs,
      };
    },
    { regularMs: 0, overtimeMs: 0, doubleTimeMs: 0 },
  );

  if (!applyWeekly || rules.overtime_threshold_hours <= 0) return totals;

  // Only regular hours can be promoted — the rest are already premium.
  const weeklyCap = rules.overtime_threshold_hours * HOUR;
  const promoted = Math.max(0, totals.regularMs - weeklyCap);
  return {
    regularMs: totals.regularMs - promoted,
    overtimeMs: totals.overtimeMs + promoted,
    doubleTimeMs: totals.doubleTimeMs,
  };
}

/** "Overtime after 8h/day, double time after 12h/day, and over 40h/week." */
export function overtimeNote(rules: OvertimeRules, applyWeekly: boolean): string {
  const parts: string[] = [];
  if (rules.daily_overtime_hours > 0) parts.push(`overtime after ${rules.daily_overtime_hours}h in a day`);
  if (rules.daily_double_time_hours > 0) parts.push(`double time after ${rules.daily_double_time_hours}h in a day`);
  if (applyWeekly && rules.overtime_threshold_hours > 0) {
    parts.push(`overtime over ${rules.overtime_threshold_hours}h in the period`);
  }
  if (parts.length === 0) return "No overtime rules are in effect.";
  return `Paid at ${parts.join(", ")}.`;
}
