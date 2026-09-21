import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { showAppNotification, useNotificationPrefs } from "@/lib/notification-prefs";
import { playChime } from "@/lib/notify-sound";

/**
 * A pop-up and a chime when someone posts on Messages, wherever you are in the
 * app. Mounted once in the authenticated layout.
 *
 * Board messages never become notification rows — one per post per person
 * would bury the bell under the day's small talk — so this listens to the
 * board itself. Announcements are left to the bell, which already pops them
 * from the notification row they do write; answering them here too would
 * pop every announcement twice.
 *
 * On the Messages page itself the post is already appearing in the list, so it
 * chimes but does not pop.
 */
export function useMessageAlerts(): void {
  const { user, profile } = useAuth();
  const companyId = profile?.company_id ?? null;
  const { wants, prefs } = useNotificationPrefs();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });

  // Same query the Messages page uses, so the two share one cached answer.
  const namesQ = useQuery({
    queryKey: ["message-author-names", companyId],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", companyId!);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.full_name || "Unnamed"]));
    },
  });

  // Read inside the subscription below. Held in a ref so a switch flipped on
  // Settings, or a move to another page, does not rebuild the subscription.
  const live = useRef({ wants, prefs, path, names: namesQ.data, navigate });
  live.current = { wants, prefs, path, names: namesQ.data, navigate };

  useEffect(() => {
    if (!companyId || !user) return;
    const ch = supabase
      .channel(`message-alerts-${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "company_messages",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const m = payload.new as {
            id: string;
            author_id: string;
            body: string;
            is_announcement: boolean;
          };
          // Your own post is not news to you, and announcements are the bell's.
          if (m.author_id === user.id || m.is_announcement) return;
          const { wants: allowed, prefs: p, path: here, names, navigate: go } = live.current;
          if (!allowed("board_message")) return;

          const who = names?.get(m.author_id) ?? "Someone";
          const onBoard = here === "/messages";
          const preview = m.body.length > 120 ? `${m.body.slice(0, 120)}…` : m.body;

          if (p.sound) playChime();
          if (p.popup && !onBoard) {
            toast(`${who} posted a message`, {
              description: preview,
              duration: 15_000,
              closeButton: true,
              action: { label: "Open", onClick: () => go({ to: "/messages" }) },
            });
          }
          if (p.desktop && (onBoard ? document.hidden : true)) {
            void showAppNotification(
              `${who} posted a message`,
              preview,
              `msg-${m.id}`,
              "/messages",
            );
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [companyId, user]);
}
