import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { BarChart3, Download, Clock, Users, CalendarOff, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/reports")({
  component: ReportsPage,
});

interface ShiftRow {
  id: string;
  employee_id: string;
  starts_at: string;
  ends_at: string;
  position: string;
  published: boolean;
}
interface MemberRow { id: string; full_name: string; position: string | null }
interface TimeOffRow { id: string; employee_id: string; start_date: string; end_date: string; kind: string; status: string }

function startOfWeek(d: Date) {
  const x = new Date(d); const dow = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - dow); return x;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDay(d: Date) { return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
function isoDate(d: Date) { return d.toISOString().slice(0, 10); }

type RangeKey = "this_week" | "last_week" | "last_30" | "this_month";

function rangeFor(key: RangeKey): { start: Date; end: Date; label: string } {
  const now = new Date();
  if (key === "this_week") {
    const start = startOfWeek(now); return { start, end: addDays(start, 7), label: "This week" };
  }
  if (key === "last_week") {
    const start = addDays(startOfWeek(now), -7); return { start, end: addDays(start, 7), label: "Last week" };
  }
  if (key === "this_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start, end, label: "This month" };
  }
  const end = new Date(now); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
  const start = addDays(end, -30);
  return { start, end, label: "Last 30 days" };
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function ReportsPage() {
  const { primaryRole, profile, loading } = useAuth();
  const navigate = useNavigate();
  const companyId = profile?.company_id ?? null;
  const canView = primaryRole === "company_admin" || primaryRole === "super_admin";

  useEffect(() => {
    if (!loading && primaryRole && !canView) navigate({ to: "/dashboard" });
  }, [loading, primaryRole, canView, navigate]);

  const [rangeKey, setRangeKey] = useState<RangeKey>("this_week");
  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);

  const membersQ = useQuery({
    queryKey: ["report-members", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id, full_name, position")
        .eq("company_id", companyId!).order("full_name");
      if (error) throw error;
      return (data ?? []) as MemberRow[];
    },
  });

  const shiftsQ = useQuery({
    queryKey: ["report-shifts", companyId, range.start.toISOString(), range.end.toISOString()],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at, position, published")
        .eq("company_id", companyId!)
        .gte("starts_at", range.start.toISOString())
        .lt("starts_at", range.end.toISOString())
        .order("starts_at");
      if (error) throw error;
      return (data ?? []) as ShiftRow[];
    },
  });

  const timeOffQ = useQuery({
    queryKey: ["report-timeoff", companyId, isoDate(range.start), isoDate(range.end)],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, employee_id, start_date, end_date, kind, status")
        .eq("company_id", companyId!)
        .gte("start_date", isoDate(range.start))
        .lt("start_date", isoDate(range.end));
      if (error) throw error;
      return (data ?? []) as TimeOffRow[];
    },
  });

  const members = membersQ.data ?? [];
  const shifts = shiftsQ.data ?? [];
  const timeOff = timeOffQ.data ?? [];
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((p) => m.set(p.id, p.full_name || "Unnamed"));
    return m;
  }, [members]);

  // Hours per employee
  const perEmployee = useMemo(() => {
    const map = new Map<string, { shifts: number; minutes: number; published: number }>();
    members.forEach((m) => map.set(m.id, { shifts: 0, minutes: 0, published: 0 }));
    shifts.forEach((s) => {
      const e = map.get(s.employee_id) ?? { shifts: 0, minutes: 0, published: 0 };
      e.shifts++;
      e.minutes += (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000;
      if (s.published) e.published++;
      map.set(s.employee_id, e);
    });
    return members.map((m) => ({
      id: m.id,
      name: m.full_name || "Unnamed",
      position: m.position ?? "",
      ...(map.get(m.id) ?? { shifts: 0, minutes: 0, published: 0 }),
    })).sort((a, b) => b.minutes - a.minutes);
  }, [members, shifts]);

  const totalMinutes = perEmployee.reduce((s, e) => s + e.minutes, 0);
  const totalShifts = shifts.length;
  const draftShifts = shifts.filter((s) => !s.published).length;

  // Time off summary
  const timeOffSummary = useMemo(() => {
    const byEmp = new Map<string, number>();
    const byKind: Record<string, number> = {};
    let approved = 0, pending = 0, denied = 0;
    timeOff.forEach((t) => {
      const d = Math.max(1, Math.round((new Date(t.end_date).getTime() - new Date(t.start_date).getTime()) / 86400000) + 1);
      byEmp.set(t.employee_id, (byEmp.get(t.employee_id) ?? 0) + d);
      byKind[t.kind] = (byKind[t.kind] ?? 0) + d;
      if (t.status === "approved") approved += d;
      else if (t.status === "pending") pending++;
      else if (t.status === "denied") denied++;
    });
    return { byEmp, byKind, approved, pending, denied, count: timeOff.length };
  }, [timeOff]);

  // Coverage gaps: days in the range with zero published shifts
  const coverageGaps = useMemo(() => {
    const days: Date[] = [];
    for (let d = new Date(range.start); d < range.end; d = addDays(d, 1)) days.push(new Date(d));
    return days.map((d) => {
      const next = addDays(d, 1);
      const count = shifts.filter((s) => {
        const t = new Date(s.starts_at).getTime();
        return s.published && t >= d.getTime() && t < next.getTime();
      }).length;
      return { day: d, count };
    });
  }, [shifts, range]);
  const emptyDays = coverageGaps.filter((c) => c.count === 0).length;

  const exportShiftsCsv = () => {
    const rows: (string | number)[][] = [["Employee", "Position", "Date", "Start", "End", "Hours", "Status"]];
    shifts.forEach((s) => {
      const start = new Date(s.starts_at), end = new Date(s.ends_at);
      const hours = ((end.getTime() - start.getTime()) / 3600000).toFixed(2);
      rows.push([
        nameOf.get(s.employee_id) ?? s.employee_id,
        s.position || "",
        start.toLocaleDateString(),
        start.toLocaleTimeString(),
        end.toLocaleTimeString(),
        hours,
        s.published ? "published" : "draft",
      ]);
    });
    downloadCsv(`shifts_${isoDate(range.start)}_${isoDate(addDays(range.end, -1))}.csv`, rows);
  };

  const exportHoursCsv = () => {
    const rows: (string | number)[][] = [["Employee", "Position", "Shifts", "Published", "Hours"]];
    perEmployee.forEach((e) => rows.push([e.name, e.position, e.shifts, e.published, (e.minutes / 60).toFixed(2)]));
    downloadCsv(`hours_${isoDate(range.start)}_${isoDate(addDays(range.end, -1))}.csv`, rows);
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!canView) return <div className="text-sm text-muted-foreground">You don't have access to this page.</div>;
  if (!companyId) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Join or create a company to see reports.</div>;

  const maxMinutes = Math.max(1, ...perEmployee.map((e) => e.minutes));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Reports</h2>
          <p className="text-sm text-muted-foreground">Hours, coverage, and time off for {range.label.toLowerCase()}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(["this_week", "last_week", "this_month", "last_30"] as RangeKey[]).map((k) => (
            <Button key={k} size="sm" variant={rangeKey === k ? "default" : "outline"} onClick={() => setRangeKey(k)}>
              {rangeFor(k).label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Clock} label="Scheduled hours" value={(totalMinutes / 60).toFixed(1)} sub={`${totalShifts} shifts`} />
        <StatTile icon={Users} label="Staff with shifts" value={String(perEmployee.filter((e) => e.shifts > 0).length)} sub={`${members.length} total`} />
        <StatTile icon={CalendarOff} label="Time-off days" value={String(timeOffSummary.approved)} sub={`${timeOffSummary.count} requests`} tone="muted" />
        <StatTile icon={AlertTriangle} label="Uncovered days" value={String(emptyDays)} sub={`${draftShifts} draft shifts`} tone={emptyDays > 0 ? "warning" : "success"} />
      </div>

      <Section title="Hours per employee" action={
        <Button variant="outline" size="sm" onClick={exportHoursCsv} disabled={perEmployee.length === 0}>
          <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
        </Button>
      }>
        {shiftsQ.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : perEmployee.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No employees in this company yet.</p>
        ) : (
          <div className="space-y-2">
            {perEmployee.map((e) => {
              const hours = e.minutes / 60;
              const pct = (e.minutes / maxMinutes) * 100;
              return (
                <div key={e.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium text-foreground">{e.name}</span>
                      <span className="text-xs text-muted-foreground">{e.shifts} shifts · {hours.toFixed(1)}h</span>
                    </div>
                    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${hours > 40 ? "bg-warning/20 text-warning-foreground" : "bg-muted text-muted-foreground"}`}>
                    {hours > 40 ? "Over 40h" : `${hours.toFixed(0)}h`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Coverage by day">
          {coverageGaps.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No data.</p>
          ) : (
            <ul className="divide-y divide-border">
              {coverageGaps.map((c) => (
                <li key={c.day.toISOString()} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-foreground">{fmtDay(c.day)}</span>
                  <span className={c.count === 0 ? "rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning-foreground" : "text-muted-foreground"}>
                    {c.count === 0 ? "No coverage" : `${c.count} shift${c.count === 1 ? "" : "s"}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Time off breakdown">
          {timeOff.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No time-off requests in this range.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-md bg-success-soft p-2"><div className="font-semibold text-success">{timeOffSummary.approved}</div><div className="text-muted-foreground">Approved days</div></div>
                <div className="rounded-md bg-warning/20 p-2"><div className="font-semibold text-warning-foreground">{timeOffSummary.pending}</div><div className="text-muted-foreground">Pending</div></div>
                <div className="rounded-md bg-muted p-2"><div className="font-semibold text-foreground">{timeOffSummary.denied}</div><div className="text-muted-foreground">Denied</div></div>
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">By kind</p>
                <div className="space-y-1.5">
                  {Object.entries(timeOffSummary.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="capitalize text-foreground">{k}</span>
                      <span className="text-muted-foreground">{v} day{v === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Section>
      </div>

      <Section title="All shifts in range" action={
        <Button variant="outline" size="sm" onClick={exportShiftsCsv} disabled={shifts.length === 0}>
          <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
        </Button>
      }>
        {shifts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No shifts scheduled in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Time</th><th className="px-3 py-2">Position</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shifts.slice(0, 50).map((s) => {
                  const start = new Date(s.starts_at), end = new Date(s.ends_at);
                  return (
                    <tr key={s.id} className="text-foreground">
                      <td className="px-3 py-2">{nameOf.get(s.employee_id) ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{start.toLocaleDateString()}</td>
                      <td className="px-3 py-2 text-muted-foreground">{start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – {end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                      <td className="px-3 py-2 text-muted-foreground">{s.position || "—"}</td>
                      <td className="px-3 py-2"><span className={s.published ? "rounded-full bg-success-soft px-2 py-0.5 text-xs text-success" : "rounded-full bg-warning/20 px-2 py-0.5 text-xs text-warning-foreground"}>{s.published ? "Published" : "Draft"}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shifts.length > 50 && (
              <p className="mt-3 text-center text-xs text-muted-foreground">Showing 50 of {shifts.length}. Export CSV for the full list.</p>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, sub, tone = "primary" }: { icon: typeof BarChart3; label: string; value: string; sub?: string; tone?: "primary" | "success" | "warning" | "muted" }) {
  const map = {
    primary: "bg-primary-soft text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning/20 text-warning-foreground",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${map[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h3 className="font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
