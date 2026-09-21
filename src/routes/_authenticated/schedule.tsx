import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";
import { useCapabilities } from "@/lib/capabilities";
import { useStaffVisibility } from "@/lib/staff-visibility";
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
  CheckSquare,
} from "lucide-react";
import { SHIFT_COLORS, shiftColorClass, shiftColorHex } from "@/lib/shift-colors";
import { ScheduleCopyPaste } from "@/components/schedule-copy-paste";
import { CopyLastWeekButton } from "@/components/copy-last-week";
import { LayoutSwitch, ScheduleGrid } from "@/components/schedule-grid";
import { sheetLegend, sheetTime, shortName } from "@/lib/sheet-format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScheduleLayout, type ScheduleLayout } from "@/lib/schedule-layout";
import { EraseSelectionBar } from "@/components/erase-days";
import { useScheduleSelection, type ScheduleSelection } from "@/lib/day-selection";
import { toDayString } from "@/lib/schedule-pattern";

export const Route = createFileRoute("/_authenticated/schedule")({
  component: SchedulePage,
});

/* ----------------------------- Helpers ----------------------------- */

/** Mon-first, matching startOfWeek below and the grid header. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Same wall-clock time, `days` calendar days away. setDate keeps the hour
 * across a daylight-saving boundary; adding 24h of milliseconds would not.
 */
function addCalendarDays(t: Date, days: number): Date {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  return d;
}

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
  /** The team they belong to — `departments` on the Organization page. */
  department_id: string | null;
}

interface TeamRow {
  id: string;
  name: string;
}

/** Rows grouped under a heading; null means show one flat list. */
type TeamGroup = { id: string; name: string; members: MemberRow[] };

const NO_TEAM = "__none__";

/** How far ahead an employee's "everything published" list reaches. */
const POSTED_WEEKS_AHEAD = 12;

/**
 * Employees divided under their team, teams in the order the company set,
 * everyone without one last. A team nobody is on is left out rather than
 * shown as an empty heading.
 */
function groupByTeam(members: MemberRow[], teams: TeamRow[]): TeamGroup[] {
  const known = new Set(teams.map((t) => t.id));
  const byTeam = new Map<string, MemberRow[]>();
  for (const m of members) {
    // A department that is gone, or on another company, counts as no team
    // rather than dropping that person off the schedule entirely.
    const key = m.department_id && known.has(m.department_id) ? m.department_id : NO_TEAM;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key)!.push(m);
  }
  const out: TeamGroup[] = teams
    .filter((t) => byTeam.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, members: byTeam.get(t.id)! }));
  const rest = byTeam.get(NO_TEAM);
  if (rest?.length) out.push({ id: NO_TEAM, name: "No team", members: rest });
  return out;
}

