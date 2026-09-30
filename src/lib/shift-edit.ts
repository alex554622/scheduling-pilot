/**
 * A day of punches as a manager edits it: shifts, each a clock-in, a clock-out
 * and the breaks between, rather than a list of loose punches to retype.
 *
 * The editor works in wall-clock times ("09:00") on the day being edited.
 * Anything earlier than the shift's clock-in is read as the next morning, so an
 * overnight shift is typed the way it is spoken: in 20:00, out 02:00.
 *
 * Kept free of React and Supabase so the test script can run it under bun.
 */
import { readBreak } from "./timecard-totals";

export type PunchKind = "in" | "out" | "break_start" | "break_end";

export interface DayPunch {
  id: string;
  kind: PunchKind;
  at: string;
  break_minutes: number | null;
}

export interface DraftBreak {
  key: string;
  startId?: string;
  endId?: string;
  /** 10, 30 or 60; null for an older break recorded without a length. */
  minutes: number | null;
  /** "HH:MM", or "" when not set. */
  start: string;
  end: string;
}

export interface DraftShift {
  key: string;
  inId?: string;
  outId?: string;
  inTime: string;
  outTime: string;
  breaks: DraftBreak[];
}

let seq = 0;
export const newKey = () => `k${++seq}`;

/** "HH:MM" in local time. */
export function toTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A wall-clock time on `day`, or on the day after when it falls before
 * `notBefore` — the clock-in, for everything that happens during a shift.
 */
export function resolveTime(time: string, day: Date, notBefore?: Date): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const d = new Date(day);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (notBefore && d.getTime() < notBefore.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Read one day's punches (oldest first) into shifts. */
export function toShifts(punches: DayPunch[]): DraftShift[] {
  const ordered = [...punches].sort((a, b) => a.at.localeCompare(b.at));
  const shifts: DraftShift[] = [];
  let cur: DraftShift | null = null;
  // A punch with no clock-in before it still becomes a shift — one missing its
  // clock-in, for the manager to fill in or remove — rather than being hidden.
  const open = () => {
    if (!cur) {
      cur = { key: newKey(), inTime: "", outTime: "", breaks: [] };
      shifts.push(cur);
    }
    return cur;
  };
  for (const p of ordered) {
    if (p.kind === "in") {
      cur = { key: newKey(), inId: p.id, inTime: toTime(p.at), outTime: "", breaks: [] };
      shifts.push(cur);
    } else if (p.kind === "out") {
      const s = open();
      s.outId = p.id;
      s.outTime = toTime(p.at);
      cur = null;
    } else if (p.kind === "break_start") {
      open().breaks.push({
        key: newKey(),
        startId: p.id,
        minutes: p.break_minutes,
        start: toTime(p.at),
        end: "",
      });
    } else {
      const s = open();
      const last = s.breaks[s.breaks.length - 1];
      if (last && !last.endId) {
        last.endId = p.id;
        last.end = toTime(p.at);
        last.minutes ??= p.break_minutes;
      } else {
        s.breaks.push({
          key: newKey(),
          endId: p.id,
          minutes: p.break_minutes,
          start: "",
          end: toTime(p.at),
        });
      }
    }
  }
  return shifts;
}

export interface ResolvedShift {
  shift: DraftShift;
  inAt: Date | null;
  outAt: Date | null;
  breaks: { brk: DraftBreak; startAt: Date | null; endAt: Date | null }[];
}

/** Every time in a shift as an instant, overnight times rolled to the next day. */
export function resolveShift(s: DraftShift, day: Date): ResolvedShift {
  const inAt = resolveTime(s.inTime, day);
  const anchor = inAt ?? undefined;
  return {
    shift: s,
    inAt,
    outAt: resolveTime(s.outTime, day, anchor),
    breaks: s.breaks.map((b) => ({
      brk: b,
      startAt: resolveTime(b.start, day, anchor),
      endAt: resolveTime(b.end, day, anchor),
    })),
  };
}

/** Anything in the day that can't be saved, keyed by shift. Empty when it's all fine. */
export function validateDay(shifts: DraftShift[], day: Date): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const add = (key: string, msg: string) => {
    if (!problems.has(key)) problems.set(key, []);
    problems.get(key)!.push(msg);
  };
  const resolved = shifts.map((s) => resolveShift(s, day));

  for (const r of resolved) {
    const k = r.shift.key;
    if (!r.inAt) add(k, "Enter a clock-in time.");
    if (r.inAt && r.outAt && r.outAt.getTime() === r.inAt.getTime()) {
      add(k, "Clock-out can't be the same as clock-in.");
    }
    const spans: [number, number][] = [];
    r.breaks.forEach(({ brk, startAt, endAt }, i) => {
      const n = r.breaks.length > 1 ? ` ${i + 1}` : "";
      if (!startAt) add(k, `Break${n}: enter a start time.`);
      if (!endAt && r.outAt) add(k, `Break${n}: enter an end time, or clear the clock-out.`);
      if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
        add(k, `Break${n}: the end has to come after the start.`);
      }
      if (r.outAt && ((startAt && startAt > r.outAt) || (endAt && endAt > r.outAt))) {
        add(k, `Break${n}: has to end by the clock-out.`);
      }
      if (brk.minutes == null && !brk.startId) add(k, `Break${n}: pick a length.`);
      if (startAt) spans.push([startAt.getTime(), (endAt ?? startAt).getTime()]);
    });
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] < spans[i - 1][1]) add(k, "Two breaks overlap.");
    }
  }

  // Shifts may not overlap, and only the last one may still be open.
  const timed = resolved
    .filter((r) => r.inAt)
    .sort((a, b) => a.inAt!.getTime() - b.inAt!.getTime());
  for (let i = 0; i < timed.length; i++) {
    const r = timed[i];
    const next = timed[i + 1];
    if (!next) break;
    if (!r.outAt) {
      add(r.shift.key, "Only the last shift of the day can be left without a clock-out.");
    } else if (next.inAt!.getTime() < r.outAt.getTime()) {
      add(next.shift.key, "Starts before the shift above it has ended.");
    }
  }
  return problems;
}

