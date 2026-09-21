import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAppRules } from "@/lib/app-rules";
import { useAuth } from "@/lib/auth";

/**
 * Which people are listed, on anyone's screen.
 *
 * Distinct from `@/lib/capabilities` (what the plan sells) and from row-level
 * security (what the database will hand over at all). This is the company's own
 * "keep the office off the rosters" rule, `hide_admins_from_staff` on the App
 * rules page.
 *
 * It started as a rule about what staff were shown, and the office stayed on
 * the manager's own lists — so a company that had decided its admins are not
 * part of the roster still found them in the schedule grid, on the timecard
 * table and on Today's roster, including their own row. An admin is either
 * somebody you schedule and pay or they are not; it cannot depend on who is
 * looking, and least of all on whether they are looking at themselves. The rule
 * applies to every company screen and to every viewer, the hidden admin
 * included. The one exception is a platform admin looking in from outside the
 * company, who sees all of it.
 *
 * An admin can still open their own timecard, which is reached by name from the
 * "Me" option rather than off a roster — their pay record is theirs to read.
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
  const { company, primaryRole } = useAuth();
  const rules = useAppRules();

  // A platform admin is not in the company and is not subject to its rules;
  // everyone inside it gets the same list, admins included.
  const enforced = rules.hide_admins_from_staff && primaryRole !== "super_admin";

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

  // No exemption for the viewer. The rule only ever hides an admin, so the
  // only person it could excuse is an admin looking at themselves — and an
  // admin who is not on the roster is not on it in their own browser either.
  // An employee is never in `adminIds`, so they can never vanish from their
  // own screens.
  const isHidden = useCallback(
    (userId: string) => enforced && adminIds.has(userId),
    [enforced, adminIds],
  );

  const visible = useCallback(
    <T>(rows: T[], idOf: (row: T) => string) =>
      enforced ? rows.filter((r) => !isHidden(idOf(r))) : rows,
    [enforced, isHidden],
  );

  return { enforced, isLoading: enforced && adminsQ.isLoading, isHidden, visible };
}
