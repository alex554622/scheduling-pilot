/**
 * Pay rules on a position: paid meal breaks and a shift differential, set by a
 * company admin on "Police officer", "Dispatcher" and so on, and followed by
 * everyone whose primary position it is. See the migration
 * `20261126130000_position_pay_rules.sql` for the columns.
 *
 * Everything here is pure, so the time card, the print copy, the PDF and the
 * tests all read the same answer.
 */

/** A position and the pay rules set on it. */
export interface PositionPayRules {
  id: string;
  name: string;
  /** 30- and 60-minute breaks stay in the hours, like the 10. */
  paid_meal_breaks: boolean;
  diff_enabled: boolean;
  diff_label: string;
  /** "18:00" or "18:00:00" — wall-clock time the window opens. */
  diff_start: string;
  /** When it closes. Earlier than the start means it runs past midnight. */
  diff_end: string;
  /** Turned off under Organization: kept for those who hold it. */
  is_active?: boolean;
}

/**
 * The pay rules a person follows: their primary position's, when that position
 * turns either rule on. Null — no position, or one with nothing set — keeps the
 * company's App rules.
 */
export function rulesForPosition(
  positionId: string | null | undefined,
  positions: PositionPayRules[],
): PositionPayRules | null {
  if (!positionId) return null;
  const p = positions.find((x) => x.id === positionId);
  return p && (p.paid_meal_breaks || p.diff_enabled) ? p : null;
}

export interface AssignedPosition {
  position_id: string;
  is_primary: boolean;
}

/**
 * The pay rules for someone holding these positions (employee_positions). The
 * primary position decides when one is marked; otherwise the first of their
 * positions, in the company's list order, that has rules. Null: company rules.
 */
export function rulesForPerson(
  assigned: AssignedPosition[],
  positions: PositionPayRules[],
): PositionPayRules | null {
  const primary = assigned.find((a) => a.is_primary);
  if (primary) return rulesForPosition(primary.position_id, positions);
  const held = new Set(assigned.map((a) => a.position_id));
  for (const p of positions) {
    if (!held.has(p.id)) continue;
    const r = rulesForPosition(p.id, positions);
    if (r) return r;
  }
  return null;
}

/** "18:00:00" → minutes after midnight. */
export function clockMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return ((h || 0) * 60 + (m || 0)) % (24 * 60);
}

const DAY_MS = 24 * 3_600_000;

/**
 * The differential windows (local wall-clock time) that can touch [fromMs,
 * toMs). A window from 18:00 to 06:00 opens at 18:00 one day and closes at
 * 06:00 the next; start equal to end means all day.
 */
function windowsAround(fromMs: number, toMs: number, startMin: number, endMin: number) {
  const out: [number, number][] = [];
  const first = new Date(fromMs);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - 1);
  for (const d = new Date(first); d.getTime() < toMs + DAY_MS; d.setDate(d.getDate() + 1)) {
    const open = new Date(d);
    open.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    const close = new Date(d);
    if (endMin <= startMin) close.setDate(close.getDate() + 1);
    close.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
    out.push([open.getTime(), close.getTime()]);
  }
  return out;
}

function overlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** One clocked stretch, with the unpaid breaks taken during it. */
export interface WorkedSpan {
  inMs: number;
  outMs: number;
  /** Unpaid break time as charged: from the break's start, for what it counted. */
  unpaidBreaks: { startMs: number; ms: number }[];
}

/**
 * Time worked inside the differential window: clocked time that falls in the
 * window, less any unpaid break time that also falls in it. A paid break is
 * time worked, so it stays in.
 */
export function differentialMs(span: WorkedSpan, diffStart: string, diffEnd: string): number {
  if (span.outMs <= span.inMs) return 0;
  const s = clockMinutes(diffStart);
  const e = clockMinutes(diffEnd);
  const windows = windowsAround(span.inMs, span.outMs, s, e);
  const inWindow = (a: number, b: number) =>
    windows.reduce((sum, [w0, w1]) => sum + overlap(a, b, w0, w1), 0);
  let ms = inWindow(span.inMs, span.outMs);
  for (const b of span.unpaidBreaks) {
    const b0 = Math.max(span.inMs, b.startMs);
    const b1 = Math.min(span.outMs, b.startMs + b.ms);
    if (b1 > b0) ms -= inWindow(b0, b1);
  }
  return Math.max(0, ms);
}
