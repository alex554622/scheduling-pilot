import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Per-shift records for the automatic meal break: the employee's report that
 * it was missed, cut short or interrupted, and an admin's or supervisor's
 * correction. Keyed by the shift's clock-in punch. See
 * supabase/migrations/20261206120000_position_rules.sql.
 */
export interface MealAdjustment {
  in_punch_id: string;
  user_id: string;
  report_kind: "missed" | "short" | "interrupted" | null;
  report_minutes: number | null;
  report_note: string | null;
  reported_at: string | null;
  /** Minutes to take off instead of the rule's; 0 removes it; null = the rule. */
  deduct_minutes: number | null;
  decision_note: string | null;
  decided_at: string | null;
}

export const MEAL_ADJUSTMENTS_KEY = "meal-adjustments";

/** Ids per request: keeps the query string short. */
const CHUNK = 150;

/**
 * The records for these clock-ins. Only asked for while some shift could carry
 * one; a database without the table yet reads as none.
 */
export function useMealAdjustments(inPunchIds: string[], enabled = true) {
  const ids = useMemo(() => [...new Set(inPunchIds)].sort(), [inPunchIds]);
  const q = useQuery({
    queryKey: [MEAL_ADJUSTMENTS_KEY, ids],
    enabled: enabled && ids.length > 0,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      const out = new Map<string, MealAdjustment>();
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabase
          .from("meal_break_adjustments")
          .select(
            "in_punch_id, user_id, report_kind, report_minutes, report_note, reported_at, deduct_minutes, decision_note, decided_at",
          )
          .in("in_punch_id", ids.slice(i, i + CHUNK));
        if (error) return out;
        for (const r of (data ?? []) as MealAdjustment[]) out.set(r.in_punch_id, r);
      }
      return out;
    },
  });
  return q.data ?? EMPTY;
}

const EMPTY = new Map<string, MealAdjustment>();
