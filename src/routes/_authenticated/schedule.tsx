import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";
import { useCapabilities } from "@/lib/capabilities";
import { ScheduleRunsPanel } from "@/components/schedule-runs-panel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  Users,
  Clock,
  AlertTriangle,
  Building2,
  Activity,
  Plus,
  Trash2,
  Copy,
  ShieldCheck,
  Loader2,
  Download,
  CalendarRange,
} from "lucide-react";
import { SHIFT_COLORS, shiftColorClass, shiftColorHex } from "@/lib/shift-colors";

export const Route = createFileRoute("/_authenticated/schedule")({
  component: SchedulePage,
});

/* ----------------------------- Helpers ----------------------------- */

// Show the current week (Mon–Sun) anchored to today.
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: d.getMinutes() ? "2-digit" : undefined,
  });
}
function fmtDayLabel(d: Date): string {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function toLocalInput(d: Date): string {
  // datetime-local needs YYYY-MM-DDTHH:MM in local time
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ShiftRow {
  id: string;
  company_id: string;
  /** Null for an open (unassigned) shift — those simply don't match a member row here. */
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string;
  position_id: string | null;
  color: string;
  published: boolean;
}

interface MemberRow {
  id: string;
  full_name: string;
  position: string | null;
}

const WEEKLY_HOUR_LIMIT = 40;

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/** "8", "7.5", "4.25" — trailing zeros dropped so the field reads cleanly. */
function fmtHoursValue(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "";
  return String(Math.round(hours * 100) / 100);
}

/* ----------------------------- Root ----------------------------- */

function SchedulePage() {
  const { primaryRole, loading } = useAuth();
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!primaryRole) return <NoRoleState />;
  if (primaryRole === "super_admin") return <SuperAdminDashboard />;
  return <CompanyDashboard role={primaryRole} />;
}

function NoRoleState() {
  const { user, signOut } = useAuth();
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
      <ShieldCheck className="mx-auto h-10 w-10 text-primary" />
      <h2 className="mt-4 text-xl font-semibold text-foreground">Account not assigned</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {user?.email} isn't part of a company yet. Ask your manager to share their company join
        code, then sign up again with that code — or wait for an invitation.
      </p>
      <Button className="mt-6" variant="outline" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}

/* ----------------------------- Shared UI ----------------------------- */

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  tone = "primary",
}: {
  icon: typeof Calendar;
  label: string;
  value: string;
  sub?: string;
  tone?: "primary" | "success" | "warning" | "muted";
}) {
  const toneMap = {
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
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${toneMap[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-4 sm:px-5">
        <h3 className="font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

/* ----------------------------- Super Admin ----------------------------- */

function SuperAdminDashboard() {
  const { data: companies = [], isLoading } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name, plan, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Platform overview</h2>
        <p className="text-sm text-muted-foreground">
          Real-time view of every company on Scheduling Pilot.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Building2} label="Companies" value={String(companies.length)} />
        <Stat
          icon={Activity}
          label="Active"
          value={String(companies.filter((c) => c.status === "active").length)}
          tone="success"
        />
        <Stat
          icon={AlertTriangle}
          label="Past due"
          value={String(companies.filter((c) => c.status === "past_due").length)}
          tone="warning"
        />
        <Stat
          icon={Calendar}
          label="New this week"
          value={String(
            companies.filter((c) => Date.now() - new Date(c.created_at).getTime() < 7 * 86400000)
              .length,
          )}
          tone="muted"
        />
      </div>

      <SectionCard title="Companies">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : companies.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No companies yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {companies.map((c) => (
                  <tr key={c.id} className="text-foreground">
                    <td className="px-3 py-3 font-medium">{c.name}</td>
                    <td className="px-3 py-3 text-muted-foreground">{c.plan}</td>
                    <td className="px-3 py-3 text-muted-foreground">{c.status}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/* ----------------------------- Company Dashboard ----------------------------- */

type ScheduleView = "day" | "week" | "twoweek" | "month";
const VIEW_LABEL: Record<ScheduleView, string> = {
  day: "Day",
  week: "Week",
  twoweek: "2-Week",
  month: "Month",
};
const VIEW_STORAGE_KEY = "ps-schedule-view";

function startOfMonth(d: Date): Date {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfMonth(d: Date): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + 1, 1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function CompanyDashboard({ role }: { role: AppRole }) {
  const { profile, company, user } = useAuth();
  const { capabilities } = useCapabilities();
  const companyId = profile?.company_id;
  const canEdit = role === "company_admin";

  const [view, setView] = useState<ScheduleView>(() => {
    if (typeof window === "undefined") return "week";
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === "day" || v === "week" || v === "twoweek" || v === "month" ? v : "week";
  });
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const { rangeStart, rangeEnd, days } = useMemo(() => {
    if (view === "day") {
      const d = new Date(anchor);
      d.setHours(0, 0, 0, 0);
      return { rangeStart: d, rangeEnd: addDays(d, 1), days: [d] };
    }
    if (view === "twoweek") {
      const s = startOfWeek(anchor);
      const ds = Array.from({ length: 14 }, (_, i) => addDays(s, i));
      return { rangeStart: s, rangeEnd: addDays(s, 14), days: ds };
    }
    if (view === "month") {
      const s = startOfMonth(anchor);
      const e = endOfMonth(anchor);
      const ds: Date[] = [];
      for (let d = new Date(s); d < e; d = addDays(d, 1)) ds.push(new Date(d));
      return { rangeStart: s, rangeEnd: e, days: ds };
    }
    const s = startOfWeek(anchor);
    const ds = Array.from({ length: 7 }, (_, i) => addDays(s, i));
    return { rangeStart: s, rangeEnd: addDays(s, 7), days: ds };
  }, [view, anchor]);

  const membersQ = useQuery({
    queryKey: ["members", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position")
        .eq("company_id", companyId!)
        .order("full_name");
      if (error) throw error;
      return data as MemberRow[];
    },
  });

  const shiftsQ = useQuery({
    queryKey: ["shifts", companyId, rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("*")
        .eq("company_id", companyId!)
        .gte("starts_at", rangeStart.toISOString())
        .lt("starts_at", rangeEnd.toISOString())
        .order("starts_at");
      if (error) throw error;
      return data as ShiftRow[];
    },
  });

  if (!companyId || !company) return <NoRoleState />;

  const members = membersQ.data ?? [];
  const shifts = shiftsQ.data ?? [];

  if (role === "employee") {
    const ws = startOfWeek(new Date());
    const wdays = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    return (
      <EmployeeView
        userId={user!.id}
        days={wdays}
        shifts={shifts.filter((s) => s.employee_id === user!.id)}
      />
    );
  }

  return (
    <div className="space-y-8">
      <ScheduleBuilder
        role={role}
        companyId={companyId}
        companyName={company.name}
        members={members}
        shifts={shifts}
        days={days}
        anchor={anchor}
        setAnchor={setAnchor}
        view={view}
        setView={setView}
        canEdit={canEdit}
        isLoading={membersQ.isLoading || shiftsQ.isLoading}
      />

      {/* Generating a schedule and then fixing it up is one job, so it lives
          under the builder rather than on a page of its own. */}
      {canEdit && capabilities.auto_scheduling && <ScheduleRunsPanel companyId={companyId} />}
    </div>
  );
}

/* ----------------------------- Employee view ----------------------------- */

function EmployeeView({
  userId,
  days,
  shifts,
}: {
  userId: string;
  days: Date[];
  shifts: ShiftRow[];
}) {
  void userId;
  const totalMin = shifts.reduce(
    (s, sh) => s + (new Date(sh.ends_at).getTime() - new Date(sh.starts_at).getTime()) / 60000,
    0,
  );
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">My week</h2>
        <p className="text-sm text-muted-foreground">
          {fmtDayLabel(days[0])} – {fmtDayLabel(days[6])}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat icon={Calendar} label="Shifts" value={String(shifts.length)} />
        <Stat icon={Clock} label="Hours" value={(totalMin / 60).toFixed(1)} tone="success" />
        <Stat
          icon={Activity}
          label="Published"
          value={String(shifts.filter((s) => s.published).length)}
          tone="muted"
        />
      </div>
      <SectionCard title="My upcoming shifts">
        {shifts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No shifts scheduled this week.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shifts.map((s) => {
              const start = new Date(s.starts_at);
              const end = new Date(s.ends_at);
              return (
                <li key={s.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{fmtDayLabel(start)}</p>
                    <p className="text-xs text-muted-foreground">{s.position || "—"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary">
                      {fmtTime(start)} – {fmtTime(end)}
                    </span>
                    {!s.published && (
                      <span className="rounded-full bg-warning/20 px-2 py-0.5 text-[10px] font-medium text-warning-foreground">
                        Draft
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ----------------------------- Schedule Builder ----------------------------- */

interface EditTarget {
  memberId: string;
  memberName: string;
  day: Date;
  shift: ShiftRow | null;
}

interface BuilderProps {
  role: AppRole;
  companyId: string;
  companyName: string;
  members: MemberRow[];
  shifts: ShiftRow[];
  days: Date[];
  anchor: Date;
  setAnchor: (d: Date) => void;
  view: ScheduleView;
  setView: (v: ScheduleView) => void;
  canEdit: boolean;
  isLoading: boolean;
}

function ScheduleBuilder(props: BuilderProps) {
  const {
    role,
    companyId,
    companyName,
    members,
    shifts,
    days,
    anchor,
    setAnchor,
    view,
    setView,
    canEdit,
  } = props;
  const qc = useQueryClient();
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [savingPdf, setSavingPdf] = useState(false);

  const draftCount = shifts.filter((s) => !s.published).length;

  const publishMutation = useMutation({
    mutationFn: async () => {
      const ids = shifts.filter((s) => !s.published).map((s) => s.id);
      if (ids.length === 0) return;
      const { error } = await supabase.from("shifts").update({ published: true }).in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shifts"] }),
  });

  /**
   * The schedule on paper: the range currently on screen, day by day, with the
   * same colours. pdfmake is ~2 MB, so it is only fetched when someone asks.
   */
  async function downloadSchedule() {
    setSavingPdf(true);
    try {
      const { downloadSchedulePdf } = await import("@/lib/pdf");
      const nameOf = (id: string | null) =>
        id ? (members.find((m) => m.id === id)?.full_name ?? "Unknown") : "Open shift";
      const pdfDays = days.map((d) => ({
        date: fmtDayLabel(d),
        shifts: shifts
          .filter((s) => new Date(s.starts_at).toDateString() === d.toDateString())
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
          .map((s) => ({
            employee: nameOf(s.employee_id),
            time: `${fmtTime(new Date(s.starts_at))} – ${fmtTime(new Date(s.ends_at))}`,
            position: s.position || "—",
            colorHex: shiftColorHex(s.color),
            draft: !s.published,
          })),
      }));
      const hours = shifts.reduce(
        (sum, s) => sum + hoursBetween(new Date(s.starts_at), new Date(s.ends_at)),
        0,
      );
      await downloadSchedulePdf({
        companyName,
        rangeLabel,
        viewLabel: VIEW_LABEL[view],
        days: pdfDays,
        totalShifts: shifts.length,
        totalHours: hours.toFixed(1),
      });
    } finally {
      setSavingPdf(false);
    }
  }

  const nav = (dir: 1 | -1) => {
    if (view === "day") return setAnchor(addDays(anchor, dir));
    if (view === "week") return setAnchor(addDays(anchor, dir * 7));
    if (view === "twoweek") return setAnchor(addDays(anchor, dir * 14));
    const m = new Date(anchor);
    m.setMonth(m.getMonth() + dir);
    return setAnchor(m);
  };

  const rangeLabel = (() => {
    if (view === "day") return fmtDayLabel(days[0]);
    if (view === "month") return anchor.toLocaleDateString([], { month: "long", year: "numeric" });
    return `${fmtDayLabel(days[0])} – ${fmtDayLabel(days[days.length - 1])}`;
  })();

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-semibold text-foreground">Schedule builder</h2>
          <p className="text-sm text-muted-foreground">
            {canEdit ? "Click any cell to add or edit a shift. " : "Read-only view. "}
            Changes are scoped to {companyName}.
          </p>
        </div>
        {role === "company_admin" && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(companyId);
              setCopiedId(true);
              setTimeout(() => setCopiedId(false), 1500);
            }}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent"
            title="Share this with new employees"
          >
            <Copy className="h-3.5 w-3.5" />{" "}
            {copiedId ? "Copied!" : `ID: ${companyId.slice(0, 8)}…`}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-[var(--shadow-card)]">
        <div className="inline-flex rounded-lg bg-secondary p-1">
          {(["day", "week", "twoweek", "month"] as ScheduleView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <div className="hidden h-6 w-px bg-border sm:block" />
        <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>
          Today
        </Button>
        <Button variant="ghost" size="sm" onClick={() => nav(-1)}>
          ← Prev
        </Button>
        <Button variant="ghost" size="sm" onClick={() => nav(1)}>
          Next →
        </Button>
        <span className="ml-1 text-sm text-muted-foreground">{rangeLabel}</span>
        <div className="ml-auto flex items-center gap-2">
          {/* Templates are one way in; this builder is the other. */}
          {canEdit && (
            <Button asChild variant="outline" size="sm">
              <Link to="/schedule-templates">
                <CalendarRange className="mr-2 h-4 w-4" />
                From template
              </Link>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void downloadSchedule()}
            disabled={savingPdf || shifts.length === 0}
            title="Saves a PDF of this view — print it or pin it up"
          >
            {savingPdf ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download PDF
          </Button>
          {canEdit && (
            <Button
              onClick={() => publishMutation.mutate()}
              disabled={draftCount === 0 || publishMutation.isPending}
            >
              {publishMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Publish ({draftCount})
            </Button>
          )}
        </div>
      </div>

      {view === "day" && <DayView {...props} onEdit={setEdit} />}
      {view === "week" && <GridView {...props} onEdit={setEdit} dayCount={7} />}
      {view === "twoweek" && <GridView {...props} onEdit={setEdit} dayCount={14} />}
      {view === "month" && <MonthView {...props} onEdit={setEdit} />}

      <ShiftEditor
        target={edit}
        companyId={companyId}
        memberShifts={(edit && shifts.filter((s) => s.employee_id === edit.memberId)) || []}
        onClose={() => setEdit(null)}
      />
    </div>
  );
}

/* ----------------------------- Grid view (week / 2-week) ----------------------------- */

function GridView({
  members,
  shifts,
  days,
  canEdit,
  isLoading,
  onEdit,
  dayCount,
}: BuilderProps & { onEdit: (t: EditTarget) => void; dayCount: 7 | 14 }) {
  const grid = useMemo(() => {
    const m = new Map<string, (ShiftRow | null)[]>();
    for (const member of members) m.set(member.id, new Array(dayCount).fill(null));
    for (const s of shifts) {
      const start = new Date(s.starts_at);
      const idx = Math.floor((start.getTime() - days[0].getTime()) / 86400000);
      if (idx < 0 || idx >= dayCount) continue;
      // Open shifts have no employee_id, so they belong to no row in this grid.
      const row = s.employee_id ? m.get(s.employee_id) : undefined;
      if (!row) continue;
      row[idx] = s;
    }
    return m;
  }, [members, shifts, days, dayCount]);

  const memberCol = dayCount === 14 ? 160 : 180;
  const minW = dayCount === 14 ? 1200 : 780;
  const dayMin = dayCount === 14 ? 70 : 90;

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
      <div style={{ minWidth: `${minW}px` }}>
        <div
          className="grid border-b border-border bg-secondary/40"
          style={{
            gridTemplateColumns: `${memberCol}px repeat(${dayCount}, minmax(${dayMin}px, 1fr))`,
          }}
        >
          <div className="px-3 py-3 text-sm font-semibold text-foreground">
            Team ({members.length})
          </div>
          {days.map((d, i) => {
            const today = new Date().toDateString() === d.toDateString();
            const weekDivider = dayCount === 14 && i === 7;
            return (
              <div
                key={d.toISOString()}
                className={`px-1 py-3 text-center text-[11px] font-semibold ${today ? "text-primary" : "text-foreground"} ${weekDivider ? "border-l-2 border-primary/30" : ""}`}
              >
                <div className="uppercase tracking-wide text-muted-foreground">
                  {d.toLocaleDateString([], { weekday: "short" })}
                </div>
                <div
                  className={
                    today
                      ? "mt-0.5 inline-block rounded-full border border-primary px-1.5"
                      : "mt-0.5"
                  }
                >
                  {d.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading schedule…</p>
        ) : members.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No team members yet.
          </p>
        ) : (
          members.map((m) => {
            const row = grid.get(m.id) ?? new Array(dayCount).fill(null);
            return (
              <div
                key={m.id}
                className="grid border-t border-border"
                style={{
                  gridTemplateColumns: `${memberCol}px repeat(${dayCount}, minmax(${dayMin}px, 1fr))`,
                }}
              >
                <div className="flex items-center gap-2 px-3 py-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
                    {m.full_name
                      .split(" ")
                      .map((p) => p[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase() || "?"}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {m.full_name || "(unnamed)"}
                    </p>
                    {m.position && (
                      <p className="truncate text-xs text-muted-foreground">{m.position}</p>
                    )}
                  </div>
                </div>
                {row.map((s, i) => {
                  const weekDivider = dayCount === 14 && i === 7;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={!canEdit}
                      onClick={() =>
                        canEdit &&
                        onEdit({
                          memberId: m.id,
                          memberName: m.full_name || "(unnamed)",
                          day: days[i],
                          shift: s,
                        })
                      }
                      className={`group relative border-l border-border p-1 text-left transition-colors enabled:hover:bg-primary-soft/40 disabled:cursor-default ${weekDivider ? "border-l-2 border-primary/30" : ""}`}
                    >
                      {s ? (
                        <div
                          className={`rounded-md px-1.5 py-1 text-[10px] leading-tight ${shiftColorClass(s.color)}`}
                        >
                          <p className="font-semibold">
                            {fmtTime(new Date(s.starts_at))}–{fmtTime(new Date(s.ends_at))}
                          </p>
                          {s.position && <p className="truncate opacity-90">{s.position}</p>}
                          {!s.published && <p className="opacity-90">draft</p>}
                        </div>
                      ) : canEdit ? (
                        <div className="grid h-full min-h-10 place-items-center rounded-md border border-dashed border-transparent text-muted-foreground opacity-0 transition-opacity group-hover:border-primary/40 group-hover:opacity-100">
                          <Plus className="h-4 w-4" />
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Day view ----------------------------- */

function DayView({
  members,
  shifts,
  days,
  canEdit,
  isLoading,
  onEdit,
}: BuilderProps & { onEdit: (t: EditTarget) => void }) {
  const day = days[0];
  if (isLoading)
    return (
      <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground shadow-[var(--shadow-card)]">
        Loading…
      </p>
    );
  if (members.length === 0)
    return (
      <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground shadow-[var(--shadow-card)]">
        No team members yet.
      </p>
    );
  return (
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-base font-semibold text-foreground">{fmtDayLabel(day)}</h3>
        <p className="text-xs text-muted-foreground">
          {shifts.length} shift{shifts.length === 1 ? "" : "s"} scheduled
        </p>
      </div>
      <ul className="divide-y divide-border">
        {members.map((m) => {
          const mine = shifts.filter((s) => s.employee_id === m.id);
          return (
            <li
              key={m.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
                  {m.full_name
                    .split(" ")
                    .map((p) => p[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase() || "?"}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {m.full_name || "(unnamed)"}
                  </p>
                  {m.position && (
                    <p className="truncate text-xs text-muted-foreground">{m.position}</p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {mine.length === 0 ? (
                  canEdit ? (
                    <button
                      type="button"
                      onClick={() =>
                        onEdit({
                          memberId: m.id,
                          memberName: m.full_name || "(unnamed)",
                          day,
                          shift: null,
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add shift
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Off</span>
                  )
                ) : (
                  mine.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={!canEdit}
                      onClick={() =>
                        canEdit &&
                        onEdit({
                          memberId: m.id,
                          memberName: m.full_name || "(unnamed)",
                          day,
                          shift: s,
                        })
                      }
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${shiftColorClass(s.color)} ${!s.published ? "ring-1 ring-warning" : ""}`}
                    >
                      {fmtTime(new Date(s.starts_at))} – {fmtTime(new Date(s.ends_at))}
                      {s.position ? ` · ${s.position}` : ""}
                      {!s.published ? " · draft" : ""}
                    </button>
                  ))
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ----------------------------- Month view ----------------------------- */

function MonthView({
  shifts,
  anchor,
  canEdit,
  isLoading,
  onEdit,
  members,
}: BuilderProps & { onEdit: (t: EditTarget) => void }) {
  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const leading = (monthStart.getDay() + 6) % 7;
  const trailing = (7 - ((monthEnd.getDay() + 6) % 7)) % 7;
  const calStart = addDays(monthStart, -leading);
  const monthLen = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86400000);
  const totalDays = leading + monthLen + trailing;
  const cells: Date[] = [];
  for (let i = 0; i < totalDays; i++) cells.push(addDays(calStart, i));

  const counts = new Map<string, number>();
  for (const s of shifts) {
    const k = new Date(s.starts_at).toDateString();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  if (isLoading)
    return (
      <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground shadow-[var(--shadow-card)]">
        Loading…
      </p>
    );

  const today = new Date().toDateString();

  return (
    <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="grid grid-cols-7 border-b border-border bg-secondary/40 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-1 py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const isCurMonth = d.getMonth() === monthStart.getMonth();
          const k = d.toDateString();
          const count = counts.get(k) ?? 0;
          const isToday = today === k;
          return (
            <button
              key={i}
              type="button"
              disabled={!canEdit || members.length === 0}
              onClick={() => {
                if (!canEdit || members.length === 0) return;
                const m = members[0];
                onEdit({
                  memberId: m.id,
                  memberName: m.full_name || "(unnamed)",
                  day: d,
                  shift: null,
                });
              }}
              className={`relative min-h-[80px] border-b border-l border-border p-1.5 text-left text-xs transition-colors enabled:hover:bg-primary-soft/30 disabled:cursor-default ${!isCurMonth ? "bg-secondary/20 text-muted-foreground" : "text-foreground"} ${i % 7 === 0 ? "border-l-0" : ""}`}
            >
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${isToday ? "bg-primary text-primary-foreground" : ""}`}
              >
                {d.getDate()}
              </span>
              {count > 0 && (
                <span className="mt-1 block truncate rounded-md bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {count} shift{count === 1 ? "" : "s"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- Shift editor + conflict detection ----------------------------- */

function ShiftEditor({
  target,
  companyId,
  memberShifts,
  onClose,
}: {
  target: EditTarget | null;
  companyId: string;
  memberShifts: ShiftRow[];
  onClose: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {target && (
          <ShiftEditorForm
            key={`${target.memberId}-${target.day.toISOString()}`}
            target={target}
            companyId={companyId}
            memberShifts={memberShifts}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShiftEditorForm({
  target,
  companyId,
  memberShifts,
  onClose,
}: {
  target: EditTarget;
  companyId: string;
  memberShifts: ShiftRow[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const initialStart = target.shift
    ? new Date(target.shift.starts_at)
    : (() => {
        const d = new Date(target.day);
        d.setHours(9, 0, 0, 0);
        return d;
      })();
  const initialEnd = target.shift
    ? new Date(target.shift.ends_at)
    : (() => {
        const d = new Date(target.day);
        d.setHours(17, 0, 0, 0);
        return d;
      })();

  const [startStr, setStartStr] = useState(toLocalInput(initialStart));
  const [endStr, setEndStr] = useState(toLocalInput(initialEnd));
  // Most shifts are thought of as "9am for 4 hours", not "9am to 1pm". The
  // three fields stay in step: set a length and the end follows, set an end and
  // the length follows. Kept as a string so a half-typed "7." isn't clobbered.
  const [hoursStr, setHoursStr] = useState(() =>
    fmtHoursValue(hoursBetween(initialStart, initialEnd)),
  );

  /** Move the end to match a start and a length, when both make sense. */
  function applyLength(nextStart: string, nextHours: string) {
    const from = new Date(nextStart);
    const length = Number(nextHours);
    if (Number.isNaN(from.getTime()) || !Number.isFinite(length) || length <= 0) return;
    setEndStr(toLocalInput(new Date(from.getTime() + length * 3_600_000)));
  }

  function onStartChange(value: string) {
    setStartStr(value);
    applyLength(value, hoursStr);
  }

  function onHoursChange(value: string) {
    setHoursStr(value);
    applyLength(startStr, value);
  }

  function onEndChange(value: string) {
    setEndStr(value);
    const from = new Date(startStr);
    const to = new Date(value);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from) {
      setHoursStr(fmtHoursValue(hoursBetween(from, to)));
    }
  }
  const [position, setPosition] = useState(target.shift?.position ?? "");
  const [positionId, setPositionId] = useState<string>(target.shift?.position_id ?? "");
  const [color, setColor] = useState<string>(target.shift?.color ?? SHIFT_COLORS[0].key);
  const [serverError, setServerError] = useState<string | null>(null);

  const positionsQ = useQuery({
    queryKey: ["positions", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("id, name")
        .eq("company_id", companyId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  // Only the time range is validated locally, for instant feedback. Everything
  // else — double-booking, approved time off, stated availability, position
  // qualification, weekly-hour cap and overtime — comes from
  // check_shift_conflicts, so the warnings shown here are the same rules the
  // database applies rather than a second copy that can drift.
  const start = new Date(startStr);
  const end = new Date(endStr);
  const rangeValid = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start;

  const conflictsQ = useQuery({
    queryKey: [
      "shift-conflicts",
      target.memberId,
      startStr,
      endStr,
      positionId,
      target.shift?.id ?? null,
    ],
    enabled: rangeValid,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("check_shift_conflicts", {
        _employee_id: target.memberId,
        _starts_at: start.toISOString(),
        _ends_at: end.toISOString(),
        ...(positionId ? { _position_id: positionId } : {}),
        ...(target.shift?.id ? { _shift_id: target.shift.id } : {}),
      });
      if (error) throw error;
      return (data ?? []) as { code: string; severity: string; message: string }[];
    },
  });

  const conflicts = rangeValid
    ? (conflictsQ.data ?? [])
    : [{ code: "range", severity: "error", message: "End time must be after start time." }];

  // An admin may override any finding; only an unusable time range blocks saving.
  const blocking = !rangeValid;
  const errorCount = conflicts.filter((c) => c.severity === "error").length;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        company_id: companyId,
        employee_id: target.memberId,
        starts_at: new Date(startStr).toISOString(),
        ends_at: new Date(endStr).toISOString(),
        position,
        position_id: positionId || null,
        color,
      };
      if (target.shift) {
        const { error } = await supabase.from("shifts").update(payload).eq("id", target.shift.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("shifts").insert({ ...payload, published: false });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shifts"] });
      onClose();
    },
    onError: (e: unknown) => setServerError(e instanceof Error ? e.message : String(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!target.shift) return;
      const { error } = await supabase.from("shifts").delete().eq("id", target.shift.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shifts"] });
      onClose();
    },
    onError: (e: unknown) => setServerError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{target.shift ? "Edit shift" : "Add shift"}</DialogTitle>
        <DialogDescription>
          {target.memberName} · {fmtDayLabel(target.day)}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="start">Starts</Label>
            <Input
              id="start"
              type="datetime-local"
              value={startStr}
              onChange={(e) => onStartChange(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hours">Length (hours)</Label>
            <Input
              id="hours"
              type="number"
              min={0.25}
              max={24}
              step={0.25}
              value={hoursStr}
              onChange={(e) => onHoursChange(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end">Ends</Label>
          <Input
            id="end"
            type="datetime-local"
            value={endStr}
            onChange={(e) => onEndChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Filled in from the start and length — change it directly and the length updates instead.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pos">Position</Label>
          {(positionsQ.data ?? []).length > 0 ? (
            <select
              id="pos"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={positionId}
              onChange={(e) => {
                const id = e.target.value;
                setPositionId(id);
                // Keep the legacy free-text column in step so existing grid,
                // report and trade views keep rendering a readable label.
                setPosition((positionsQ.data ?? []).find((p) => p.id === id)?.name ?? "");
              }}
            >
              <option value="">— none —</option>
              {(positionsQ.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="pos"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Traffic / Parking"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Color</Label>
          <div className="grid grid-cols-4 gap-2">
            {SHIFT_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setColor(c.key)}
                aria-pressed={color === c.key}
                title={c.label}
                className={`rounded-md px-2 py-2 text-xs font-medium ${c.chip} ${color === c.key ? "ring-2 ring-ring ring-offset-2" : "opacity-60 hover:opacity-100"}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {conflictsQ.isFetching && rangeValid && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking availability, time off and hours…
          </p>
        )}

        {conflicts.length > 0 && (
          <div
            className={`rounded-lg border p-3 ${errorCount > 0 ? "border-destructive/40 bg-destructive/10" : "border-warning/40 bg-warning/15"}`}
            role="alert"
          >
            <div
              className={`flex items-center gap-2 text-sm font-medium ${errorCount > 0 ? "text-destructive" : "text-warning-foreground"}`}
            >
              <AlertTriangle className="h-4 w-4" />
              {conflicts.length === 1 ? "1 issue found" : `${conflicts.length} issues found`}
              {errorCount > 0 && conflicts.length > errorCount && ` (${errorCount} blocking)`}
            </div>
            <ul className="mt-1.5 space-y-1 text-xs">
              {conflicts.map((c) => (
                <li key={c.code} className="flex gap-2">
                  <span
                    className={`mt-px shrink-0 rounded px-1 text-[10px] font-semibold uppercase ${c.severity === "error" ? "bg-destructive/20 text-destructive" : "bg-warning/30 text-warning-foreground"}`}
                  >
                    {c.severity}
                  </span>
                  <span
                    className={
                      errorCount > 0 ? "text-destructive/90" : "text-warning-foreground/90"
                    }
                  >
                    {c.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {serverError && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {serverError}
          </p>
        )}
      </div>
      <DialogFooter className="flex-row justify-between sm:justify-between">
        <div>
          {target.shift && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={blocking || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {conflicts.length > 0 && !blocking ? "Save anyway" : "Save"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

// Suppress unused-import warning for useEffect (kept for future enhancements).
void useEffect;