export interface ShiftHours {
  workedMs: number;
  unpaidMs: number;
  paidMs: number;
  open: boolean;
}

/** What a shift pays, by the same break rules as the timecard. */
export function shiftHours(r: ResolvedShift, capBreaks: boolean): ShiftHours {
  if (!r.inAt || !r.outAt) return { workedMs: 0, unpaidMs: 0, paidMs: 0, open: !r.outAt };
  let unpaidMs = 0;
  let paidMs = 0;
  for (const b of r.breaks) {
    if (!b.startAt || !b.endAt) continue;
    const read = readBreak(b.endAt.getTime() - b.startAt.getTime(), b.brk.minutes, capBreaks);
    if (read.paid) paidMs += read.countedMs;
    else unpaidMs += read.countedMs;
  }
  const gross = r.outAt.getTime() - r.inAt.getTime();
  return { workedMs: Math.max(0, gross - unpaidMs), unpaidMs, paidMs, open: false };
}

export type Change =
  | { op: "delete"; id: string }
  | { op: "update"; id: string; kind: PunchKind; at: string; minutes: number | null }
  | { op: "insert"; kind: PunchKind; at: string; minutes: number | null };

/**
 * What saving the draft means as punch calls: deletes first, then updates,
 * then inserts, so a corrected day never passes through a state with two
 * clock-ins in a row. A time left as it was is not rewritten — the stored
 * seconds stay, and the audit log only shows what the manager changed.
 */
export function diffDay(original: DayPunch[], shifts: DraftShift[], day: Date): Change[] {
  const byId = new Map(original.map((p) => [p.id, p]));
  const kept = new Set<string>();
  const updates: Change[] = [];
  const inserts: Change[] = [];

  const sameMinute = (a: Date, iso: string) => {
    const o = new Date(iso);
    o.setSeconds(0, 0);
    return a.getTime() === o.getTime();
  };
  const place = (
    id: string | undefined,
    kind: PunchKind,
    at: Date | null,
    minutes: number | null,
  ) => {
    if (!at) return; // cleared: the punch goes, or was never there
    if (id) {
      const p = byId.get(id)!;
      kept.add(id);
      // A break's length is read from its start; the end only echoes it.
      const minutesChanged =
        kind === "break_start" && minutes != null && minutes !== p.break_minutes;
      if (!sameMinute(at, p.at) || p.kind !== kind || minutesChanged) {
        updates.push({
          op: "update",
          id,
          kind,
          at: sameMinute(at, p.at) ? p.at : at.toISOString(),
          minutes,
        });
      }
    } else {
      inserts.push({ op: "insert", kind, at: at.toISOString(), minutes });
    }
  };

  for (const s of shifts) {
    const r = resolveShift(s, day);
    place(s.inId, "in", r.inAt, null);
    for (const b of r.breaks) {
      place(b.brk.startId, "break_start", b.startAt, b.brk.minutes);
      place(b.brk.endId, "break_end", b.endAt, b.brk.minutes);
    }
    place(s.outId, "out", r.outAt, null);
  }

  const deletes: Change[] = original
    .filter((p) => !kept.has(p.id))
    .map((p) => ({ op: "delete", id: p.id }));
  return [...deletes, ...updates, ...inserts];
}
