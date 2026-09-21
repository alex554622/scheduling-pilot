import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Bell, Check, CheckCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { showAppNotification, useNotificationPrefs } from "@/lib/notification-prefs";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export function NotificationsBell() {
  const { user } = useAuth();
  const { wants, prefs } = useNotificationPrefs();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Read inside the realtime handler below. Held in a ref so changing a switch
  // doesn't tear down and rebuild the subscription.
  const prefsRef = useRef({ wants, desktop: prefs.desktop });
  prefsRef.current = { wants, desktop: prefs.desktop };

  const notifsQ = useQuery({
    queryKey: ["notifications", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, type, title, body, link, read_at, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as Notification[];
    },
  });

  // Realtime: refresh on any new/updated notification for this user, and
  // announce the new ones. A bell that only counts up is no use to someone
  // looking at another screen — or at an installed app, where a notification
  // is the whole point.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => {
          void qc.invalidateQueries({ queryKey: ["notifications", user.id] });
          if (payload.eventType !== "INSERT") return;
          const row = payload.new as Notification;
          const { wants: allowed, desktop } = prefsRef.current;
          if (!allowed(row.type)) return;
          toast(row.title, { description: row.body ?? undefined, duration: 15_000 });
          if (desktop) {
            void showAppNotification(
              row.title,
              row.body ?? "",
              `notification-${row.id}`,
              row.link ?? "/dashboard",
            );
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, qc]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The triggers already skip the kinds someone has switched off, but only the
  // ones that were taught to ask. Filtering here as well means the switch holds
  // for every kind, including rows written before it was thrown.
  const items = useMemo(() => (notifsQ.data ?? []).filter((n) => wants(n.type)), [notifsQ.data, wants]);
  const unread = useMemo(() => items.filter((n) => !n.read_at).length, [items]);

  const markRead = useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", user?.id] }),
  });

  const handleClick = (n: Notification) => {
    if (!n.read_at) markRead.mutate([n.id]);
    setOpen(false);
    if (n.link) navigate({ to: n.link });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-muted-foreground hover:bg-accent"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 grid h-4 min-w-[1rem] place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">Notifications</p>
            {unread > 0 && (
              <button
                onClick={() => markRead.mutate(items.filter((n) => !n.read_at).map((n) => n.id))}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifsQ.isLoading ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">You're all caught up.</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-accent ${n.read_at ? "" : "bg-primary-soft/30"}`}
                >
                  <div className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-primary"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{n.title}</p>
                    {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </div>
                  {n.read_at && <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
