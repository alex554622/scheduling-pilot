import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

/**
 * Has this company been approved for the louder break alert?
 *
 * Approval is a platform admin's to give — the column carries a trigger saying
 * so — and it governs one notification: the two-minute warning on a break.
 * Everything else chimes. See 20260922180000_break_alert_sound.sql.
 *
 * Read on its own rather than folded into the company the auth context loads.
 * That select is on the critical path for every signed-in page, and a column
 * that has not reached the database yet would take the whole app down with it;
 * here the failure is one quiet `false` and the standard chime.
 */
export function useBreakAlertSound(): boolean {
  const { company } = useAuth();

  const q = useQuery({
    queryKey: ["company-break-alert-sound", company?.id],
    enabled: !!company?.id,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("break_alert_sound")
        .eq("id", company!.id)
        .maybeSingle();
      if (error) return false;
      return (data as { break_alert_sound?: boolean } | null)?.break_alert_sound === true;
    },
  });

  return q.data === true;
}
