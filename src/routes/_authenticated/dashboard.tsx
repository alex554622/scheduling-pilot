import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import { breakAlertsFor, type BreakAlert, type ReminderDismissal, type ReminderKind } from "@/lib/break-reminders";
import { Button } from "@/components/ui/button";
import { Clock, Coffee, LogOut, Users, RefreshCw, CalendarDays, FileClock, AlertTriangle, X } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

type Punch = {
  id: string;
  user_id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  break_minutes: number | null;
};

type Member = { id: string; full_name: string | null; position: string | null };

type Status = "working" | "on_break" | "clocked_out" | "no_show";

function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtHours(ms: number) {
  if (ms <= 0) return "0h 00m";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

function DashboardPage() {
  const { company, primaryRole, loading } = useAuth();
  const rules = useAppRules();
  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const dayStart = useMemo(() => startOfDay(), []);
  const dayEnd = useMemo(() => endOfDay(), []);

  const membersQ = useQuery<Member[]>({
    queryKey: ["today-members", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position")
        .eq("company_id", company!.id);
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });

  const punchesQ = useQuery<Punch[]>({
    queryKey: ["today-punches", company?.id, dayStart.toISOString()],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select("id, user_id, kind, at, break_minutes")
        .eq("company_id", company!.id)
        .gte("at", dayStart.toISOString())
        .lte("at", dayEnd.toISOString())
        .order("at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Punch[];
    },
  });

  // Dismissed break reminders, shared across managers so one dismissal is
  // enough. Only managers can read them, so employees skip the query entirely.
  const dismissalsQ = useQuery<ReminderDismissal[]>({
    queryKey: ["break-dismissals", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("break_reminder_dismissals")
        .select("user_id, kind, stretch_start")
        .eq("company_id", company!.id);
      if (error) throw error;
      return (data ?? []) as ReminderDismissal[];
    },
  });

  const dismissMut = useMutation({
    mutationFn: async (v: { userId: string; kind: ReminderKind; stretchStart: number }) => {
      const { error } = await supabase.rpc("dismiss_break_reminder", {
        _user: v.userId,
        _kind: v.kind,
        _stretch_start: new Date(v.stretchStart).toISOString(),
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["break-dismissals", company?.id] }),
  });

  // Realtime
  useEffect(() => {
    if (!company?.id) return;
    const ch = supabase
      .channel(`today_punches_${company.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_punches", filter: `company_id=eq.${company.id}` },
        () => qc.invalidateQueries({ queryKey: ["today-punches", company.id] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [company?.id, qc]);

  const rows = useMemo(() => {
    const byUser = new Map<string, Punch[]>();
    for (const p of punchesQ.data ?? []) {
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
      byUser.get(p.user_id)!.push(p);
    }
    type Row = {
      id: string;
      name: string;
      position: string | null;
      status: Status;
      firstIn: string | null;
      lastOut: string | null;
      workedMs: number;
      unpaidBreakMs: number;
      paidBreakMs: number;
      breakLabel: string | null;
      alerts: BreakAlert[];
    };
    const members = membersQ.data ?? [];
    const list: Row[] = members.map((m) => {
      const punches = byUser.get(m.id) ?? [];
      let openIn: Punch | null = null;
      let openBreak: Punch | null = null;
      let workedMs = 0;
      let unpaid = 0;
      let paid = 0;
      let currentUnpaid = 0;
      let currentPaid = 0;
      let firstIn: string | null = null;
      let lastOut: string | null = null;
      for (const p of punches) {
        if (p.kind === "in") {
          if (!firstIn) firstIn = p.at;
          openIn = p;
          currentUnpaid = 0;
          currentPaid = 0;
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            workedMs += Math.max(0, gross - currentUnpaid);
            unpaid += currentUnpaid;
            paid += currentPaid;
            openIn = null;
            currentUnpaid = 0;
            currentPaid = 0;
            openBreak = null;
          }
          lastOut = p.at;
        } else if (p.kind === "break_start") {
          if (openIn && !openBreak) openBreak = p;
        } else if (p.kind === "break_end") {
          if (openBreak) {
            const elapsed = new Date(p.at).getTime() - new Date(openBreak.at).getTime();
            if (openBreak.break_minutes === 10) currentPaid += elapsed;
            else currentUnpaid += elapsed;
            openBreak = null;
          }
        }
      }
      // Live counts for ongoing shift / break
      let status: Status = "no_show";
      let breakLabel: string | null = null;
      if (openIn && openBreak) {
        status = "on_break";
        const liveBreak = now - new Date(openBreak.at).getTime();
        if (openBreak.break_minutes === 10) currentPaid += liveBreak;
        else currentUnpaid += liveBreak;
        breakLabel = openBreak.break_minutes ? `${openBreak.break_minutes}m${openBreak.break_minutes === 10 ? " · paid" : " · unpaid"}` : "Break";
      } else if (openIn) {
        status = "working";
        const live = Math.max(0, now - new Date(openIn.at).getTime() - currentUnpaid);
        workedMs += live;
        unpaid += currentUnpaid;
        paid += currentPaid;
      } else if (firstIn) {
        status = "clocked_out";
      }
      return {
        id: m.id,
        name: m.full_name || "Unnamed",
        position: m.position,
        status,
        firstIn,
        lastOut,
        workedMs,
        unpaidBreakMs: unpaid,
        paidBreakMs: paid,
        breakLabel,
        alerts: breakAlertsFor(punches, rules, dismissalsQ.data?.filter((d) => d.user_id === m.id) ?? [], now),
      };
    });
    const order: Record<Status, number> = { working: 0, on_break: 1, clocked_out: 2, no_show: 3 };
    list.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    return list;
  }, [membersQ.data, punchesQ.data, dismissalsQ.data, rules, now]);

  const overdueCount = rows.filter((r) => r.alerts.length > 0).length;

  const totals = useMemo(() => {
    const counts = { working: 0, on_break: 0, clocked_out: 0, no_show: 0 };
    let workedMs = 0;
    let unpaidMs = 0;
    let paidMs = 0;
    for (const r of rows) {
      counts[r.status]++;
      workedMs += r.workedMs;
      unpaidMs += r.unpaidBreakMs;
      paidMs += r.paidBreakMs;
    }
    return { counts, workedMs, unpaidMs, paidMs };
  }, [rows]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  // Only a super admin gets this far without a company — everyone else is caught
  // by the join gate in the authenticated layout.
  if (!company) {
    return (
      <div className="text-sm text-muted-foreground">
        This roster belongs to a company.{" "}
        <Link to="/platform" className="text-primary underline">
          Open the platform overview
        </Link>{" "}
        to pick one.
      </div>
    );
  }

  const today = new Date();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Today's roster</h1>
          <p className="text-sm text-muted-foreground">
            <CalendarDays className="mr-1 inline h-4 w-4 align-text-bottom" />
            {today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/whos-in"><Users className="mr-2 h-4 w-4" />Who's clocked in</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/timecards"><FileClock className="mr-2 h-4 w-4" />Timecards</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["today-punches"] })}>
            <RefreshCw className="mr-2 h-4 w-4" />Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Working" value={totals.counts.working} icon={<Clock className="h-4 w-4" />} color="emerald" />
        <Stat label="On break" value={totals.counts.on_break} icon={<Coffee className="h-4 w-4" />} color="amber" />
        <Stat label="Clocked out" value={totals.counts.clocked_out} icon={<LogOut className="h-4 w-4" />} color="blue" />
        <Stat label="No show" value={totals.counts.no_show} icon={<Users className="h-4 w-4" />} color="slate" />
      </div>

      {overdueCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">
              {overdueCount} {overdueCount === 1 ? "person is" : "people are"} overdue for a break
            </span>{" "}
            — flagged in red below. The flag clears itself when they take one.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SmallStat label="Total worked today" value={fmtHours(totals.workedMs)} />
        <SmallStat label="Unpaid breaks" value={fmtHours(totals.unpaidMs)} />
        <SmallStat label="Paid breaks" value={fmtHours(totals.paidMs)} />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr_1fr] border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>Employee</div>
          <div>Status</div>
          <div>First in / Last out</div>
          <div className="text-right">Break</div>
          <div className="text-right">Worked</div>
        </div>
        {rows.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No employees yet.</div>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className={`grid grid-cols-[1.6fr_1fr_1fr_1fr_1fr] items-center gap-2 border-b border-border px-4 py-3 text-sm last:border-0 ${
              r.alerts.length > 0 ? "bg-destructive/5" : ""
            }`}
          >
            <div>
              {/* An overdue break turns the name red — the thing a manager scans
                  for — with the reason underneath. */}
              <div className={`font-medium ${r.alerts.length > 0 ? "text-destructive" : "text-foreground"}`}>
                {r.name}
              </div>
              {r.alerts.length > 0 ? (
                <div className="mt-0.5 space-y-0.5">
                  {r.alerts.map((a) => (
                    <div key={a.kind} className="flex items-start gap-1 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="min-w-0">{a.message}</span>
                      {isManager && (
                        <button
                          type="button"
                          title="Dismiss until their next break"
                          disabled={dismissMut.isPending}
                          onClick={() =>
                            dismissMut.mutate({ userId: r.id, kind: a.kind, stretchStart: a.stretchStart })
                          }
                          className="ml-0.5 shrink-0 rounded p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                r.position && <div className="text-xs text-muted-foreground">{r.position}</div>
              )}
            </div>
            <div>
              {r.status === "working" && <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">● Working</span>}
              {r.status === "on_break" && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                  ● On break{r.breakLabel ? ` (${r.breakLabel})` : ""}
                </span>
              )}
              {r.status === "clocked_out" && <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Clocked out</span>}
              {r.status === "no_show" && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">No show</span>}
            </div>
            <div className="text-xs text-muted-foreground">
              {r.firstIn ? <>In {fmtTime(r.firstIn)}</> : "—"}
              {r.lastOut && <><br />Out {fmtTime(r.lastOut)}</>}
            </div>
            <div className="text-right text-xs">
              {r.unpaidBreakMs > 0 && <div className="text-muted-foreground">unpaid {fmtHours(r.unpaidBreakMs)}</div>}
              {r.paidBreakMs > 0 && <div className="text-muted-foreground">paid {fmtHours(r.paidBreakMs)}</div>}
              {r.unpaidBreakMs === 0 && r.paidBreakMs === 0 && <span className="text-muted-foreground">—</span>}
            </div>
            <div className="text-right font-medium text-foreground">{fmtHours(r.workedMs)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: "emerald" | "amber" | "blue" | "slate" }) {
  const map = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    slate: "bg-slate-50 text-slate-700 border-slate-200",
  } as const;
  return (
    <div className={`rounded-xl border p-4 ${map[color]}`}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide">{icon} {label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}
