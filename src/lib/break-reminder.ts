import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { showAppNotification, useNotificationPrefs } from "@/lib/notification-prefs";
import { playChime } from "@/lib/notify-sound";

/**
 * "Two minutes left on your break."
 *
 * Mounted once in the authenticated layout rather than on the time clock,
 * because the whole point is to reach someone who has wandered off that page —
 * a reminder that only fires while you are watching the countdown is not a
 * reminder.
 *
 * The end of the break is known the moment it starts (the punch carries the
 * length the employee picked), so this is one timer, not a poll: it sleeps
 * until two minutes before the end and wakes up to say so. Realtime re-arms it
 * when the person punches.
 *
 * It lives in the browser, so it only fires while the app is open somewhere.
 * A reminder that survives a closed tab needs a push subscription and a
 * service worker, which is a different piece of work.
 */

/** How far ahead of the end of the break to speak up. */
export const BREAK_WARNING_MS = 2 * 60_000;

type LastPunch = {
  id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  break_minutes: number | null;
};

export function useBreakReminder(): void {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { wants, prefs } = useNotificationPrefs();
  // Whichever break has already been announced, so a re-render or a refetch
  // cannot say it twice.
  const announced = useRef<string | null>(null);

  const lastQ = useQuery({
    queryKey: ["last-punch", user?.id],
    enabled: !!user,
    queryFn: async () => {
      // RLS keeps this to the signed-in person's own punches.
      const { data, error } = await supabase
        .from("time_punches")
        .select("id, kind, at, break_minutes")
        .eq("user_id", user!.id)
        .order("at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as LastPunch | null;
    },
  });

  // Re-arm on the person's own punches: starting a break is exactly the event
  // that decides when this should fire.
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel(`break-reminder-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "time_punches",
          filter: `user_id=eq.${user.id}`,
        },
        () => void qc.invalidateQueries({ queryKey: ["last-punch", user.id] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [user, qc]);

  const last = lastQ.data ?? null;
  const onBreak = last?.kind === "break_start" && !!last.break_minutes;
  const startedAt = onBreak ? new Date(last!.at).getTime() : null;
  const minutes = onBreak ? last!.break_minutes! : null;
  const punchId = onBreak ? last!.id : null;
  const muted = !wants("break_ending");
  const desktop = prefs.desktop;
  const sound = prefs.sound;

  useEffect(() => {
    if (!punchId || startedAt == null || minutes == null || muted) return;
    // A break already announced stays announced, even if this effect re-runs.
    if (announced.current === punchId) return;

    const endsAt = startedAt + minutes * 60_000;
    const warnAt = endsAt - BREAK_WARNING_MS;
    const wait = warnAt - Date.now();

    // Already past the warning point — a page opened late, or a break shorter
    // than the warning itself. Nothing useful left to say.
    if (wait <= 0) return;

    const id = setTimeout(() => {
      announced.current = punchId;
      const title = "Break almost over";
      const body = `Two minutes left on your ${minutes}-minute break.`;
      toast.warning(title, { description: body, duration: 30_000 });
      if (sound) playChime();
      if (desktop) void showAppNotification(title, body, `break-${punchId}`, "/timeclock");
    }, wait);

    return () => clearTimeout(id);
  }, [punchId, startedAt, minutes, muted, desktop, sound]);
}
