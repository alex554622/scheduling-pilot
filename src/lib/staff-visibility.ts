import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAppRules } from "@/lib/app-rules";
import { useAuth } from "@/lib/auth";

/**
 * Which people an employee is allowed to see listed.
 *
 * Distinct from `@/lib/capabilities` (what the plan sells) and from row-level
 * security (what the database will hand over at all). This is the company's own
 * "keep the office off the floor's screens" rule, `hide_admins_from_staff` on
 * the App rules page.
 *
 * Wherever this hides something an employee could otherwise have read for
 * themselves, the query that fetched it should be narrowed too — see the
 * schedule's employee branch, and `company_presence()` in the database. A filter
 * in the browser tidies a list; it does not keep a secret.
 */

/**
 * Roles that count as an admin here. "supervisor" was folded into company_admin
 * (see `normalizeRole` in `@/lib/auth`), but rows written before the merge still
 * carry it, and someone the database still calls a supervisor is management as
 * far as this rule is concerned.
 */
const ADMIN_ROLES = ["super_admin", "company_admin", "supervisor"] as const;

export interface StaffVisibility {
  /** Whether the rule is hiding anyone at all for the signed-in user. */
  enforced: boolean;
  /** True until the admin list has landed — nothing is hidden before then. */
  isLoading: boolean;
  /** Should this person be kept off the signed-in user's screen? */
  isHidden: (userId: string) => boolean;
  /** Drop the hidden people out of a list, given how to read each row's user id. */
  visible: <T>(rows: T[], idOf: (row: T) => string) => T[];
}

export function useStaffVisibility(): StaffVisibility {
  const { company, primaryRole, user } = useAuth();
  const rules = useAppRules();

  // Managers run the schedule and the timecards, so they always see everyone.
  // The rule only ever narrows what an employee is shown.
  const enforced = rules.hide_admins_from_staff && primaryRole === "employee";

  const adminsQ = useQuery({
    queryKey: ["company-admin-ids", company?.id],
    enabled: enforced && !!company?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("company_id", company!.id)
        .in("role", ADMIN_ROLES);
      if (error) throw error;
      return (data ?? []).map((r) => r.user_id);
    },
  });

  const adminIds = useMemo(() => new Set(adminsQ.data ?? []), [adminsQ.data]);
  const selfId = user?.id;

  const isHidden = useCallback(
    (userId: string) => enforced && userId !== selfId && adminIds.has(userId),
    [enforced, selfId, adminIds],
  );

  const visible = useCallback(
    <T>(rows: T[], idOf: (row: T) => string) =>
      enforced ? rows.filter((r) => !isHidden(idOf(r))) : rows,
    [enforced, isHidden],
  );

  return { enforced, isLoading: enforced && adminsQ.isLoading, isHidden, visible };
}
