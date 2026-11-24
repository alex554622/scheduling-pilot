import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules, type AppRules } from "@/lib/app-rules";
import { translate } from "@/lib/i18n";

/**
 * Position rules: the clock-in, timesheet and pay settings that go with a
 * position ("Dispatcher", "Police officer"). Everyone holding the position
 * follows them, whatever their department. Only company admins set them.
 *
 * A row (`position_rules`) holds only what that position changes; any key it
 * leaves out comes from the company's App rules. The database does the same
 * merge in `member_rules()`, and that is what clock_punch, break_punch and the
 * kiosk enforce — this copy is for showing hours and buttons that agree.
 * See supabase/migrations/20261206120000_position_rules.sql.
 */
export type PositionRules = Partial<{
  /** false = no limit for this position, whatever the company sets. */
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
  cap_break_to_length: boolean;
  break_reminder_hours: number;
  lunch_reminder_hours: number;
  punch_round_minutes: number;
  daily_overtime_hours: number;
  daily_double_time_hours: number;
  overtime_threshold_hours: number;
  require_edit_note: boolean;
  /** Employees with this position see their own department's coworkers on the dashboard. */
  staff_see_coworkers: boolean;
  /** Minutes taken off a long enough shift as an unpaid meal break. 0 = off. */
  auto_meal_minutes: number;
  /** Only shifts at least this many hours long get the automatic meal break. */
  auto_meal_after_hours: number;
}>;

export type PositionRuleKey = keyof PositionRules;
/** @deprecated Rules are per position now. */
export type TeamRules = PositionRules;
/** @deprecated Rules are per position now. */
export type TeamRuleKey = PositionRuleKey;

/** The company's App rules with one position's laid over them. */
export type EffectiveRules = AppRules & {
  auto_meal_minutes: number;
  auto_meal_after_hours: number;
};

/** The automatic meal break is a position rule only: the company default is off. */
export const DEFAULT_AUTO_MEAL = { auto_meal_minutes: 0, auto_meal_after_hours: 6 };

export function mergeRules(company: AppRules, position?: PositionRules | null): EffectiveRules {
  const merged: Record<string, unknown> = { ...DEFAULT_AUTO_MEAL, ...company };
  for (const [k, v] of Object.entries(position ?? {})) {
    if (v === null || v === undefined) continue;
    // "No limit" for this position reads as the company's null.
    merged[k] = v === false && k === "early_clock_in_minutes" ? null : v;
  }
  return merged as EffectiveRules;
}

type PositionRow = { position_id: string; rules: PositionRules };

export const POSITION_RULES_KEY = "position-rules";

/**
 * Every position's rules in the selected company, keyed by position. A
 * database without the table yet reads as none, so everyone follows the App
 * rules exactly as before.
 */
export function usePositionRules() {
  const { company } = useAuth();
  return useQuery({
    queryKey: [POSITION_RULES_KEY, company?.id],
    enabled: !!company?.id,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("position_rules")
        .select("position_id, rules")
        .eq("company_id", company!.id);
      if (error) return new Map<string, PositionRules>();
      return new Map(
        ((data ?? []) as unknown as PositionRow[]).map((r) => [r.position_id, r.rules ?? {}]),
      );
    },
  });
}

/**
 * The rules that apply to each person: `rulesFor(userId)` gives the company's
 * App rules with that person's position rules laid over them.
 */
export function useMemberRules() {
  const { company } = useAuth();
  const companyRules = useAppRules();
  const positionsQ = usePositionRules();
  const membersQ = useQuery({
    queryKey: ["member-positions", company?.id],
    enabled: !!company?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("company_members").select("id, position_id");
      if (error) throw error;
      return new Map((data ?? []).map((m) => [m.id, m.position_id] as const));
    },
  });

  const byPosition = positionsQ.data;
  const members = membersQ.data;
  const base = useMemo(() => mergeRules(companyRules), [companyRules]);
  const rulesFor = useCallback(
    (userId: string | null | undefined): EffectiveRules => {
      const pos = userId ? members?.get(userId) : null;
      const own = pos ? byPosition?.get(pos) : undefined;
      return own ? mergeRules(companyRules, own) : base;
    },
    [members, byPosition, companyRules, base],
  );
  return { rulesFor, companyRules: base };
}

/** The caller's own rules: what the time clock should offer them. */
export function useMyRules(): EffectiveRules {
  const { user } = useAuth();
  const { rulesFor } = useMemberRules();
  return rulesFor(user?.id);
}

/**
 * The position-rule refusals the server sends (clock_punch, kiosk_*, the punch
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
    "A note is required when changing time for this position. Say why in the note box.",
    "Only an admin can remove time off that has been approved.",
    "Answer this request with Approve or Deny on the Time off page.",
    "A punch can't be in the future. Check the date and time.",
  ]) {
    if (msg.includes(known)) return translate(known);
  }
  return msg;
}