const GROUP_BY_TEAM_KEY = "ps-schedule-group-by-team";

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
  // "Keep the office off the floor's screens" — the company's own rule about
  // which colleagues an employee is shown. It applies to the posted roster
  // exactly as it does to the dashboard list.
  const staff = useStaffVisibility();
  // Classic screens or the weekly grid — each person's own choice.
  const { layout, setLayout, saving: layoutSaving } = useScheduleLayout();
  const companyId = profile?.company_id;
  const canEdit = role === "company_admin";
  /** Who gets the grid of everyone. An employee gets their own week instead. */
  const isBuilder = role !== "employee";

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

  // The day/week/month picker belongs to the builder. An employee always gets
  // one week at a time, whatever an earlier session left in local storage.
  // The weekly grid is one week by definition, whoever is looking at it.
  const effectiveView: ScheduleView = isBuilder && layout !== "grid" ? view : "week";

  const { rangeStart, rangeEnd, days } = useMemo(() => {
    if (effectiveView === "day") {
      const d = new Date(anchor);
      d.setHours(0, 0, 0, 0);
      return { rangeStart: d, rangeEnd: addDays(d, 1), days: [d] };
    }
    if (effectiveView === "twoweek") {
      const s = startOfWeek(anchor);
      const ds = Array.from({ length: 14 }, (_, i) => addDays(s, i));
      return { rangeStart: s, rangeEnd: addDays(s, 14), days: ds };
    }
    if (effectiveView === "month") {
      const s = startOfMonth(anchor);
      const e = endOfMonth(anchor);
      const ds: Date[] = [];
      for (let d = new Date(s); d < e; d = addDays(d, 1)) ds.push(new Date(d));
      return { rangeStart: s, rangeEnd: e, days: ds };
    }
    const s = startOfWeek(anchor);
    const ds = Array.from({ length: 7 }, (_, i) => addDays(s, i));
    return { rangeStart: s, rangeEnd: addDays(s, 7), days: ds };
  }, [effectiveView, anchor]);

  // The roster and the teams it is divided into belong to the builder, which is
  // an admin screen. An employee gets `EmployeeView` — fetching the company's
  // people for them only pulled every admin's name into a browser that has
  // nowhere to show it.
  const membersQ = useQuery({
    queryKey: ["members", companyId],
    enabled: !!companyId && isBuilder,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, position, department_id")
        .eq("company_id", companyId!)
        .order("full_name");
      if (error) throw error;
      return data as MemberRow[];
    },
  });

  // Teams are the company's departments. Nothing here creates or edits them;
  // they are maintained on Organization → Departments.
  const teamsQ = useQuery({
    queryKey: ["schedule-teams", companyId],
    enabled: !!companyId && isBuilder,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, name")
        .eq("company_id", companyId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as TeamRow[];
    },
  });

  const shiftsQ = useQuery({
    queryKey: [
      "shifts",
      companyId,
      isBuilder ? "all" : user?.id,
      rangeStart.toISOString(),
      rangeEnd.toISOString(),
    ],
    enabled: !!companyId,
    queryFn: async () => {
      let q = supabase
        .from("shifts")
        .select("*")
        .eq("company_id", companyId!)
        .gte("starts_at", rangeStart.toISOString())
        .lt("starts_at", rangeEnd.toISOString());
      // "My week" only ever shows the signed-in person's own shifts. Asking for
      // the whole company and then filtering in the browser meant an admin's
      // roster travelled down the wire to every employee who opened the page.
      if (!isBuilder) q = q.eq("employee_id", user!.id);
      const { data, error } = await q.order("starts_at");
      if (error) throw error;
      return data as ShiftRow[];
    },
  });

  /**
   * The posted roster: every published shift the company has put up, from the
   * start of this week onwards.
   *
   * Deliberately not tied to the week the arrows are on. A schedule is
   * published ahead of time, so the week an employee opens the page to is
   * usually the one week that has nothing new in it — and a page that shows
   * only that week reads as "nothing was published", whatever the notification
   * said. Everything published is on the page; the weeks are sections in it.
   *
   * Drafts never leave the builder, so the database is asked for published rows
   * rather than a week being filtered down in the browser.
   */
  const postedFrom = useMemo(() => startOfWeek(new Date()), []);
  const postedTo = useMemo(() => addDays(postedFrom, POSTED_WEEKS_AHEAD * 7), [postedFrom]);

  const postedQ = useQuery({
    queryKey: ["published-shifts", companyId, postedFrom.toISOString()],
    enabled: !!companyId && !isBuilder,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("*")
        .eq("company_id", companyId!)
        .eq("published", true)
        .gte("starts_at", postedFrom.toISOString())
        .lt("starts_at", postedTo.toISOString())
        .order("starts_at");
      if (error) throw error;
      return data as ShiftRow[];
    },
  });

  // Names for that roster. The builder has `membersQ` for this; an employee
  // needs nothing but the names, so it asks for nothing but the names.
  const rosterNamesQ = useQuery({
    queryKey: ["roster-names", companyId],
    enabled: !!companyId && !isBuilder,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", companyId!)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });

  if (!companyId || !company) return <NoRoleState />;

  // The grid's rows, with the company's "keep the office off the rosters" rule
  // applied. An admin is either somebody you put on a schedule or they are not,
  // and that cannot depend on who is looking at it. Their own row stays —
  // nobody is hidden from themselves.
  const members = staff.visible(membersQ.data ?? [], (m) => m.id);
  const teams = teamsQ.data ?? [];
  const shifts = shiftsQ.data ?? [];

  if (role === "employee") {
    // `shifts` is already only this person's — the query asked for nothing else.
    // The week shown is the one the arrows are on, not a fresh "today": a week
    // built and published ahead of time is only reachable if the employee can
    // walk forward into it.
    const names = new Map((rosterNamesQ.data ?? []).map((p) => [p.id, p.full_name]));
    // An open shift has no employee_id, so it is nobody's to hide. Until the
    // admin list lands nothing is hidden yet, so hold the roster back rather
    // than flash a name the rule is about to take away.
    const posted = staff.isLoading
      ? []
      : staff.visible(postedQ.data ?? [], (s) => s.employee_id ?? "");
    return (
      <EmployeeView
        days={days}
        shifts={shifts}
        posted={posted}
        nameOf={(id) => (id ? (names.get(id) ?? "Unknown") : "Open shift")}
        selfId={user!.id}
        isLoading={shiftsQ.isLoading || postedQ.isLoading || staff.isLoading}
        isThisWeek={startOfWeek(anchor).getTime() === startOfWeek(new Date()).getTime()}
        onWeek={(dir) => setAnchor((a) => (dir === 0 ? new Date() : addDays(a, dir * 7)))}
        layout={layout}
        onLayout={(l) => void setLayout(l)}
        layoutSaving={layoutSaving}
        companyName={company.name}
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
        teams={teams}
        shifts={shifts}
        days={days}
        anchor={anchor}
        setAnchor={setAnchor}
        view={effectiveView}
        setView={setView}
        canEdit={canEdit}
        isLoading={membersQ.isLoading || shiftsQ.isLoading}
        layout={layout}
        onLayout={(l) => void setLayout(l)}
        layoutSaving={layoutSaving}
      />

      {/* Generating a schedule and then fixing it up is one job, so it lives
          under the builder rather than on a page of its own. */}
      {canEdit && capabilities.auto_scheduling && <ScheduleRunsPanel companyId={companyId} />}
    </div>
  );
}

/* ----------------------------- Employee view ----------------------------- */

/**
 * One week for the signed-in person: their own shifts, then the published
 * roster for that week — and the arrows that reach the other weeks. Without
 * those arrows a schedule built and published in advance stayed invisible
 * until the week it covered finally arrived.
 */
function EmployeeView({
  days,
  shifts,
  posted,
  nameOf,
  selfId,
  isLoading,
  isThisWeek,
  onWeek,
  layout,
  onLayout,
  layoutSaving,
  companyName,
}: {
  layout: ScheduleLayout;
  onLayout: (l: ScheduleLayout) => void;
  layoutSaving: boolean;
  companyName: string;
  days: Date[];
  shifts: ShiftRow[];
  /**
   * Every published shift the company has put up from this week on, everyone's,
   * already filtered for privacy. Not just the week the arrows are on.
   */
  posted: ShiftRow[];
  nameOf: (id: string | null) => string;
  selfId: string;
  isLoading: boolean;
  isThisWeek: boolean;
  /** -1 a week back, 1 a week on, 0 back to the week containing today. */
  onWeek: (dir: -1 | 0 | 1) => void;
}) {
  const totalMin = shifts.reduce(
    (s, sh) => s + (new Date(sh.ends_at).getTime() - new Date(sh.starts_at).getTime()) / 60000,
    0,
  );
  /**
   * The posted schedule, as weeks of days. Reads like the sheet on the wall,
   * except the wall holds every week that has been put up rather than the one
   * the arrows happen to be on.
   */
  const postedWeeks = useMemo(() => {
    const byWeek = new Map<number, Map<string, ShiftRow[]>>();
    for (const s of posted) {
      const start = new Date(s.starts_at);
      const weekKey = startOfWeek(start).getTime();
      const dayKey = start.toDateString();
      let week = byWeek.get(weekKey);
      if (!week) byWeek.set(weekKey, (week = new Map()));
      const day = week.get(dayKey);
      if (day) day.push(s);
      else week.set(dayKey, [s]);
    }
    return [...byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([weekStart, week]) => ({
        weekStart: new Date(weekStart),
        days: [...week.entries()]
          .map(([key, rows]) => ({ day: new Date(key), rows }))
          .sort((a, b) => a.day.getTime() - b.day.getTime()),
      }));
  }, [posted]);

  const thisWeekStart = startOfWeek(new Date()).getTime();
  // Every week is open. Somebody checking when they work next should not have
  // to guess which heading is hiding it.
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<number>>(new Set());

  // The weekly grid: every published week as the posted sheet, with their own
  // row pinned to the top of each. Their shifts are on it, so the personal list
  // the classic layout carries would only be saying the same thing twice.
  if (layout === "grid") {
    const longDay = (d: Date) =>
      d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-foreground">Schedule</h2>
            <p className="text-sm text-muted-foreground">
              Everything published, week by week. You're at the top of each one.
            </p>
          </div>
          <LayoutSwitch layout={layout} onChange={onLayout} disabled={layoutSaving} />
        </div>

        {postedWeeks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            {isLoading
              ? "Loading the schedule…"
              : "Nothing has been published yet. It appears here as soon as it is."}
          </p>
        ) : (
          postedWeeks.map(({ weekStart, days: weekDays }) => {
            const seven = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
            return (
              <ScheduleGrid
                key={weekStart.getTime()}
                days={seven}
                shifts={weekDays.flatMap((d) => d.rows)}
                nameOf={(id) => nameOf(id)}
                companyName={companyName}
                rangeLabel={`${longDay(seven[0])} – ${longDay(seven[6])}`}
                eyebrow={weekStart.getTime() === thisWeekStart ? "This week" : "Coming up"}
                selfId={selfId}
              />
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">My schedule</h2>
          <p className="text-sm text-muted-foreground">
            {isThisWeek ? "This week" : "Week of"} {fmtDayLabel(days[0])} – {fmtDayLabel(days[6])}
          </p>
        </div>
        <LayoutSwitch layout={layout} onChange={onLayout} disabled={layoutSaving} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-[var(--shadow-card)]">
        <Button variant="ghost" size="sm" onClick={() => onWeek(-1)}>
          ← Prev week
        </Button>
        <Button variant="outline" size="sm" onClick={() => onWeek(0)} disabled={isThisWeek}>
          This week
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onWeek(1)}>
          Next week →
        </Button>
        {isLoading && <Loader2 className="ml-1 h-4 w-4 animate-spin text-muted-foreground" />}
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
      <SectionCard title="My shifts">
        {shifts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {isLoading
              ? "Loading your shifts…"
              : "No shifts on this week. Use Next week → to check the weeks ahead."}
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

      {/* Everything the company has put up, week by week — the sheet on the
          wall, with every week that is on it. Only published shifts reach
          here, so a week still being drafted upstairs shows nothing. */}
      <SectionCard
        title={`Published schedule${postedWeeks.length > 1 ? ` · ${postedWeeks.length} weeks` : ""}`}
      >
        {postedWeeks.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {isLoading
              ? "Loading the schedule…"
              : "Nothing has been published yet. It appears here as soon as it is."}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {postedWeeks.map(({ weekStart, days: weekDays }) => {
              const key = weekStart.getTime();
              const open = !collapsedWeeks.has(key);
              const current = key === thisWeekStart;
              const shiftCount = weekDays.reduce((n, d) => n + d.rows.length, 0);
              const mineCount = weekDays.reduce(
                (n, d) => n + d.rows.filter((s) => s.employee_id === selfId).length,
                0,
              );
              return (
                <div key={key}>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedWeeks((s) => {
                        const next = new Set(s);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    className="flex w-full flex-wrap items-center gap-2 py-3 text-left"
                  >
                    <span className="text-sm font-semibold text-foreground">
                      {current ? "This week" : "Week of"} {fmtDayLabel(weekStart)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {shiftCount} shift{shiftCount === 1 ? "" : "s"}
                    </span>
                    {/* What they came to find out, without opening the week. */}
                    {mineCount > 0 && (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                        {mineCount} yours
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {open ? "Hide" : "Show"}
                    </span>
                  </button>

                  {open && (
                    <div className="divide-y divide-border pb-2">
                      {weekDays.map(({ day, rows }) => (
                        <div key={day.toDateString()} className="py-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {fmtDayLabel(day)}
                          </p>
                          <ul className="mt-2 space-y-1.5">
                            {rows.map((s) => {
                              const start = new Date(s.starts_at);
                              const end = new Date(s.ends_at);
                              const mine = s.employee_id === selfId;
                              return (
                                <li
                                  key={s.id}
                                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 ${mine ? "bg-primary-soft" : "bg-secondary/50"}`}
                                >
                                  <span
                                    className={`text-sm ${mine ? "font-semibold text-primary" : "text-foreground"}`}
                                  >
                                    {nameOf(s.employee_id)}
                                    {mine && " (you)"}
                                  </span>
                                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                    {s.position && <span>{s.position}</span>}
                                    <span className="font-medium text-foreground">
                                      {fmtTime(start)} – {fmtTime(end)}
                                    </span>
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
  teams: TeamRow[];
  shifts: ShiftRow[];
  days: Date[];
  anchor: Date;
  setAnchor: (d: Date) => void;
  view: ScheduleView;
  setView: (v: ScheduleView) => void;
  canEdit: boolean;
  isLoading: boolean;
  layout: ScheduleLayout;
  onLayout: (l: ScheduleLayout) => void;
  layoutSaving: boolean;
}

function ScheduleBuilder(props: BuilderProps) {
  const {
    role,
    companyId,
    companyName,
    members,
    teams,
    shifts,
    days,
    anchor,
    setAnchor,
    view,
    setView,
    canEdit,
    layout,
    onLayout,
    layoutSaving,
  } = props;
  const qc = useQueryClient();
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [savingPdf, setSavingPdf] = useState(false);
  // Double-click a day heading or a shift to start picking things to clear.
  const sel = useScheduleSelection();

  // Divide the rows under their team. Remembered per browser, because a
  // company that runs teams wants them every time and one that does not
  // should never see the headings.
  const [groupByTeamOn, setGroupByTeamOn] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(GROUP_BY_TEAM_KEY) === "1") setGroupByTeamOn(true);
    } catch {
      /* private mode, or storage switched off */
    }
  }, []);
  function toggleGroupByTeam() {
    setGroupByTeamOn((on) => {
      const next = !on;
      try {
        localStorage.setItem(GROUP_BY_TEAM_KEY, next ? "1" : "0");
      } catch {
        /* not worth failing the click over */
      }
      return next;
    });
  }

  /** null renders one flat list, exactly as before. */
  const groups = useMemo(
    () => (groupByTeamOn ? groupByTeam(members, teams) : null),
    [groupByTeamOn, members, teams],
  );

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
  /**
   * The weekly grid on paper — the posted-sheet format, one week to a page.
   * Built from the same rows the builder shows, so a hidden admin is hidden on
   * paper too, and drafts are printed as drafts rather than passed off as the
   * schedule.
   */
  const gridPrintable = view === "week" || view === "twoweek";
  async function downloadGrid() {
    setSavingPdf(true);
    try {
      const { downloadScheduleGridPdf } = await import("@/lib/pdf");
      const nameById = new Map(members.map((m) => [m.id, m.full_name || "Unnamed"]));
      const visible = shifts.filter((s) => !s.employee_id || nameById.has(s.employee_id));
      const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
      const longDay = (d: Date) =>
        d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });

      const weeks = [];
      for (let i = 0; i + 7 <= days.length; i += 7) {
        const week = days.slice(i, i + 7);
        const inWeek = visible.filter((s) => week.some((d) => same(new Date(s.starts_at), d)));
        const byPerson = new Map<string, ShiftRow[]>();
        for (const s of inWeek) {
          const key = s.employee_id ?? "open";
          const list = byPerson.get(key);
          if (list) list.push(s);
          else byPerson.set(key, [s]);
        }
        const rows = [...byPerson.entries()]
          .map(([id, list]) => ({
            id,
            name: id === "open" ? "Open shift" : shortName(nameById.get(id) ?? "Unnamed"),
            list,
          }))
          .sort(
            (a, b) =>
              Number(a.id === "open") - Number(b.id === "open") || a.name.localeCompare(b.name),
          )
          .map(({ name, list }) => ({
            name,
            cells: week.map((d) =>
              list
                .filter((s) => same(new Date(s.starts_at), d))
                .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
                .map((s) => ({
                  time: sheetTime(new Date(s.starts_at)) + "–" + sheetTime(new Date(s.ends_at)),
                  position: s.position ?? "",
                  colorHex: shiftColorHex(s.color),
                  draft: !s.published,
                })),
            ),
          }));
        weeks.push({
          rangeLabel: longDay(week[0]) + " – " + longDay(week[6]),
          days: week.map((d) => ({
            name: d.toLocaleDateString([], { weekday: "long" }),
            date: d.toLocaleDateString([], { month: "2-digit", day: "2-digit", year: "numeric" }),
          })),
          rows,
        });
      }

      const legend = sheetLegend(visible).map((l) => ({
        label: l.label,
        colorHex: shiftColorHex(l.color),
      }));
      await downloadScheduleGridPdf({ companyName, weeks, legend });
    } finally {
      setSavingPdf(false);
    }
  }

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
        <LayoutSwitch layout={layout} onChange={onLayout} disabled={layoutSaving} />
        {/* Day, week or month is a question for the builder; the weekly grid
            is one week by definition. */}
        {layout !== "grid" && (
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
        )}
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
          {teams.length > 0 && (
            <Button
              variant={groupByTeamOn ? "default" : "outline"}
              size="sm"
              onClick={toggleGroupByTeam}
              aria-pressed={groupByTeamOn}
              title={
                groupByTeamOn ? "Show everyone in one list" : "Divide the rows under each team"
              }
            >
              <Users className="mr-2 h-4 w-4" />
              {groupByTeamOn ? "Teams on" : "Group by team"}
            </Button>
          )}
          {canEdit && !sel.active && layout !== "grid" && (
            <Button
              variant="outline"
              size="sm"
              onClick={sel.enable}
              title="Pick shifts or days to erase"
            >
              <CheckSquare className="mr-2 h-4 w-4" />
              Select
            </Button>
          )}
          {canEdit && (
            // The week the builder is on, whatever the view: on a day or a
            // month it is the week holding the date the arrows are pointing at.
            <CopyLastWeekButton companyId={companyId} weekStart={startOfWeek(anchor)} />
          )}
          {canEdit && (
            <ScheduleCopyPaste
              companyId={companyId}
              rangeStart={toDayString(days[0])}
              rangeLabel={rangeLabel}
              scope={view === "day" ? "day" : view === "month" ? "month" : "week"}
              shifts={shifts}
              members={members}
            />
          )}
          {/* Templates are one way in; this builder is the other. */}
          {canEdit && (
            <Button asChild variant="outline" size="sm">
              <Link to="/schedule-templates">
                <CalendarRange className="mr-2 h-4 w-4" />
                From template
              </Link>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={savingPdf || shifts.length === 0}
                title="Save a PDF to print or pin up"
              >
                {savingPdf ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Download PDF
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Print format
              </DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!gridPrintable}
                onSelect={() => void downloadGrid()}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-medium">Weekly grid</span>
                <span className="text-xs text-muted-foreground">
                  {gridPrintable
                    ? "The posted sheet: everyone by the week, one week a page."
                    : "Switch to Week or 2-Week to print the grid."}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void downloadSchedule()}
                className="flex-col items-start gap-0.5"
              >
                <span className="font-medium">Day list</span>
                <span className="text-xs text-muted-foreground">
                  Every shift in this view, day by day.
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

      {canEdit && layout !== "grid" && (
        <EraseSelectionBar
          selection={sel}
          shifts={shifts}
          scopeLabel={VIEW_LABEL[view].toLowerCase()}
        />
      )}

      {/* The weekly grid is a reading surface, not an editing one: the builder's
          cells are where shifts are added and changed. Drafts are on it and
          marked, because a manager needs to see the week they are about to
          publish, not only the one already out. */}
      {layout === "grid" && (
        <div className="space-y-2">
          <ScheduleGrid
            days={days}
            shifts={shifts.filter(
              (s) => !s.employee_id || members.some((m) => m.id === s.employee_id),
            )}
            nameOf={(id) => members.find((m) => m.id === id)?.full_name || "Unnamed"}
            companyName={companyName}
            rangeLabel={rangeLabel}
            eyebrow={
              days[0].toDateString() === startOfWeek(new Date()).toDateString()
                ? "This week"
                : "Week of"
            }
            showDrafts
            emptyText="Nobody is scheduled this week yet."
          />
          <p className="text-xs text-muted-foreground">
            Read-only. Switch to <span className="font-medium">Classic</span> to add or change
            shifts.
          </p>
        </div>
      )}

      {layout !== "grid" && view === "day" && (
        <DayView {...props} groups={groups} onEdit={setEdit} />
      )}
      {layout !== "grid" && view === "week" && (
        <GridView
          {...props}
          groups={groups}
          onEdit={setEdit}
          dayCount={7}
          selection={canEdit ? sel : undefined}
        />
      )}
      {layout !== "grid" && view === "twoweek" && (
        <GridView
          {...props}
          groups={groups}
          onEdit={setEdit}
          dayCount={14}
          selection={canEdit ? sel : undefined}
        />
      )}
      {layout !== "grid" && view === "month" && <MonthView {...props} onEdit={setEdit} />}

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
  groups,
  shifts,
  days,
  canEdit,
  isLoading,
  onEdit,
  dayCount,
  selection,
}: BuilderProps & {
  groups: TeamGroup[] | null;
  onEdit: (t: EditTarget) => void;
  dayCount: 7 | 14;
  selection?: ScheduleSelection;
}) {
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
            {groups
              ? `${groups.length} team${groups.length === 1 ? "" : "s"} · ${members.length}`
              : `Team (${members.length})`}
          </div>
          {days.map((d, i) => {
            const today = new Date().toDateString() === d.toDateString();
            const weekDivider = dayCount === 14 && i === 7;
            const dayKey = toDayString(d);
            const picked = selection?.days.has(dayKey) ?? false;
            return (
              <button
                type="button"
                key={d.toISOString()}
                disabled={!selection}
                onClick={() => selection?.toggleDay(dayKey)}
                title="Click to pick this whole day"
                className={`px-1 py-3 text-center text-[11px] font-semibold ${today ? "text-primary" : "text-foreground"} ${weekDivider ? "border-l-2 border-primary/30" : ""} ${picked ? "bg-primary/20 ring-1 ring-inset ring-primary" : ""}`}
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
              </button>
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
          (groups ?? [{ id: NO_TEAM, name: "", members }]).map((group) => (
            <div key={group.id}>
              {groups && (
                <div className="flex items-center justify-between gap-2 border-t border-border bg-secondary/60 px-3 py-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    {group.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{group.members.length}</span>
                </div>
              )}
              {group.members.map((m) => {
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
                      const pickedShift = !!s && (selection?.shifts.has(s.id) ?? false);
                      const pickedDay = selection?.days.has(toDayString(days[i])) ?? false;
                      const marked = pickedShift || (pickedDay && !!s);
                      return (
                        <button
                          key={i}
                          type="button"
                          disabled={!canEdit}
                          onDoubleClick={() => {
                            if (!canEdit) return;
                            // The two clicks behind this double-click picked the
                            // cell and put it back, so the selection is unchanged
                            // and the editor can open cleanly.
                            onEdit({
                              memberId: m.id,
                              memberName: m.full_name || "(unnamed)",
                              day: days[i],
                              shift: s,
                            });
                          }}
                          onClick={() => {
                            if (!canEdit) return;
                            // A filled cell is picked by clicking it; an empty one
                            // has nothing to pick, so it opens the editor to make
                            // a shift there.
                            if (s) {
                              selection?.toggleShift(s.id);
                              return;
                            }
                            onEdit({
                              memberId: m.id,
                              memberName: m.full_name || "(unnamed)",
                              day: days[i],
                              shift: s,
                            });
                          }}
                          title={
                            s
                              ? "Click to pick this shift · double-click to edit it"
                              : "Click to add a shift"
                          }
                          className={`group relative border-l border-border p-1 text-left transition-colors enabled:hover:bg-primary-soft/40 disabled:cursor-default ${weekDivider ? "border-l-2 border-primary/30" : ""} ${marked ? "bg-primary/15 ring-1 ring-inset ring-primary" : ""}`}
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
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Day view ----------------------------- */

function DayView({
  members,
  groups,
  shifts,
  days,
  canEdit,
  isLoading,
  onEdit,
}: BuilderProps & { groups: TeamGroup[] | null; onEdit: (t: EditTarget) => void }) {
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
        {(groups ?? [{ id: NO_TEAM, name: "", members }]).flatMap((group) => [
          ...(groups
            ? [
                <li
                  key={`head-${group.id}`}
                  className="flex items-center justify-between gap-2 bg-secondary/60 px-4 py-1.5"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    {group.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{group.members.length}</span>
                </li>,
              ]
            : []),
          ...group.members.map((m) => {
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
          }),
        ])}
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
  // "Apply to": one trip through the dialog can put the same shift on several
  // days of that week. Only when adding - repeating an edit across the week
  // would mean guessing which other shifts were meant to change.
  const clickedWeekday = (target.day.getDay() + 6) % 7;
  const [applyDays, setApplyDays] = useState<number[]>([clickedWeekday]);
  const repeating = !target.shift;
  // Offsets from the clicked day, ascending, so the clicked day stays first.
  const dayOffsets = repeating
    ? [...applyDays].sort((a, b) => a - b).map((w) => w - clickedWeekday)
    : [0];

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
      dayOffsets.join(","),
    ],
    enabled: rangeValid,
    queryFn: async () => {
      // Every day this save would write gets the same check the single-day
      // save has always had, so picking a second day cannot slip an unchecked
      // shift past availability, time off or the weekly hour cap.
      const found: { code: string; severity: string; message: string; day: string | null }[] = [];
      for (const off of dayOffsets) {
        const from = addCalendarDays(start, off);
        const to = addCalendarDays(end, off);
        const { data, error } = await supabase.rpc("check_shift_conflicts", {
          _employee_id: target.memberId,
          _starts_at: from.toISOString(),
          _ends_at: to.toISOString(),
          ...(positionId ? { _position_id: positionId } : {}),
          ...(target.shift?.id ? { _shift_id: target.shift.id } : {}),
        });
        if (error) throw error;
        for (const c of (data ?? []) as { code: string; severity: string; message: string }[]) {
          found.push({ ...c, day: dayOffsets.length > 1 ? fmtDayLabel(from) : null });
        }
      }
      return found;
    },
  });

  const conflicts = rangeValid
    ? (conflictsQ.data ?? [])
    : [
        {
          code: "range",
          severity: "error",
          message: "End time must be after start time.",
          day: null,
        },
      ];

  // An admin may override any finding; only an unusable time range blocks saving.
  const blocking = !rangeValid;
  const errorCount = conflicts.filter((c) => c.severity === "error").length;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const base = {
        company_id: companyId,
        employee_id: target.memberId,
        position,
        position_id: positionId || null,
        color,
      };
      if (target.shift) {
        const { error } = await supabase
          .from("shifts")
          .update({
            ...base,
            starts_at: start.toISOString(),
            ends_at: end.toISOString(),
          })
          .eq("id", target.shift.id);
        if (error) throw error;
        return;
      }
      // One row per chosen weekday, all inside the clicked day's week.
      const rows = dayOffsets.map((off) => ({
        ...base,
        starts_at: addCalendarDays(start, off).toISOString(),
        ends_at: addCalendarDays(end, off).toISOString(),
        published: false,
      }));
      const { error } = await supabase.from("shifts").insert(rows);
      if (error) throw error;
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

        {repeating && (
          <div className="space-y-1.5">
            <Label>Apply to</Label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((label, w) => {
                const on = applyDays.includes(w);
                const isClicked = w === clickedWeekday;
                // The day that was clicked is what this dialog is for, so it
                // cannot be switched off - cancel instead.
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    disabled={isClicked}
                    title={isClicked ? `${label} — the day you clicked` : label}
                    onClick={() =>
                      setApplyDays((d) => (d.includes(w) ? d.filter((x) => x !== w) : [...d, w]))
                    }
                    className={`h-11 w-11 rounded-full border text-xs font-medium transition-colors ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    } ${isClicked ? "cursor-default" : ""}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {dayOffsets.length === 1
                ? `Just ${fmtDayLabel(target.day)}.`
                : `Adds ${dayOffsets.length} shifts, in the week of ${fmtDayLabel(startOfWeek(target.day))}.`}
            </p>
          </div>
        )}

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
                <li key={`${c.day ?? ""}-${c.code}`} className="flex gap-2">
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
                    {c.day && <span className="font-medium">{c.day}: </span>}
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
