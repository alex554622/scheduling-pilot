import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

export type AppRules = {
  overtime_threshold_hours: number;
  /** Hours in one day before overtime. 0 = off. */
  daily_overtime_hours: number;
  /** Hours in one day before double time. 0 = off. */
  daily_double_time_hours: number;
  punch_round_minutes: number;
  workday_start_hour: number;
  require_geofence: boolean;
  allow_break_10: boolean;
  allow_break_30: boolean;
  allow_break_60: boolean;
  /**
   * Record a break as the length the employee picked, not the clock time it
   * actually took. A 30 that ran 37 comes off the shift as 30. A break cut
   * short still counts as what it was, and is flagged either way — see
   * `readBreak` in `@/lib/timecard-totals`.
   */
  cap_break_to_length: boolean;
  /** Flag an employee who has worked this long with no break. 0 turns it off. */
  break_reminder_hours: number;
  /** Same, for a proper meal break (a 30 or 60). 0 turns it off. */
  lunch_reminder_hours: number;
  auto_clockout_hours: number;
  week_start_day: number;
  allow_shift_trades: boolean;
  allow_time_off_requests: boolean;
  schedule_advance_notice_hours: number;
  /** Which schedule screen an admin gets in the menu: the builder, or the monthly sheet. */
  schedule_menu: "builder" | "sheet";
  /**
   * Keep admins out of the people an employee sees — the dashboard roster, the
   * schedule, timecards, and who they can trade a shift with. Admins still see
   * each other, and nobody is ever hidden from themselves.
   */
  hide_admins_from_staff: boolean;
};

export const DEFAULT_APP_RULES: AppRules = {
  overtime_threshold_hours: 40,
  daily_overtime_hours: 8,
  daily_double_time_hours: 12,
  punch_round_minutes: 0,
  workday_start_hour: 0,
  require_geofence: true,
  allow_break_10: true,
  allow_break_30: true,
  allow_break_60: true,
  cap_break_to_length: true,
  break_reminder_hours: 2,
  lunch_reminder_hours: 5,
  auto_clockout_hours: 0,
  week_start_day: 0,
  allow_shift_trades: true,
  allow_time_off_requests: true,
  schedule_advance_notice_hours: 24,
  schedule_menu: "builder",
  hide_admins_from_staff: true,
};

export function useAppRules() {
  const { company } = useAuth();
  const q = useQuery({
    queryKey: ["company-app-rules", company?.id],
    enabled: !!company?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("settings")
        .eq("id", company!.id)
        .maybeSingle();
      if (error) throw error;
      return { ...DEFAULT_APP_RULES, ...((data?.settings as Partial<AppRules>) ?? {}) } as AppRules;
    },
  });
  return q.data ?? DEFAULT_APP_RULES;
}

// `roundToMinutes` and `roundPunches` moved to `@/lib/timecard-totals`, next to
// the hours they now affect — rounding used to change only how a punch was
// printed, and the two had drifted apart.
