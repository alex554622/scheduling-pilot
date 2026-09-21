import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import { useStaffVisibility } from "@/lib/staff-visibility";
import { PAID_BREAK_MINUTES, readBreak, roundPunches } from "@/lib/timecard-totals";
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

/** A shift someone is due on today — what the roster means by "coming in". */
type ScheduledShift = {
  id: string;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  published: boolean;
};

type Status = "working" | "on_break" | "clocked_out" | "no_show";

/** What an employee is allowed to see about a colleague: a state, nothing more. */
type PresenceRow = { user_id: string; full_name: string; job_title: string | null; status: string };

function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtHours(ms: number) {
  if (ms <= 0) return "0h 00m";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
/** The seconds hand for a clock that is still running: "22s". */
function fmtSeconds(ms: number) {
  return `${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}s`;
}
/** mm:ss, or h:mm:ss past the hour — the same countdown the time clock shows. */
function fmtCountdown(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

function DashboardPage() {
  const { company, primaryRole, loading, user } = useAuth();
  const rules = useAppRules();
  const staff = useStaffVisibility();
  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());

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

  /** Is anyone still on the clock? Nothing needs counting if they all went home. */
  const hasLiveClock = useMemo(() => {
    const last = new Map<string, Punch>();
    // The punches arrive oldest first, so the last one written wins.
    for (const p of punchesQ.data ?? []) last.set(p.user_id, p);
    return [...last.values()].some((p) => p.kind !== "out");
  }, [punchesQ.data]);

  // Once a second, not once every thirty: the break countdowns and the worked
  // clocks below are meant to run, and a roster that moves in half-minute jumps
  // is not a clock. Everything downstream is derived from `now`, so it idles
  // back down when there is nobody on the clock to count.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), hasLiveClock ? 1_000 : 30_000);
    return () => clearInterval(id);
  }, [hasLiveClock]);

  // Who is due in today, and when. A manager sees the lot, drafts included —
  // the roster is where they check the plan against the floor. An employee is
  // shown the posted schedule only, plus their own shift whether or not it has
  // been published yet.
  const shiftsTodayQ = useQuery<ScheduledShift[]>({
    queryKey: ["today-shifts", company?.id, dayStart.toISOString(), isManager],
    // Waiting for `user` keeps the narrowing below from being skipped in the
    // moment before the session lands, which would pull draft shifts down to
    // someone who may not see them.
    enabled: !!company?.id && (isManager || !!user),
    queryFn: async () => {
      let q = supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at, published")
        .eq("company_id", company!.id)
        .gte("starts_at", dayStart.toISOString())
        .lte("starts_at", dayEnd.toISOString());
      if (!isManager) q = q.or(`published.eq.true,employee_id.eq.${user!.id}`);
      const { data, error } = await q.order("starts_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ScheduledShift[];
    },
  });

  /**
   * Per person, the first shift they are due on today and how many more follow.
   * A "no show" at nine in the morning says nothing until you know whether they
   * were due in at seven or are not due until seven tonight.
   */
  const dueToday = useMemo(() => {
    const m = new Map<
      string,
      { starts_at: string; ends_at: string; published: boolean; more: number }
    >();
    for (const s of shiftsTodayQ.data ?? []) {
      if (!s.employee_id) continue;
      const seen = m.get(s.employee_id);
      // The query is ordered by start, so the first one seen is the earliest.
      if (seen) seen.more += 1;
      else
        m.set(s.employee_id, {
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          published: s.published,
          more: 0,
        });
    }
    return m;
  }, [shiftsTodayQ.data]);

  // An employee cannot read a colleague's punches, so their view of the floor
  // comes from a definer function that answers with states only — no times, no
  // totals, nothing that adds up to someone else's hours.
  const presenceQ = useQuery<PresenceRow[]>({
    queryKey: ["company-presence", company?.id],
    enabled: !!company?.id && !isManager,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("company_presence");
      if (error) throw error;
      return (data ?? []) as PresenceRow[];
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
      /** Breaks today they came back from early — flagged, never docked. */
      shortBreaks: number;
      /** Time left on the break running right now; negative once it is over. */
      breakRemainingMs: number | null;
      /** How long the running break has lasted — all there is when no length was picked. */
      breakElapsedMs: number | null;
      /** Whether their worked clock is actually ticking, so the seconds mean something. */
      workedLive: boolean;
      alerts: BreakAlert[];
      /** The shift they are due on today, if any. */
      due: { starts_at: string; ends_at: string; published: boolean; more: number } | null;
    };
    const members = membersQ.data ?? [];
    const list: Row[] = members.map((m) => {
      const punches = byUser.get(m.id) ?? [];
      // Hours follow the rounding rule so this roster and the timecard agree.
      // The break reminders below keep the raw punches: how long someone has
      // really been on their feet is not a payroll question.
      const counted = roundPunches(punches, rules.punch_round_minutes);
      let openIn: Punch | null = null;
      let openBreak: Punch | null = null;
      let workedMs = 0;
      let unpaid = 0;
      let paid = 0;
      let currentUnpaid = 0;
      let currentPaid = 0;
      let shortBreaks = 0;
      let firstIn: string | null = null;
      let lastOut: string | null = null;
      for (const p of counted) {
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
            // The same reading the timecard will pay from, so the roster and
            // the card never disagree about a break that ran long.
            const read = readBreak(
              new Date(p.at).getTime() - new Date(openBreak.at).getTime(),
              openBreak.break_minutes,
              rules.cap_break_to_length,
            );
            if (read.paid) currentPaid += read.countedMs;
            else currentUnpaid += read.countedMs;
            if (read.incomplete) shortBreaks += 1;
            openBreak = null;
          }
        }
      }
      // The countdown runs off the raw punch, not the rounded one: rounding is
      // a payroll rule, and it would have the break end at a time the employee
      // never started it.
      const lastRaw = punches[punches.length - 1] ?? null;
      const rawBreakStart = lastRaw?.kind === "break_start" ? lastRaw : null;

      // Live counts for ongoing shift / break
      let status: Status = "no_show";
      let breakLabel: string | null = null;
      if (openIn && openBreak) {
        status = "on_break";
        // A break still running is capped the same way, so the worked clock
        // stops falling the moment they run past the length they picked.
        const live = readBreak(
          now - new Date(openBreak.at).getTime(),
          openBreak.break_minutes,
          rules.cap_break_to_length,
        );
        const liveBreak = live.countedMs;
        if (live.paid) currentPaid += liveBreak;
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
      const breakStartedAt = rawBreakStart ? new Date(rawBreakStart.at).getTime() : null;
      const allowanceMs = rawBreakStart?.break_minutes
        ? rawBreakStart.break_minutes * 60_000
        : null;
      const onBreakNow = status === "on_break" && breakStartedAt != null;

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
        shortBreaks,
        breakRemainingMs:
          onBreakNow && allowanceMs != null ? breakStartedAt! + allowanceMs - now : null,
        breakElapsedMs: onBreakNow ? now - breakStartedAt! : null,
        // A 10 is paid, so the worked clock keeps running through it; a 30 or a
        // 60 is not, so it stops and the seconds would sit there lying.
        workedLive:
          status === "working" ||
          (status === "on_break" && rawBreakStart?.break_minutes === PAID_BREAK_MINUTES),
        alerts: breakAlertsFor(punches, rules, dismissalsQ.data?.filter((d) => d.user_id === m.id) ?? [], now),
        due: dueToday.get(m.id) ?? null,
      };
    });
    const order: Record<Status, number> = { working: 0, on_break: 1, clocked_out: 2, no_show: 3 };
    list.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    return list;
  }, [membersQ.data, punchesQ.data, dismissalsQ.data, dueToday, rules, now]);


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

  // Employees get presence and nothing else: who is here, who is on a break.
  // Hours, punch times and break totals stay on the manager's side of this
  // page, the same line the database draws for the punch rows themselves.
  if (!isManager) {
    // `company_presence()` leaves the admins out too, so this is belt and
    // braces — but it is also what keeps the list right in a company whose
    // database hasn't taken the newer function yet.
    const presence = staff.visible(presenceQ.data ?? [], (p) => p.user_id);
    // Until the admin list has landed, saying "loading" beats showing a roster
    // that is about to lose rows.
    const presenceLoading = presenceQ.isLoading || staff.isLoading;
    // The one thing the person opening this page came to check.
    const mine = user ? (dueToday.get(user.id) ?? null) : null;
    // Their own row out of the roster maths above. A colleague's punches never
    // reach this browser, so this is the only row with a clock on it.
    const me = user ? (rows.find((r) => r.id === user.id) ?? null) : null;
    const present = {
      working: presence.filter((p) => p.status === "working").length,
      onBreak: presence.filter((p) => p.status === "on_break").length,
      off: presence.filter((p) => p.status === "off").length,
    };
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Who's on duty</h1>
            <p className="text-sm text-muted-foreground">
              <CalendarDays className="mr-1 inline h-4 w-4 align-text-bottom" />
              {today.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
            {/* Scheduled, not clocked: what time they are due in today. */}
            {mine && (
              <p className="mt-1 text-sm font-medium text-primary">
                You're due in at {fmtTime(mine.starts_at)} — until {fmtTime(mine.ends_at)}
                {!mine.published && <span className="text-muted-foreground"> (not published yet)</span>}
                {mine.more > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {mine.more} more {mine.more === 1 ? "shift" : "shifts"} today
                  </span>
                )}
              </p>
            )}
            {/* Their own clock, running by the second: worked so far, and what
                is left of the break they are on. */}
            {me && me.breakElapsedMs != null && (
              <p
                className={`mt-2 text-sm font-medium ${
                  me.breakRemainingMs != null && me.breakRemainingMs <= 0
                    ? "text-destructive"
                    : "text-amber-700"
                }`}
              >
                {me.breakRemainingMs == null
                  ? "On break for"
                  : me.breakRemainingMs > 0
                    ? "Break ends in"
                    : "Break over by"}{" "}
                <span className="font-mono text-base font-semibold tabular-nums">
                  {fmtCountdown(
                    me.breakRemainingMs == null
                      ? me.breakElapsedMs
                      : Math.abs(me.breakRemainingMs),
                  )}
                </span>
              </p>
            )}
            {me && (me.status === "working" || me.status === "on_break") && (
              <p className="mt-1 text-sm text-muted-foreground">
                On the clock{" "}
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {fmtHours(me.workedMs)}
                  {me.workedLive && ` ${fmtSeconds(me.workedMs)}`}
                </span>
                {me.firstIn && <> · in at {fmtTime(me.firstIn)}</>}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild className="shadow">
              <Link to="/timeclock">
                <Clock className="mr-2 h-4 w-4" />
                Time clock
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/timecards">
                <FileClock className="mr-2 h-4 w-4" />
                My timecard
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => qc.invalidateQueries({ queryKey: ["company-presence", company.id] })}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Working"
            value={present.working}
            icon={<Clock className="h-4 w-4" />}
            color="emerald"
          />
          <Stat
            label="On break"
            value={present.onBreak}
            icon={<Coffee className="h-4 w-4" />}
            color="amber"
          />
          <Stat
            label="Off"
            value={present.off}
            icon={<LogOut className="h-4 w-4" />}
            color="slate"
          />
        </div>

        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="grid grid-cols-[2fr_1fr] border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <div>Employee</div>
            <div className="text-right">Status</div>
          </div>
          {presenceLoading && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</div>
          )}
          {!presenceLoading && presence.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nobody to show yet.
            </div>
          )}
          {presence.map((p) => (
            <div
              key={p.user_id}
              className="grid grid-cols-[2fr_1fr] items-center gap-2 border-b border-border px-4 py-3 text-sm last:border-0"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {p.full_name || "Unnamed"}
                </div>
                {p.job_title && (
                  <div className="truncate text-xs text-muted-foreground">{p.job_title}</div>
                )}
                {/* Only ever from the published schedule — a draft week is the
                    builder's business, not the floor's. */}
                {dueToday.get(p.user_id)?.published && (
                  <div className="truncate text-xs text-muted-foreground">
                    Due in {fmtTime(dueToday.get(p.user_id)!.starts_at)}
                  </div>
                )}
              </div>
              <div className="text-right">
                <PresencePill status={p.status} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

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
        <div className="flex flex-wrap items-center gap-2">
          {/* The button people reach for all day, so it gets the solid treatment
              and a taller hit area while the rest stay quiet outlines. */}
          <Button asChild className="shadow">
            <Link to="/timeclock"><Clock className="mr-2 h-4 w-4" />Time clock</Link>
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
          <div>Due / In / Out</div>
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
              {/* What the schedule says, above what the clock says. */}
              {r.due && (
                <div className="font-medium text-foreground">
                  Due {fmtTime(r.due.starts_at)}
                  {!r.due.published && <span className="font-normal"> · draft</span>}
                  {r.due.more > 0 && <span className="font-normal"> +{r.due.more}</span>}
                </div>
              )}
              {r.firstIn ? <>In {fmtTime(r.firstIn)}</> : r.due ? "Not in yet" : "—"}
              {r.lastOut && <><br />Out {fmtTime(r.lastOut)}</>}
            </div>
            <div className="text-right text-xs">
              {/* The break running right now, counting down to zero and then
                  past it in red. Without a length picked all we can honestly
                  show is how long they have been gone. */}
              {r.breakElapsedMs != null && (
                <div
                  className={`font-mono text-sm font-semibold tabular-nums ${
                    r.breakRemainingMs != null && r.breakRemainingMs <= 0
                      ? "text-destructive"
                      : "text-amber-700"
                  }`}
                >
                  {r.breakRemainingMs == null
                    ? fmtCountdown(r.breakElapsedMs)
                    : r.breakRemainingMs > 0
                      ? fmtCountdown(r.breakRemainingMs)
                      : `-${fmtCountdown(-r.breakRemainingMs)}`}
                  <span className="ml-1 font-sans text-[10px] font-medium uppercase tracking-wide">
                    {r.breakRemainingMs == null
                      ? "on break"
                      : r.breakRemainingMs > 0
                        ? "left"
                        : "over"}
                  </span>
                </div>
              )}
              {r.unpaidBreakMs > 0 && <div className="text-muted-foreground">unpaid {fmtHours(r.unpaidBreakMs)}</div>}
              {r.paidBreakMs > 0 && <div className="text-muted-foreground">paid {fmtHours(r.paidBreakMs)}</div>}
              {/* Came back before the break was up — the timecard carries the
                  same flag, this is just where a manager sees it first. */}
              {r.shortBreaks > 0 && (
                <div className="text-destructive">
                  ⚠ {r.shortBreaks === 1 ? "incomplete break" : `${r.shortBreaks} incomplete`}
                </div>
              )}
              {r.breakElapsedMs == null && r.shortBreaks === 0 && r.unpaidBreakMs === 0 && r.paidBreakMs === 0 && <span className="text-muted-foreground">—</span>}
            </div>
            {/* A clock that is still running shows its seconds; one that has
                stopped would only look broken ticking against nothing. */}
            <div className="text-right font-medium tabular-nums text-foreground">
              {fmtHours(r.workedMs)}
              {r.workedLive && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {fmtSeconds(r.workedMs)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The employee-facing badge: a state, with no time attached to it. */
function PresencePill({ status }: { status: string }) {
  if (status === "working") {
    return (
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
        ● Working
      </span>
    );
  }
  if (status === "on_break") {
    return (
      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
        ● On break
      </span>
    );
  }
  return (
    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Off</span>
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
