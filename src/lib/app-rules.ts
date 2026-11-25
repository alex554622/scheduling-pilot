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
   * Keep admins off the rosters — the dashboard, the schedule grid, timecards,
   * and who a shift can be traded with. On every screen and for every viewer,
   * so a hidden admin is hidden from their own grid too. A platform admin
   * looking in from outside the company still sees everyone.
   */
  hide_admins_from_staff: boolean;
  /**
   * Whether an employee's dashboard lists the coworkers in their own
   * department. Off (the default), it shows only them — their own status and
   * their own shift — and `company_presence()` hands them nothing but their
   * own row. A position can set its own in Employee position rules. Supervisors always see the
   * departments they run; admins see everyone.
   */
  staff_see_coworkers: boolean;
  /**
   * Each department as its own group: an employee sees only the people,
   * open shifts, time off and trades of their own department (plus people with no
   * department, their supervisors and anyone they supervise). The schedule is
   * not narrowed by it: everyone sees everyone's shifts except ghosts. Enforced
   * by the database —
   * 20261129120000_department_separation.sql. Admins always see everything.
   */
  departments_separate: boolean;
  /**
   * Read clock-ins against the published schedule and mark anyone who arrives
   * after their shift start as late, on the time clock and the timecard. Off,
   * the schedule and the clock know nothing of each other. See `@/lib/lateness`.
   */
  schedule_lateness: boolean;
  /** Minutes after the shift start that still count as on time. */
  late_grace_minutes: number;
  /**
   * Supervisors may record absences on their people's cards. (Time-off
   * requests always go through supervisors, then an admin.)
   */
  supervisors_approve_time_off: boolean;
  /** Supervisors may fix their people's punches and write notes on their cards. */
  supervisors_edit_timecards: boolean;
  /**
   * How many minutes before a published shift (that day) someone may clock in.
   * null = any time. Enforced by clock_punch and kiosk_punch.
   */
  early_clock_in_minutes: number | null;
  /** Refuse a clock-in/out made with GPS off, instead of letting it through and telling the admins. */
  require_gps: boolean;
  /** Whether the shared clock-in tablet takes this person's code. */
  allow_kiosk: boolean;
  /** An admin or supervisor changing someone's punches must give a reason. */
  require_edit_note: boolean;
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
  // On: everyone sees who is working in their own department (see
  // company_presence() in 20261207120000_company_schedule_for_everyone.sql).
  staff_see_coworkers: true,
  departments_separate: false,
  schedule_lateness: false,
  late_grace_minutes: 5,
  supervisors_approve_time_off: true,
  supervisors_edit_timecards: true,
  early_clock_in_minutes: null,
  require_gps: false,
  allow_kiosk: true,
  require_edit_note: false,
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
