import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { rulesForPerson, type AssignedPosition, type PositionPayRules } from "@/lib/pay-rules";

export const PAY_RULES_KEY = "position-pay-rules";

/**
 * The company's positions with their pay rules. A database without the
 * columns yet (migration not applied) reads as no rules, so every card adds up
 * exactly as it did before.
 */
export function usePositionPayRules(companyId?: string | null) {
  const { company } = useAuth();
  const cid = companyId ?? company?.id;
  const q = useQuery({
    queryKey: [PAY_RULES_KEY, cid],
    enabled: !!cid,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("id, name, paid_meal_breaks, diff_enabled, diff_label, diff_start, diff_end")
        .eq("company_id", cid!)
        .order("name");
      if (error) return { positions: [] as PositionPayRules[], missing: true };
      return { positions: (data ?? []) as PositionPayRules[], missing: false };
    },
  });
  return {
    positions: q.data?.positions ?? [],
    /** True when the columns aren't on the database yet. */
    missing: q.data?.missing ?? false,
    isLoading: q.isLoading,
  };
}

/**
 * Pay rules by person, from the positions they're assigned (employee_positions,
 * which everyone in the company can read). Only fetched once some position in
 * the company has rules; until then everyone follows the company rules.
 */
export function usePayRulesByMember() {
  const { company } = useAuth();
  const { positions } = usePositionPayRules();
  const anyRules = positions.some((p) => p.paid_meal_breaks || p.diff_enabled);
  const assignedQ = useQuery({
    queryKey: [PAY_RULES_KEY, "assigned", company?.id],
    enabled: !!company?.id && anyRules,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_positions")
        .select("employee_id, position_id, is_primary")
        .eq("company_id", company!.id);
      if (error) throw error;
      const byPerson = new Map<string, AssignedPosition[]>();
      for (const row of data ?? []) {
        const list = byPerson.get(row.employee_id) ?? [];
        list.push({ position_id: row.position_id, is_primary: row.is_primary });
        byPerson.set(row.employee_id, list);
      }
      return byPerson;
    },
  });
  const byPerson = assignedQ.data;
  return useCallback(
    (userId: string | undefined | null) =>
      userId && byPerson ? rulesForPerson(byPerson.get(userId) ?? [], positions) : null,
    [byPerson, positions],
  );
}

/** One person's pay rules. */
export function usePayRulesFor(userId: string | undefined | null) {
  const rulesOf = usePayRulesByMember();
  return useMemo(() => rulesOf(userId), [rulesOf, userId]);
}
