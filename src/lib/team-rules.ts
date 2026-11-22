import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules, type AppRules } from "@/lib/app-rules";
import { translate } from "@/lib/i18n";

/**
 * Team rules: clock-in and timesheet settings one department sets for itself.
 *
 * A team row (`department_rules`) holds only what that team changes; any key
 * it leaves out comes from the company's App rules. The database does the same
 * merge in `member_rules()`, and that is what clock_punch, break_punch and the
 * kiosk enforce — this copy is for showing hours and buttons that agree.
 */
export type TeamRules = Partial<{
  /** false = no limit for this team, whatever the company sets. */
  early_clock_in_minutes: number | false;
  /** Mark late clock-ins against the schedule (see `@/lib/lateness`). */
  schedule_lateness: boolean;
  /** Minutes after the shift start that still count as on time. */
  late_grace_minutes: number;
  require_geofence: boolean;
  require_gps: boolean;
  allow_kiosk: boolean;
  allow_break_10: boolean;
  allow_break_30: boolean;
  allow_break_60: boolean;
  punch_round_minutes: number;
  daily_overtime_hours: number;
  daily_double_time_hours: number;
  overtime_threshold_hours: number;
  require_edit_note: boolean;
}>;

export type TeamRuleKey = keyof TeamRules;

/** The company's App rules with one team's laid over them. */
export type EffectiveRules = AppRules;

export function mergeRules(company: AppRules, team?: TeamRules | null): EffectiveRules {
  const merged: Record<string, unknown> = { ...company };
  for (const [k, v] of Object.entries(team ?? {})) {
    if (v === null || v === undefined) continue;
    // "No limit" for this team reads as the company's null.
    merged[k] = v === false && k === "early_clock_in_minutes" ? null : v;
  }
  return merged as EffectiveRules;
}

type TeamRow = { department_id: string; rules: TeamRules };

/** Every team's rules in the selected company, keyed by department. */
export function useDepartmentRules() {
  const { company } = useAuth();
  return useQuery({
    queryKey: ["department-rules", company?.id],
    enabled: !!company?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("department_rules")
        .select("department_id, rules")
        .eq("company_id", company!.id);
      if (error) throw error;
      return new Map(
        ((data ?? []) as unknown as TeamRow[]).map((r) => [r.department_id, r.rules ?? {}]),
      );
    },
  });
}

/**
 * The rules that apply to each person: `rulesFor(userId)` gives the company's
 * App rules with that person's team rules laid over them.
 */
export function useMemberRules() {
  const { company } = useAuth();
  const companyRules = useAppRules();
  const teamsQ = useDepartmentRules();
  const membersQ = useQuery({
    queryKey: ["member-departments", company?.id],
    enabled: !!company?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("company_members").select("id, department_id");
      if (error) throw error;
      return new Map((data ?? []).map((m) => [m.id, m.department_id] as const));
    },
  });

  const teams = teamsQ.data;
  const members = membersQ.data;
  const base = useMemo(() => mergeRules(companyRules), [companyRules]);
  const rulesFor = useCallback(
    (userId: string | null | undefined): EffectiveRules => {
      const dept = userId ? members?.get(userId) : null;
      const team = dept ? teams?.get(dept) : undefined;
      return team ? mergeRules(companyRules, team) : base;
    },
    [members, teams, companyRules, base],
  );
  return { rulesFor, companyRules: base };
}

/** The caller's own rules: what the time clock should offer them. */
export function useMyRules(): EffectiveRules {
  const { user } = useAuth();
  const { rulesFor } = useMemberRules();
  return rulesFor(user?.id);
}

/** The teams the caller may edit rules for (all of them for an admin). */
export function useMyRuleDepartments() {
  const { company, user } = useAuth();
  return useQuery({
    queryKey: ["my-rule-departments", company?.id, user?.id],
    enabled: !!company?.id && !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_rule_departments");
      // Before the migration is applied the function is missing: no teams.
      if (error) return [] as string[];
      return (data ?? []) as string[];
    },
  });
}

/**
 * The team-rule refusals the server sends (clock_punch, kiosk_*, the punch
 * edit trigger), in the reader's language. Any other message passes through.
 */
export function translateRuleMessage(msg: string | undefined | null): string | undefined {
  if (!msg) return undefined;
  // The body of a late_clock_in notification.
  const late = msg.match(/^(.+) clocked in (\d+) min after their shift started\.$/);
  if (late) {
    return translate("{name} clocked in {n} min after their shift started.", {
      name: late[1],
      n: late[2],
    });
  }
  const early = msg.match(
    /Too early to clock in: your shift starts at (.+?)\. You can clock in from (.+?)\./,
  );
  if (early) {
    return translate(
      "Too early to clock in: your shift starts at {start}. You can clock in from {from}.",
      {
        start: early[1],
        from: early[2],
      },
    );
  }
  for (const known of [
    "Your team needs your GPS location to clock in. Turn on location and try again.",
    "Your team can't use the shared clock-in. Clock in from the app on your own phone.",
    "A note is required when changing time for this team. Say why in the note box.",
  ]) {
    if (msg.includes(known)) return translate(known);
  }
  return msg;
}
