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
 * say over who is on its rosters, set two ways:
 *
 *  - **Per person**, from the Edit member dialog (`member_visibility`): shown
 *    everywhere, on the schedule only, on the timecards only, or nowhere (a
 *    "ghost").
 *  - **The company default** for anyone without a setting of their own: an
 *    employee is shown everywhere; an admin is a ghost while the App rule
 *    "Hide admins from the rosters" is on, and shown everywhere while it is off.
 *
 * Whichever applies, it applies to every viewer, the hidden person included: a
 * person is either somebody you schedule and pay or they are not, and that
 * cannot depend on who is looking. The one exception is a platform admin
 * looking in from outside the company, who sees all of it. Anyone can still
 * open their own timecard, which is reached by name from the "Me" option rather
 * than off a roster — their pay record is theirs to read.
 *
 * Wherever this hides something an employee could otherwise have read for
 * themselves, the query that fetched it should be narrowed too — see
 * `company_presence()` in the database. A filter in the browser tidies a list;
 * it does not keep a secret.
 */

/**
 * Roles that count as an admin here. "supervisor" was folded into company_admin
 * (see `normalizeRole` in `@/lib/auth`), but rows written before the merge still
 * carry it, and someone the database still calls a supervisor is management as
 * far as this rule is concerned.
 */
const ADMIN_ROLES = ["super_admin", "company_admin", "supervisor"] as const;

/** A person's own setting; no setting means the company default. */
export type VisibilityMode = "everywhere" | "schedule_only" | "timecards_only" | "ghost";

/**
 * Where a list sits. "schedule" is the schedule grid, the posted schedule and
 * who a shift can be traded to; "timecards" the timecard roster; "roster" the
 * dashboard's list of who is on the floor, which only a ghost
 * is kept off.
 */
export type VisibilityPlace = "schedule" | "timecards" | "roster";

/** Whether a mode keeps someone off a place. Pure, for the tests and the dialog. */
export function hiddenFrom(mode: VisibilityMode, place: VisibilityPlace): boolean {
  switch (mode) {
    case "everywhere":
      return false;
    case "schedule_only":
      return place === "timecards";
    case "timecards_only":
      return place === "schedule";
    case "ghost":
      return true;
  }
}

export interface StaffVisibility {
  /** True until the settings have landed — nothing is hidden before then. */
  isLoading: boolean;
  /** Should this person be kept off this place on the signed-in user's screen? */
  isHidden: (userId: string, place: VisibilityPlace) => boolean;
  /** Drop the hidden people out of a list, given how to read each row's user id. */
  visible: <T>(rows: T[], idOf: (row: T) => string, place: VisibilityPlace) => T[];
}

export function useStaffVisibility(): StaffVisibility {
  const { company, primaryRole } = useAuth();
  const rules = useAppRules();

  // A platform admin is not in the company and is not subject to its rules;
  // everyone inside it gets the same list, admins included.
  const enforced = primaryRole !== "super_admin" && !!company?.id;
  const hideAdmins = rules.hide_admins_from_staff;

  const adminsQ = useQuery({
    queryKey: ["company-admin-ids", company?.id],
    enabled: enforced && hideAdmins,
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

  const settingsQ = useQuery({
    queryKey: ["member-visibility", company?.id],
    enabled: enforced,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("member_visibility")
        .select("user_id, mode")
        .eq("company_id", company!.id);
      // Before the migration is applied the table is missing: behave as if
      // nobody has a setting, which is exactly how things were.
      if (error) return [];
      return (data ?? []) as { user_id: string; mode: VisibilityMode }[];
    },
  });

  const adminIds = useMemo(() => new Set(adminsQ.data ?? []), [adminsQ.data]);
  const modes = useMemo(
    () => new Map((settingsQ.data ?? []).map((r) => [r.user_id, r.mode])),
    [settingsQ.data],
  );

  const isHidden = useCallback(
    (userId: string, place: VisibilityPlace) => {
      if (!enforced) return false;
      const mode = modes.get(userId) ?? (hideAdmins && adminIds.has(userId) ? "ghost" : "everywhere");
      return hiddenFrom(mode, place);
    },
    [enforced, modes, hideAdmins, adminIds],
  );

  const visible = useCallback(
    <T>(rows: T[], idOf: (row: T) => string, place: VisibilityPlace) =>
      enforced ? rows.filter((r) => !isHidden(idOf(r), place)) : rows,
    [enforced, isHidden],
  );

  return {
    isLoading: enforced && (settingsQ.isLoading || (hideAdmins && adminsQ.isLoading)),
    isHidden,
    visible,
  };
}
