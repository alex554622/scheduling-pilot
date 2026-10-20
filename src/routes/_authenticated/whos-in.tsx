import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useStaffVisibility } from "@/lib/staff-visibility";
import { Button } from "@/components/ui/button";
import { useLocaleTag, useT } from "@/lib/i18n";
import { Clock, Users, Coffee, RefreshCw, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/whos-in")({
  component: WhosInPage,
});

type Punch = {
  user_id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  distance_m: number | null;
  break_minutes: number | null;
};

type Member = { id: string; full_name: string | null; position: string | null };

function fmtElapsed(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function WhosInPage() {
  const t = useT("time");
  const tag = useLocaleTag();
  const { company, primaryRole, loading } = useAuth();
  const staff = useStaffVisibility();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!loading && !isManager) navigate({ to: "/timeclock" });
  }, [loading, isManager, navigate]);

  // tick clock for elapsed times
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const membersQ = useQuery<Member[]>({
    queryKey: ["whos-in-members", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position")
        .eq("company_id", company!.id);
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });

  // Pull recent punches (last 36h) to determine current state per user
  const punchesQ = useQuery<Punch[]>({
    queryKey: ["whos-in-punches", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const since = new Date(Date.now() - 36 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from("time_punches")
        .select("user_id, kind, at, distance_m, break_minutes")
        .eq("company_id", company!.id)
        .gte("at", since)
        .order("at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Punch[];
    },
  });

  // Who is scheduled to start today, so the list can be today's people rather
  // than the whole company. Drafts count: this is a manager's screen, and a
  // shift still being drafted is still somebody expected in.
  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const scheduledQ = useQuery<Set<string>>({
    queryKey: ["whos-in-scheduled", company?.id, todayStart.toISOString()],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const tomorrow = new Date(todayStart);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const { data, error } = await supabase
        .from("shifts")
        .select("employee_id")
        .eq("company_id", company!.id)
        .gte("starts_at", todayStart.toISOString())
        .lt("starts_at", tomorrow.toISOString());
      if (error) throw error;
      return new Set((data ?? []).map((s) => s.employee_id).filter((id): id is string => !!id));
    },
  });

  // Realtime — invalidate on any change
  useEffect(() => {
    if (!company?.id) return;
    const channel = supabase
      .channel(`time_punches_company_${company.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_punches", filter: `company_id=eq.${company.id}` },
        () => {
          qc.invalidateQueries({ queryKey: ["whos-in-punches", company.id] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [company?.id, qc]);

  const rows = useMemo(() => {
    const lastByUser = new Map<string, Punch>();
    const punchedToday = new Set<string>();
    for (const p of punchesQ.data ?? []) {
      lastByUser.set(p.user_id, p);
      if (new Date(p.at) >= todayStart) punchedToday.add(p.user_id);
    }
    const scheduled = scheduledQ.data ?? new Set<string>();
    // Today's people: scheduled to start today, punched today, or — the night
    // shift — still on the clock from a punch made yesterday evening. A rule of
    // "punched today" alone would hide exactly the one person on the floor at
    // two in the morning.
    // A ghost is on no list, this one included.
    const members = staff.visible(membersQ.data ?? [], (m) => m.id, "roster").filter((m) => {
      const last = lastByUser.get(m.id);
      const onClock = !!last && last.kind !== "out";
      return scheduled.has(m.id) || punchedToday.has(m.id) || onClock;
    });
    type Row = {
      id: string;
      name: string;
      position: string | null;
      status: "working" | "on_break" | "off";
      since: string | null;
      breakMinutes: number | null;
    };
    const list: Row[] = members.map((m) => {
      const last = lastByUser.get(m.id);
      const status: Row["status"] =
        !last || last.kind === "out" ? "off"
        : last.kind === "break_start" ? "on_break"
        : "working";
      return {
        id: m.id,
        name: m.full_name || t("Unnamed"),
        position: m.position,
        status,
        since: last?.at ?? null,
        breakMinutes: status === "on_break" ? (last?.break_minutes ?? null) : null,
      };
    });
    list.sort((a, b) => {
      const order = { working: 0, on_break: 1, off: 2 } as const;
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [membersQ.data, punchesQ.data, scheduledQ.data, todayStart, t, staff]);

  // Employees can't end a break before its time is up; an admin can, from here.
  // Recorded like any manager punch, so it shows in the correction audit.
  const endBreak = useMutation({
    mutationFn: async (r: { id: string; since: string; breakMinutes: number | null }) => {
      // Never before the break_start, even if this device's clock runs behind.
      const at = new Date(Math.max(Date.now(), new Date(r.since).getTime() + 1000));
      const { error } = await supabase.rpc("manager_insert_punch", {
        _user_id: r.id,
        _at: at.toISOString(),
        _kind: "break_end",
        _reason: "Break ended early by an admin",
        ...(r.breakMinutes != null ? { _minutes: r.breakMinutes } : {}),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t("Break ended"));
      qc.invalidateQueries({ queryKey: ["whos-in-punches"] });
    },
    onError: (e: any) => toast.error(e.message ?? t("Could not end the break")),
  });

  const counts = useMemo(() => ({
    working: rows.filter((r) => r.status === "working").length,
    onBreak: rows.filter((r) => r.status === "on_break").length,
    off: rows.filter((r) => r.status === "off").length,
  }), [rows]);

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  if (!company) return <div className="text-sm text-muted-foreground">{t("No company.")}</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("Who's clocked in")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Everyone scheduled or clocked in today, live.")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/timeclock"><ArrowLeft className="mr-2 h-4 w-4" />{t("Back to time clock")}</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["whos-in-punches"] })}>
            <RefreshCw className="mr-2 h-4 w-4" />{t("Refresh")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("Working")} value={counts.working} color="emerald" icon={<Clock className="h-4 w-4" />} />
        <Stat label={t("On break")} value={counts.onBreak} color="amber" icon={<Coffee className="h-4 w-4" />} />
        <Stat label={t("Off")} value={counts.off} color="slate" icon={<Users className="h-4 w-4" />} />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="grid grid-cols-[1.6fr_1fr_1fr] border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>{t("Employee")}</div>
          <div>{t("Status")}</div>
          <div className="text-right">{t("Since")}</div>
        </div>
        {rows.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {(membersQ.data ?? []).length === 0
              ? t("No employees yet.")
              : t("Nobody is scheduled or clocked in today.")}
          </div>
        )}
        {rows.map((r) => {
          const elapsed = r.since ? now - new Date(r.since).getTime() : 0;
          return (
            <div key={r.id} className="grid grid-cols-[1.6fr_1fr_1fr] items-center gap-2 border-b border-border px-4 py-3 text-sm last:border-0">
              <div>
                <div className="font-medium text-foreground">{r.name}</div>
                {r.position && <div className="text-xs text-muted-foreground">{r.position}</div>}
              </div>
              <div>
                {r.status === "working" && <span className="rounded bg-emerald-100 dark:bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">{t("● Working")}</span>}
                {r.status === "on_break" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                      {t("● On break")}{r.breakMinutes != null ? ` · ${t("{n}m", { n: r.breakMinutes })}` : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={endBreak.isPending}
                      onClick={() => {
                        if (!r.since) return;
                        if (!window.confirm(t("End {name}'s break now?", { name: r.name }))) return;
                        endBreak.mutate({ id: r.id, since: r.since, breakMinutes: r.breakMinutes });
                      }}
                    >
                      {t("End break")}
                    </Button>
                  </div>
                )}
                {r.status === "off" && <span className="rounded bg-slate-100 dark:bg-slate-500/15 px-2 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">{t("Off")}</span>}
              </div>
              <div className="text-right text-xs">
                {r.since ? (
                  <>
                    <div className="font-medium text-foreground">{fmtElapsed(elapsed)}</div>
                    <div className="text-muted-foreground">{new Date(r.since).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" })}</div>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, color, icon }: { label: string; value: number; color: "emerald" | "amber" | "slate"; icon: React.ReactNode }) {
  const map = {
    emerald: "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30",
    amber: "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30",
    slate: "bg-slate-50 dark:bg-slate-500/10 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-500/30",
  } as const;
  return (
    <div className={`rounded-xl border p-4 ${map[color]}`}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
