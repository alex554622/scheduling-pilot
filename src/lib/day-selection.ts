import { useState } from "react";
import type { DayString } from "@/lib/schedule-pattern";

/**
 * Picking parts of a schedule to clear.
 *
 * Two ways in, which add up rather than compete: whole days, picked from the
 * day headings, and individual shifts, picked from the cells. Double-clicking
 * either one starts a selection; after that a single click adds or removes.
 *
 * Kept apart from the bar that renders it so the hook and the component live
 * in their own modules, which is what fast refresh wants.
 */
export interface ScheduleSelection {
  days: Set<DayString>;
  shifts: Set<string>;
  /** True while picking, even before anything has been picked. */
  active: boolean;
  /** Turn picking on from a button, rather than by double-clicking. */
  enable: () => void;
  startDay: (day: DayString) => void;
  toggleDay: (day: DayString) => void;
  startShift: (id: string) => void;
  toggleShift: (id: string) => void;
  /** Everything on screen, for "erase the whole week". */
  selectShifts: (ids: string[]) => void;
  clear: () => void;
}

function toggleIn<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function useScheduleSelection(): ScheduleSelection {
  const [days, setDays] = useState<Set<DayString>>(new Set());
  const [shifts, setShifts] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState(false);

  return {
    days,
    shifts,
    active: mode || days.size > 0 || shifts.size > 0,
    enable: () => setMode(true),
    startDay: (day) => {
      setMode(true);
      setShifts(new Set());
      setDays(new Set([day]));
    },
    toggleDay: (day) => setDays((prev) => toggleIn(prev, day)),
    startShift: (id) => {
      setMode(true);
      setDays(new Set());
      setShifts(new Set([id]));
    },
    toggleShift: (id) => setShifts((prev) => toggleIn(prev, id)),
    selectShifts: (ids) => {
      setMode(true);
      setShifts(new Set(ids));
    },
    clear: () => {
      setMode(false);
      setDays(new Set());
      setShifts(new Set());
    },
  };
}
