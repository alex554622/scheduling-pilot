import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules, roundToMinutes } from "@/lib/app-rules";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Download, Loader2, Pencil, Printer, Users } from "lucide-react";
import { PrintableTimecard } from "@/components/printable-timecard";
import { TimecardDayEditor, type EditablePunch } from "@/components/timecard-day-editor";
import { splitPeriod, overtimeNote } from "@/lib/overtime";

export const Route = createFileRoute("/_authenticated/timecards")({
  component: TimecardsPage,
});

type Punch = {
  id: string;
  user_id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  distance_m: number | null;
  within_geofence: boolean;
  break_minutes: number | null;
};

type Period = "week" | "biweek";

function startOfWeek(d: Date, weekStartDay = 1) {
  const x = new Date(d);
  const day = (x.getDay() - weekStartDay + 7) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDate(d: Date) { return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
function fmtTime(s: string, roundMin = 0) {
  return roundToMinutes(new Date(s), roundMin).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtHours(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function TimecardsPage() {
  const qc = useQueryClient();
  const { user, profile, company, primaryRole, loading } = useAuth();
  const rules = useAppRules();
  const isSuperAdmin = primaryRole === "super_admin";
  const isManager = primaryRole === "company_admin" || isSuperAdmin;
  const [period, setPeriod] = useState<Period>("week");
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date(), rules.week_start_day));
  const [selectedUser, setSelectedUser] = useState<string | "me">("me");
  const [editingDay, setEditingDay] = useState<Date | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);

  // Keep the anchor aligned to the configured week-start day if it changes.
  useEffect(() => {
    setAnchor((a) => startOfWeek(a, rules.week_start_day));
  }, [rules.week_start_day]);

  // Live refresh: any insert/update/delete on time_punches for this company refetches the timecard.
  useEffect(() => {
    if (!company?.id) return;
    const ch = supabase
      .channel(`timecards:${company.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_punches", filter: `company_id=eq.${company.id}` },
        () => {
          qc.invalidateQueries({ queryKey: ["timecards"] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [company?.id, qc]);


  const days = period === "week" ? 7 : 14;
  const rangeStart = anchor;
  const rangeEnd = addDays(anchor, days);

  // Roster (managers only). A super admin belongs to no company but RLS lets
  // them read every profile and punch, so they get the whole platform rather
  // than an empty list — this page used to refuse them outright.
  const rosterQ = useQuery({
    queryKey: ["timecard-roster", isSuperAdmin ? "all" : company?.id],
    enabled: isManager && (isSuperAdmin || !!company?.id),
    queryFn: async () => {
      let q = supabase.from("profiles").select("id, full_name, position, company_id");
      q = isSuperAdmin ? q.not("company_id", "is", null) : q.eq("company_id", company!.id);
      const { data, error } = await q.order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Company names for the roster and the printed header. A company admin only
  // ever sees their own; a super admin spans several.
  const companiesQ = useQuery({
    queryKey: ["timecard-companies"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.from("companies").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  // "Me" is meaningless for a super admin — they have no punches of their own —
  // so fall back to the first person on the roster.
  const targetUserId =
    !isManager || (selectedUser === "me" && !isSuperAdmin)
      ? user?.id
      : selectedUser === "me"
        ? rosterQ.data?.[0]?.id
        : selectedUser;

  const punchesQ = useQuery<Punch[]>({
    queryKey: ["timecards", targetUserId, rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select("id, user_id, kind, at, distance_m, within_geofence, break_minutes")
        .eq("user_id", targetUserId!)
        .gte("at", rangeStart.toISOString())
        .lt("at", rangeEnd.toISOString())
        .order("at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Punch[];
    },
  });

  const grouped = useMemo(() => {
    const byDay = new Map<string, Punch[]>();
    for (const p of punchesQ.data ?? []) {
      const k = new Date(p.at).toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(p);
    }
    type Pair = { in: Punch; out?: Punch; unpaidBreakMs: number; paidBreakMs: number };
    const rows: { date: Date; punches: Punch[]; pairs: Pair[]; totalMs: number; unpaidBreakMs: number; paidBreakMs: number }[] = [];
    let weekTotal = 0;
    let weekUnpaid = 0;
    let weekPaid = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(rangeStart, i);
      const list = byDay.get(d.toDateString()) ?? [];
      const pairs: Pair[] = [];
      let totalMs = 0;
      let dayUnpaidMs = 0;
      let dayPaidMs = 0;
      let openIn: Punch | null = null;
      let openBreak: Punch | null = null;
      let currentUnpaid = 0;
      let currentPaid = 0;
      for (const p of list) {
        if (p.kind === "in") {
          if (openIn) pairs.push({ in: openIn, unpaidBreakMs: currentUnpaid, paidBreakMs: currentPaid });
          openIn = p;
          currentUnpaid = 0;
          currentPaid = 0;
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            const net = Math.max(0, gross - currentUnpaid);
            pairs.push({ in: openIn, out: p, unpaidBreakMs: currentUnpaid, paidBreakMs: currentPaid });
            totalMs += net;
            dayUnpaidMs += currentUnpaid;
            dayPaidMs += currentPaid;
            openIn = null;
            currentUnpaid = 0;
            currentPaid = 0;
            openBreak = null;
          }
        } else if (p.kind === "break_start") {
          if (openIn && !openBreak) openBreak = p;
        } else if (p.kind === "break_end") {
          if (openBreak) {
            const elapsed = new Date(p.at).getTime() - new Date(openBreak.at).getTime();
            const isPaid = openBreak.break_minutes === 10;
            if (isPaid) currentPaid += elapsed;
            else currentUnpaid += elapsed;
            openBreak = null;
          }
        }
      }
      if (openIn) pairs.push({ in: openIn, unpaidBreakMs: currentUnpaid, paidBreakMs: currentPaid });
      rows.push({ date: d, punches: list, pairs, totalMs, unpaidBreakMs: dayUnpaidMs, paidBreakMs: dayPaidMs });
      weekTotal += totalMs;
      weekUnpaid += dayUnpaidMs;
      weekPaid += dayPaidMs;
    }
    return { rows, weekTotal, weekUnpaid, weekPaid };
  }, [punchesQ.data, rangeStart, days]);

  function nav(dir: -1 | 1) {
    setAnchor((a) => addDays(a, dir * days));
  }

  /**
   * Flattens the same day/shift structure the printed document renders: the
   * date and the day's total sit on the day's first row, extra shifts hang
   * beneath. Kept next to the PDF call so the two can't drift.
   */
  function buildTimecardPdfData() {
    const HOUR = 3_600_000;
    const dec = (ms: number) => (ms / HOUR).toFixed(2);
    const rows = grouped.rows.flatMap((r) => {
      if (r.pairs.length === 0) {
        return [{ date: fmtDate(r.date), clockIn: "—", clockOut: "—", unpaid: "—", paid: "—", hours: "0h 00m", notes: "No punches" }];
      }
      return r.pairs.map((p, i) => ({
        date: i === 0 ? fmtDate(r.date) : "",
        clockIn: fmtTime(p.in.at, rules.punch_round_minutes),
        clockOut: p.out ? fmtTime(p.out.at, rules.punch_round_minutes) : "—",
        unpaid: p.unpaidBreakMs > 0 ? fmtHours(p.unpaidBreakMs) : "—",
        paid: p.paidBreakMs > 0 ? fmtHours(p.paidBreakMs) : "—",
        hours: i === 0 ? fmtHours(r.totalMs) : "",
        notes: [!p.out ? "Still clocked in" : null, !p.in.within_geofence || (p.out && !p.out.within_geofence) ? "Off-site punch" : null]
          .filter(Boolean).join(" · "),
      }));
    });

    const { regularMs, overtimeMs, doubleTimeMs } = splitPeriod(
      grouped.rows.map((r) => r.totalMs),
      rules,
      period === "week",
    );
    const lastDay = addDays(rangeEnd, -1);

    return {
      companyName: employeeCompanyName,
      employeeName,
      position: employeePosition,
      periodLabel: period === "week" ? "Weekly" : "Bi-weekly",
      rangeLabel: `${rangeStart.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} – ${lastDay.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`,
      daysWorked: grouped.rows.filter((r) => r.pairs.length > 0).length,
      rows,
      totals: {
        unpaid: fmtHours(grouped.weekUnpaid),
        paid: fmtHours(grouped.weekPaid),
        worked: fmtHours(grouped.weekTotal),
        workedDecimal: dec(grouped.weekTotal),
      },
      regular: fmtHours(regularMs),
      regularDecimal: dec(regularMs),
      overtime: overtimeMs > 0 ? fmtHours(overtimeMs) : null,
      overtimeDecimal: overtimeMs > 0 ? dec(overtimeMs) : null,
      doubleTime: doubleTimeMs > 0 ? fmtHours(doubleTimeMs) : null,
      doubleTimeDecimal: doubleTimeMs > 0 ? dec(doubleTimeMs) : null,
      overtimeNote: overtimeNote(rules, period === "week"),
      roundNote: `Punch times ${rules.punch_round_minutes > 0 ? `rounded to the nearest ${rules.punch_round_minutes} minutes` : "shown as recorded"}. Unpaid break time is deducted from hours worked; paid break time is not.`,
      filename: `timecard-${employeeName.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "")}-${rangeStart.toISOString().slice(0, 10)}.pdf`,
    };
  }

  async function downloadTimecard() {
    setSavingPdf(true);
    try {
      const { downloadTimecardPdf } = await import("@/lib/pdf");
      await downloadTimecardPdf(buildTimecardPdfData());
    } finally {
      setSavingPdf(false);
    }
  }


  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  // A super admin has no company of their own but can read every timecard.
  if (!company && !isSuperAdmin) return <div className="text-sm text-muted-foreground">Join a company to view timecards.</div>;

  // Whose card is on screen — the roster row when a manager has picked someone,
  // otherwise the signed-in user's own profile.
  const viewing = (rosterQ.data ?? []).find((m) => m.id === targetUserId);
  const isSelf = targetUserId === user?.id;
  const employeeName = (isSelf ? profile?.full_name : viewing?.full_name) || viewing?.full_name || user?.email || "Employee";
  const employeePosition = isSelf ? profile?.position : viewing?.position;
  // The printed header names the employee's company, which for a super admin is
  // whichever company the person they picked belongs to — not their own.
  const employeeCompanyName =
    (isSelf ? company?.name : (companiesQ.data ?? []).find((c) => c.id === viewing?.company_id)?.name) ??
    company?.name ??
    "Scheduling Pilot";

  return (
    <>
      <PrintableTimecard
        companyName={employeeCompanyName}
        employeeName={employeeName}
        position={employeePosition}
        periodLabel={period === "week" ? "Weekly" : "Bi-weekly"}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        days={grouped.rows.map((r) => ({
          date: r.date,
          totalMs: r.totalMs,
          pairs: r.pairs.map((p) => ({
            inAt: p.in.at,
            outAt: p.out?.at ?? null,
            unpaidBreakMs: p.unpaidBreakMs,
            paidBreakMs: p.paidBreakMs,
            offSite: !p.in.within_geofence || (!!p.out && !p.out.within_geofence),
          })),
        }))}
        totals={{
          workedMs: grouped.weekTotal,
          unpaidBreakMs: grouped.weekUnpaid,
          paidBreakMs: grouped.weekPaid,
        }}
        split={splitPeriod(grouped.rows.map((r) => r.totalMs), rules, period === "week")}
        overtimeNote={overtimeNote(rules, period === "week")}
        roundMinutes={rules.punch_round_minutes}
        formatTime={(iso) => fmtTime(iso, rules.punch_round_minutes)}
        formatHours={fmtHours}
      />

    <div data-print-hide className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Timecards</h1>
          <p className="text-sm text-muted-foreground">
            {period === "week" ? "Weekly" : "Bi-weekly"} totals · {fmtDate(rangeStart)} – {fmtDate(addDays(rangeEnd, -1))}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/timeclock"><Clock className="mr-2 h-4 w-4" />Time clock</Link>
          </Button>
          {/* Both produce the same document — see PrintableTimecard. Print goes
              through the browser dialog (where Save as PDF lives); Download
              saves the same page as a self-contained file. */}
          <Button variant="outline" size="sm" onClick={() => window.print()} title="Send to a printer, or choose “Save as PDF”">
            <Printer className="mr-2 h-4 w-4" />Print
          </Button>
          <Button size="sm" onClick={downloadTimecard} disabled={savingPdf} title="Saves a PDF straight to your downloads">
            {savingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Download PDF
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <div className="inline-flex rounded-md border border-border p-0.5">
          <button
            className={`px-3 py-1 text-xs font-medium rounded ${period === "week" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => setPeriod("week")}
          >Weekly</button>
          <button
            className={`px-3 py-1 text-xs font-medium rounded ${period === "biweek" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => setPeriod("biweek")}
          >Bi-weekly</button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => nav(-1)} aria-label="Previous"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(startOfWeek(new Date(), rules.week_start_day))}>This {period === "week" ? "week" : "2-week"}</Button>
          <Button variant="outline" size="icon" onClick={() => nav(1)} aria-label="Next"><ChevronRight className="h-4 w-4" /></Button>
        </div>
        {isManager && (
          <div className="flex w-full items-center gap-2 border-t border-border pt-3 sm:w-auto sm:border-0 sm:pt-0">
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
            <label htmlFor="timecard-employee" className="shrink-0 text-sm font-medium text-foreground">
              Employee
            </label>
            <select
              id="timecard-employee"
              className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
            >
              {!isSuperAdmin && <option value="me">Me ({profile?.full_name || user?.email})</option>}
              {(rosterQ.data ?? [])
                .filter((m) => m.id !== user?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name || "Unnamed"}</option>
                ))}
            </select>
          </div>
        )}
      </div>

      {/* A failed query used to render as an ordinary empty timecard, which is
          indistinguishable from an employee who simply didn't work. Say so. */}
      {(rosterQ.error || punchesQ.error) && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Couldn't load this timecard</p>
            <p className="mt-0.5">{((rosterQ.error ?? punchesQ.error) as Error).message}</p>
          </div>
        </div>
      )}

      {isManager && !rosterQ.isLoading && !rosterQ.error && (rosterQ.data ?? []).length <= 1 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            You're the only person on this company's roster, so there are no other timecards to open. Add employees from
            the <Link to="/employees" className="underline">Employees</Link> page.
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground`}>
          <div>Date</div>
          <div>Punches</div>
          <div className="text-right">Hours</div>
          {isManager && <div className="w-16 text-right">Edit</div>}
        </div>
        {!punchesQ.isLoading && !punchesQ.error && (punchesQ.data ?? []).length === 0 && (
          <div className="border-b border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No punches for <span className="font-medium text-foreground">{employeeName}</span> between{" "}
            {fmtDate(rangeStart)} and {fmtDate(addDays(rangeEnd, -1))}.
            {isManager && " Use Edit on a day to add one."}
          </div>
        )}
        {grouped.rows.map((r) => (
          <div key={r.date.toISOString()} className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} items-start gap-2 border-b border-border px-4 py-3 text-sm last:border-0`}>
            <div className="font-medium text-foreground">{fmtDate(r.date)}</div>
            <div className="space-y-1">
              {r.pairs.length === 0 && <span className="text-muted-foreground">—</span>}
              {r.pairs.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">IN {fmtTime(p.in.at, rules.punch_round_minutes)}</span>
                  {p.out ? (
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700">OUT {fmtTime(p.out.at, rules.punch_round_minutes)}</span>
                  ) : (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">Still clocked in</span>
                  )}
                  {(!p.in.within_geofence || (p.out && !p.out.within_geofence)) && (
                    <span className="text-xs text-destructive">⚠ off-site</span>
                  )}
                </div>
              ))}
            </div>
            <div className="text-right font-medium text-foreground">
              {fmtHours(r.totalMs)}
              {(r.unpaidBreakMs > 0 || r.paidBreakMs > 0) && (
                <div className="text-[10px] font-normal text-muted-foreground">
                  {r.unpaidBreakMs > 0 && <>unpaid {fmtHours(r.unpaidBreakMs)}</>}
                  {r.unpaidBreakMs > 0 && r.paidBreakMs > 0 && " · "}
                  {r.paidBreakMs > 0 && <>paid {fmtHours(r.paidBreakMs)}</>}
                </div>
              )}
            </div>
            {isManager && (
              <div className="w-16 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setEditingDay(r.date)}
                  aria-label={`Edit punches for ${fmtDate(r.date)}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
        {(() => {
          const split = splitPeriod(grouped.rows.map((r) => r.totalMs), rules, period === "week");
          const isOT = split.overtimeMs > 0 || split.doubleTimeMs > 0;
          return (
            <div className="grid grid-cols-[1fr_2fr_1fr] bg-muted/30 px-4 py-3 text-sm">
              <div className="font-semibold text-foreground">Total</div>
              <div className="text-xs text-muted-foreground">
                Unpaid break: {fmtHours(grouped.weekUnpaid)} · Paid break: {fmtHours(grouped.weekPaid)}
                {split.overtimeMs > 0 && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                    OT {fmtHours(split.overtimeMs)}
                  </span>
                )}
                {split.doubleTimeMs > 0 && (
                  <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                    2× {fmtHours(split.doubleTimeMs)}
                  </span>
                )}
              </div>
              <div className={`text-right font-semibold ${isOT ? "text-amber-700" : "text-foreground"}`}>{fmtHours(grouped.weekTotal)}</div>
            </div>
          );
        })()}
      </div>

      {isManager && editingDay && targetUserId && (
        <TimecardDayEditor
          open
          onOpenChange={(next) => !next && setEditingDay(null)}
          day={editingDay}
          employeeId={targetUserId}
          employeeName={employeeName}
          punches={
            (grouped.rows.find((r) => r.date.toDateString() === editingDay.toDateString())?.punches ??
              []) as EditablePunch[]
          }
        />
      )}
    </div>
    </>
  );
}
