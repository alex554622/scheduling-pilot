import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAppRules } from "@/lib/app-rules";
import {
  latenessByPunch,
  MATCH_EARLY_MS,
  unscheduledClockIns,
  type ClockIn,
  type Lateness,
  type ScheduledShift,
} from "@/lib/lateness";

export interface ScheduleMarks {
  /** Judged clock-ins by punch id; see `latenessByPunch`. */
  late: Map<string, Lateness>;
  /** Clock-ins on no published shift at all. */
  unscheduled: Set<string>;
  /** The published shifts read, for showing the schedule beside the punches. */
  shifts: ScheduledShift[];
}

const NONE: ScheduleMarks = { late: new Map(), unscheduled: new Set(), shifts: [] };

/**
 * Lateness for one person's clock-ins, read against their published shifts.
 * With the company's "connect the schedule to time cards" rule off this asks
 * the database nothing and returns an empty map, so every screen that uses it
 * looks exactly as it did before the rule existed.
 *
 * Shifts are fetched fresh (30 s stale time) rather than snapshotted on the
 * punch, so moving or unpublishing a shift changes the mark on the next read.
 */
export function useLateness(
  userId: string | undefined,
  punches: Pick<ClockIn, "id" | "kind" | "at">[] | undefined,
) {
  return useScheduleMarks(userId, punches).late;
}

/**
 * Lateness plus the clock-ins that were on no shift. Same fetch and the same
 * off-switch as `useLateness`: with the rule off both come back empty. Until
 * the shifts have loaded both are empty too, so nothing flashes "not scheduled".
 */
export function useScheduleMarks(
  userId: string | undefined,
  punches: Pick<ClockIn, "id" | "kind" | "at">[] | undefined,
  /** Also fetch every shift in this span, punched or not (the timecard's period). */
  period?: { from: Date; to: Date },
): ScheduleMarks {
  const rules = useAppRules();
  const on = rules.schedule_lateness;

  // The span the clock-ins cover, widened so a shift a clock-in matches is
  // always in the fetch: one starting up to MATCH_EARLY_MS after the last
  // clock-in, or one that started up to a day before the first.
  const periodFrom = period?.from.getTime();
  const periodTo = period?.to.getTime();
  const range = useMemo(() => {
    const ins = (punches ?? []).filter((p) => p.kind === "in").map((p) => new Date(p.at).getTime());
    const froms = ins.map((t) => t - 24 * 3_600_000);
    const tos = ins.map((t) => t + MATCH_EARLY_MS);
    if (periodFrom != null && periodTo != null) {
      froms.push(periodFrom);
      tos.push(periodTo);
    }
    if (froms.length === 0) return null;
    return {
      from: new Date(Math.min(...froms)).toISOString(),
      to: new Date(Math.max(...tos)).toISOString(),
    };
  }, [punches, periodFrom, periodTo]);

  const shiftsQ = useQuery<ScheduledShift[]>({
    queryKey: ["lateness-shifts", userId, range?.from, range?.to],
    enabled: on && !!userId && !!range,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at, published")
        .eq("employee_id", userId!)
        .eq("published", true)
        .lt("starts_at", range!.to)
        .gt("ends_at", range!.from);
      if (error) throw error;
      return data ?? [];
    },
  });

  return useMemo(() => {
    if (!on || !shiftsQ.data || !punches || !userId) return NONE;
    const mine: ClockIn[] = punches.map((p) => ({
      id: p.id,
      kind: p.kind,
      at: p.at,
      user_id: userId,
    }));
    return {
      late: latenessByPunch(mine, shiftsQ.data, rules.late_grace_minutes),
      unscheduled: unscheduledClockIns(mine, shiftsQ.data),
      shifts: shiftsQ.data,
    };
  }, [on, shiftsQ.data, punches, userId, rules.late_grace_minutes]);
}
