import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { showAppNotification, useNotificationPrefs } from "@/lib/notification-prefs";
import { hasPushSubscription } from "@/lib/push-subscription";
import { playBreakAlert, playChime } from "@/lib/notify-sound";
import { useBreakAlertSound } from "@/lib/break-alert-sound";

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
 * It lives in the browser, so it only fires while the app is open somewhere —
 * and only reliably while somebody is actually looking at it, because a
 * backgrounded tab has its timers throttled and a locked phone has them
 * suspended. That is not a defect to work around here; it is the reason the
 * same reminder is queued by the database the moment the break starts and sent
 * by the server, which nothing can throttle. See the `push_for_break` trigger
 * in 20260922120000_web_push_notifications.sql.
 *
 * So the two divide the work rather than race: on a device registered for push
 * the server draws the system notification and this only puts a toast on the
 * screen in front of you. Without that division a timer that woke up late
 * would replace the punctual pushed notification — same `break-<punch id>` tag
 * — and buzz the phone again with seconds left on the break.
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
  // Whether this company is approved for the recorded alert on this one
  // notification. Everything else in the app chimes either way.
  const alertSound = useBreakAlertSound();
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

      // A backgrounded tab's timers are throttled, and a locked phone's are
      // suspended outright — this can fire minutes after it was set for, when
      // the device wakes. So work out what is actually left rather than
      // trusting the schedule that armed it.
      const remaining = endsAt - Date.now();
      // The break is already over. Whatever this was going to say is no longer
      // true, and "two minutes left" after the fact is worse than silence.
      if (remaining <= 0) return;

      const title = "Break almost over";
      const mins = Math.ceil(remaining / 60_000);
      const body =
        remaining > BREAK_WARNING_MS - 30_000
          ? `Two minutes left on your ${minutes}-minute break.`
          : `Under ${mins} minute${mins === 1 ? "" : "s"} left on your ${minutes}-minute break.`;

      toast.warning(title, { description: body, duration: 30_000 });
      // The one notification that gets the recorded alert, and only where
      // this company has been approved for it.
      if (sound) (alertSound ? playBreakAlert : playChime)();
      // Only where nothing else is going to say it. A device registered for
      // push has already been told by the server, on time, from a queue that
      // no amount of screen-locking can throttle — and because both use the
      // `break-<punch id>` tag, a late one here would replace the punctual one
      // and buzz the phone again with seconds to go.
      if (desktop) {
        void hasPushSubscription().then((subscribed) => {
          if (subscribed) return;
          void showAppNotification(title, body, `break-${punchId}`, "/timeclock");
        });
      }
    }, wait);

    return () => clearTimeout(id);
  }, [punchId, startedAt, minutes, muted, desktop, sound, alertSound]);
}
