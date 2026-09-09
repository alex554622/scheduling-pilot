import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

/**
 * A company's free trial, as the database sees it.
 *
 * The clock starts when a super admin approves the company, not when it is
 * created — see the `start_trial_on_approval` trigger.
 */
export interface TrialStatus {
  /** Running right now. */
  trialing: boolean;
  /** Ran, and has since lapsed — the company has lost its capabilities. */
  expired: boolean;
  ends_at?: string | null;
  days_left?: number;
  /** Plan the trial grants, e.g. "Enterprise". */
  plan?: string | null;
}

const NO_TRIAL: TrialStatus = { trialing: false, expired: false };

export function useTrialStatus(): { trial: TrialStatus; isLoading: boolean } {
  const { company, primaryRole } = useAuth();
  // A super admin has no company of their own, so nothing to count down.
  const enabled = !!company?.id && primaryRole !== "super_admin";

  const q = useQuery({
    queryKey: ["company-trial", company?.id],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("company_trial_status", { _company: company!.id });
      if (error) throw error;
      return (data ?? NO_TRIAL) as TrialStatus;
    },
  });

  return { trial: q.data ?? NO_TRIAL, isLoading: enabled && q.isLoading };
}

/** "3 days left" / "Last day" / "1 day left" — for a countdown chip. */
export function trialCountdown(daysLeft: number | undefined): string {
  if (daysLeft == null) return "";
  if (daysLeft <= 0) return "Last day";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}
