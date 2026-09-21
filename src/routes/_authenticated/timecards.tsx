import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import { useStaffVisibility } from "@/lib/staff-visibility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  Loader2,
  MapPin,
  Pencil,
  Printer,
  Trash2,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PrintableTimecard } from "@/components/printable-timecard";
import { TimecardDayEditor, type EditablePunch } from "@/components/timecard-day-editor";
import { splitPeriod, overtimeNote } from "@/lib/overtime";
import {
  readBreak,
  roundPunches,
  roundToMinutes,
  totalsByPerson,
  type SimplePunch,
} from "@/lib/timecard-totals";
import { fromDayString, toDayString } from "@/lib/schedule-pattern";

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
  latitude: number | null;
  longitude: number | null;
};

/** Punch kinds as a manager reads them in the location log. */
const KIND_LABEL: Record<Punch["kind"], string> = {
  in: "Clocked in",
  out: "Clocked out",
  break_start: "Break started",
  break_end: "Break ended",
};

type Period = "week" | "biweek";

function startOfWeek(d: Date, weekStartDay = 1) {
  const x = new Date(d);
  const day = (x.getDay() - weekStartDay + 7) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDate(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(s: string, roundMin = 0) {
  return roundToMinutes(new Date(s), roundMin).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
/** 6.00, 29.90 — decimal hours, the unit payroll actually takes. */
function fmtDecimal(ms: number) {
  return (ms / 3600000).toFixed(2);
}

/** `Sat Sep 5`, for the day rows under a person. */
function fmtDayShort(d: Date) {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** AP, DG — the initials shown in the avatar circle. */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
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
  const staff = useStaffVisibility();
  const isSuperAdmin = primaryRole === "super_admin";
  const isManager = primaryRole === "company_admin" || isSuperAdmin;
  const [period, setPeriod] = useState<Period>("week");
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date(), rules.week_start_day));
  const [selectedUser, setSelectedUser] = useState<string | "me">("me");
  const [editingDay, setEditingDay] = useState<Date | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  // Clearing a whole period is easy to regret, so it takes a tick and a click.
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeUnderstood, setWipeUnderstood] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [wipeWho, setWipeWho] = useState<"one" | "all">("one");
  const [wipeScope, setWipeScope] = useState<"day" | "period" | "month">("period");
  const [wipeDay, setWipeDay] = useState(() => toDayString(new Date()));
  const [wipeReason, setWipeReason] = useState("");
  const [wipeDone, setWipeDone] = useState<number | null>(null);

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
        {
          event: "*",
          schema: "public",
          table: "time_punches",
          filter: `company_id=eq.${company.id}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["timecards"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
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

  /**
   * The roster this screen works from, with the company's "keep the office off
   * the rosters" rule applied. Everything below reads this rather than the
   * query: the person picker, the roster-wide table, and which card opens by
   * default. A name hidden from the list but still reachable from the picker is
   * not hidden, it is just harder to find.
   */
  const roster = useMemo(
    () => staff.visible(rosterQ.data ?? [], (m) => m.id),
    [rosterQ.data, staff],
  );

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
  /** The whole roster at once, rather than one card at a time. */
  const viewingAll = isManager && selectedUser === "all";
  // Which people are expanded to show their individual time cards.
  const [expanded, setExpanded] = useState<string[]>([]);

  const targetUserId = viewingAll
    ? undefined
    : !isManager || (selectedUser === "me" && !isSuperAdmin)
      ? user?.id
      : selectedUser === "me"
        ? roster[0]?.id
        : selectedUser;

  const punchesQ = useQuery<Punch[]>({
    queryKey: ["timecards", targetUserId, rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select(
          "id, user_id, kind, at, distance_m, within_geofence, break_minutes, latitude, longitude",
        )
        .eq("user_id", targetUserId!)
        .gte("at", rangeStart.toISOString())
        .lt("at", rangeEnd.toISOString())
        .order("at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Punch[];
    },
  });

  // Everyone's punches for the period, for the roster-wide view. Only a
  // manager can read another person's punches, so this stays off for employees
  // rather than returning their own rows and reading as "nobody worked".
  const allQ = useQuery({
    queryKey: ["timecards-all", rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: viewingAll,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select("user_id, kind, at, break_minutes")
        .gte("at", rangeStart.toISOString())
        .lt("at", rangeEnd.toISOString())
        .order("at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SimplePunch[];
    },
  });

  /** One line per person: their days, breaks, hours and overtime split. */
  const everyone = useMemo(() => {
    if (!viewingAll) return [];
    const totals = totalsByPerson(
      allQ.data ?? [],
      rules.punch_round_minutes,
      rules.cap_break_to_length,
    );
    return roster
      .map((m) => {
        const t = totals.get(m.id) ?? {
          grossMs: 0,
          workedMs: 0,
          unpaidMs: 0,
          paidMs: 0,
          dayTotals: [],
          days: [],
          incompleteBreaks: 0,
          overBreakMs: 0,
        };
        const split = splitPeriod(t.dayTotals, rules, period === "week");
        return {
          id: m.id,
          name: m.full_name || "Unnamed",
          position: m.position ?? null,
          daysWorked: t.dayTotals.filter((ms) => ms > 0).length,
          // One time card per clock-in, which is what the count column means.
          cardCount: t.days.reduce((n, d) => n + d.spans.length, 0),
          ...t,
          ...split,
        };
      })
      .sort((a, b) => b.workedMs - a.workedMs || a.name.localeCompare(b.name));
  }, [viewingAll, allQ.data, roster, rules, period]);

  /** Every punch on screen for this person, deleted in one go. */
  /** Whose punches are being cleared — a super admin has no company of their own. */
  const wipeCompanyId =
    company?.id ?? roster.find((m) => m.id === targetUserId)?.company_id ?? null;

  /** Start and end of whatever the delete dialog is pointed at. */
  const wipeRange = useMemo(() => {
    if (wipeScope === "day") {
      const from = fromDayString(wipeDay);
      return { from, to: addDays(from, 1) };
    }
    if (wipeScope === "month") {
      const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      return { from, to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) };
    }
    return { from: rangeStart, to: rangeEnd };
  }, [wipeScope, wipeDay, anchor, rangeStart, rangeEnd]);

  // How many punches that range holds, so nobody deletes blind.
  const wipeCountQ = useQuery({
    queryKey: [
      "timecards-wipe-count",
      wipeCompanyId,
      wipeWho === "one" ? targetUserId : "all",
      wipeRange.from.toISOString(),
      wipeRange.to.toISOString(),
    ],
    enabled: wipeOpen && !!wipeCompanyId,
    queryFn: async () => {
      let q = supabase
        .from("time_punches")
        .select("id", { count: "exact", head: true })
        .eq("company_id", wipeCompanyId!)
        .gte("at", wipeRange.from.toISOString())
        .lt("at", wipeRange.to.toISOString());
      if (wipeWho === "one" && targetUserId) q = q.eq("user_id", targetUserId);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });

  /**
   * Deleting goes through manager_delete_punch_range: `authenticated` may only
   * read and insert punches, and every removal is recorded with a reason.
   */
  const wipePeriod = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("manager_delete_punch_range", {
        _company: wipeCompanyId!,
        _user: wipeWho === "one" ? (targetUserId ?? null) : null,
        _from: wipeRange.from.toISOString(),
        _to: wipeRange.to.toISOString(),
        _reason: wipeReason.trim(),
      });
      if (error) throw error;
      return (data as unknown as number) ?? 0;
    },
    onSuccess: (n) => {
      setWipeDone(n);
      setWipeUnderstood(false);
      void qc.invalidateQueries({ queryKey: ["timecards"] });
      void qc.invalidateQueries({ queryKey: ["timecards-all"] });
      void qc.invalidateQueries({ queryKey: ["timecards-wipe-count"] });
    },
    onError: (e: Error) => setWipeError(e.message),
  });

  const grouped = useMemo(() => {
    const byDay = new Map<string, Punch[]>();
    for (const p of punchesQ.data ?? []) {
      const k = new Date(p.at).toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(p);
    }
    type Pair = {
      in: Punch;
      out?: Punch;
      unpaidBreakMs: number;
      paidBreakMs: number;
      /** Breaks they came back from early — the shift is flagged, not docked. */
      incompleteBreaks: number;
      /** Break time run past the picked length, which the shift was not charged. */
      overBreakMs: number;
    };
    const rows: {
      date: Date;
      punches: Punch[];
      pairs: Pair[];
      totalMs: number;
      unpaidBreakMs: number;
      paidBreakMs: number;
      incompleteBreaks: number;
      overBreakMs: number;
    }[] = [];
    let weekTotal = 0;
    let weekUnpaid = 0;
    let weekPaid = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(rangeStart, i);
      const list = byDay.get(d.toDateString()) ?? [];
      // The hours are counted from the rounded reading of the day, so the
      // times printed on the card are the times that were paid. `list` stays
      // raw: it is what the day editor opens, and a manager correcting a punch
      // must see what the clock recorded.
      const counted = roundPunches(list, rules.punch_round_minutes);
      const pairs: Pair[] = [];
      let totalMs = 0;
      let dayUnpaidMs = 0;
      let dayPaidMs = 0;
      let openIn: Punch | null = null;
      let openBreak: Punch | null = null;
      let currentUnpaid = 0;
      let currentPaid = 0;
      let currentShort = 0;
      let currentOver = 0;
      let dayShort = 0;
      let dayOver = 0;
      const openPair = (i: Punch, o?: Punch): Pair => ({
        in: i,
        out: o,
        unpaidBreakMs: currentUnpaid,
        paidBreakMs: currentPaid,
        incompleteBreaks: currentShort,
        overBreakMs: currentOver,
      });
      for (const p of counted) {
        if (p.kind === "in") {
          if (openIn) pairs.push(openPair(openIn));
          openIn = p;
          currentUnpaid = 0;
          currentPaid = 0;
          currentShort = 0;
          currentOver = 0;
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            const net = Math.max(0, gross - currentUnpaid);
            pairs.push(openPair(openIn, p));
            totalMs += net;
            dayUnpaidMs += currentUnpaid;
            dayPaidMs += currentPaid;
            dayShort += currentShort;
            dayOver += currentOver;
            openIn = null;
            currentUnpaid = 0;
            currentPaid = 0;
            currentShort = 0;
            currentOver = 0;
            openBreak = null;
          }
        } else if (p.kind === "break_start") {
          if (openIn && !openBreak) openBreak = p;
        } else if (p.kind === "break_end") {
          if (openBreak) {
            // One rule, one place: the same reading the roster-wide totals use.
            const read = readBreak(
              new Date(p.at).getTime() - new Date(openBreak.at).getTime(),
              openBreak.break_minutes,
              rules.cap_break_to_length,
            );
            if (read.paid) currentPaid += read.countedMs;
            else currentUnpaid += read.countedMs;
            if (read.incomplete) currentShort += 1;
            currentOver += read.overMs;
            openBreak = null;
          }
        }
      }
      if (openIn) {
        pairs.push(openPair(openIn));
        dayShort += currentShort;
        dayOver += currentOver;
      }
      rows.push({
        date: d,
        punches: list,
        pairs,
        incompleteBreaks: dayShort,
        overBreakMs: dayOver,
        totalMs,
        unpaidBreakMs: dayUnpaidMs,
        paidBreakMs: dayPaidMs,
      });
      weekTotal += totalMs;
      weekUnpaid += dayUnpaidMs;
      weekPaid += dayPaidMs;
    }
    return { rows, weekTotal, weekUnpaid, weekPaid };
  }, [punchesQ.data, rangeStart, days, rules.punch_round_minutes, rules.cap_break_to_length]);

  // Managers only: every punch in view that carries coordinates, newest first.
  const locationRows = useMemo(
    () =>
      (punchesQ.data ?? [])
        .filter((p) => p.latitude != null && p.longitude != null)
        .slice()
        .reverse(),
    [punchesQ.data],
  );

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
        return [
          {
            date: fmtDate(r.date),
            clockIn: "—",
            clockOut: "—",
            unpaid: "—",
            paid: "—",
            hours: "0h 00m",
            notes: "No punches",
          },
        ];
      }
      return r.pairs.map((p, i) => ({
        date: i === 0 ? fmtDate(r.date) : "",
        clockIn: fmtTime(p.in.at, rules.punch_round_minutes),
        clockOut: p.out ? fmtTime(p.out.at, rules.punch_round_minutes) : "—",
        unpaid: p.unpaidBreakMs > 0 ? fmtHours(p.unpaidBreakMs) : "—",
        paid: p.paidBreakMs > 0 ? fmtHours(p.paidBreakMs) : "—",
        hours: i === 0 ? fmtHours(r.totalMs) : "",
        notes: [
          !p.out ? "Still clocked in" : null,
          // Where someone punched from is a manager's business; an employee's
          // own timecard is about their hours.
          isManager && (!p.in.within_geofence || (p.out && !p.out.within_geofence))
            ? "Off-site punch"
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
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
      roundNote: `Punch times ${rules.punch_round_minutes > 0 ? `and hours rounded to the nearest ${rules.punch_round_minutes} minutes` : "shown as recorded"}. Unpaid break time is deducted from hours worked; paid break time is not.`,
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
  if (!company && !isSuperAdmin)
    return <div className="text-sm text-muted-foreground">Join a company to view timecards.</div>;

  // Whose card is on screen — the roster row when a manager has picked someone,
  // otherwise the signed-in user's own profile.
  const viewing = roster.find((m) => m.id === targetUserId);
  const isSelf = targetUserId === user?.id;
  const employeeName =
    (isSelf ? profile?.full_name : viewing?.full_name) ||
    viewing?.full_name ||
    user?.email ||
    "Employee";
  const employeePosition = isSelf ? profile?.position : viewing?.position;
  // The printed header names the employee's company, which for a super admin is
  // whichever company the person they picked belongs to — not their own.
  const employeeCompanyName =
    (isSelf
      ? company?.name
      : (companiesQ.data ?? []).find((c) => c.id === viewing?.company_id)?.name) ??
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
            offSite: isManager && (!p.in.within_geofence || (!!p.out && !p.out.within_geofence)),
          })),
        }))}
        totals={{
          workedMs: grouped.weekTotal,
          unpaidBreakMs: grouped.weekUnpaid,
          paidBreakMs: grouped.weekPaid,
        }}
        split={splitPeriod(
          grouped.rows.map((r) => r.totalMs),
          rules,
          period === "week",
        )}
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
              {period === "week" ? "Weekly" : "Bi-weekly"} totals · {fmtDate(rangeStart)} –{" "}
              {fmtDate(addDays(rangeEnd, -1))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/timeclock">
                <Clock className="mr-2 h-4 w-4" />
                Time clock
              </Link>
            </Button>
            {/* Both produce the same document — see PrintableTimecard. Print goes
              through the browser dialog (where Save as PDF lives); Download
              saves the same page as a self-contained file. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              title="Send to a printer, or choose “Save as PDF”"
            >
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
            {isManager && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  setWipeError(null);
                  setWipeUnderstood(false);
                  setWipeDone(null);
                  setWipeReason("");
                  setWipeWho(viewingAll ? "all" : "one");
                  setWipeScope("period");
                  setWipeOpen(true);
                }}
                title="Delete timecards for a day, this period, or the whole month"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete timecards
              </Button>
            )}
            <Button
              size="sm"
              onClick={downloadTimecard}
              disabled={savingPdf}
              title="Saves a PDF straight to your downloads"
            >
              {savingPdf ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              Download PDF
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              className={`px-3 py-1 text-xs font-medium rounded ${period === "week" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => setPeriod("week")}
            >
              Weekly
            </button>
            <button
              className={`px-3 py-1 text-xs font-medium rounded ${period === "biweek" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => setPeriod("biweek")}
            >
              Bi-weekly
            </button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => nav(-1)} aria-label="Previous">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAnchor(startOfWeek(new Date(), rules.week_start_day))}
            >
              This {period === "week" ? "week" : "2-week"}
            </Button>
            <Button variant="outline" size="icon" onClick={() => nav(1)} aria-label="Next">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {isManager && (
            <div className="flex w-full items-center gap-2 border-t border-border pt-3 sm:w-auto sm:border-0 sm:pt-0">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <label
                htmlFor="timecard-employee"
                className="shrink-0 text-sm font-medium text-foreground"
              >
                Employee
              </label>
              <select
                id="timecard-employee"
                className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
              >
                <option value="all">All employees</option>
                {!isSuperAdmin && (
                  <option value="me">Me ({profile?.full_name || user?.email})</option>
                )}
                {roster
                  .filter((m) => m.id !== user?.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name || "Unnamed"}
                    </option>
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

        {isManager && !rosterQ.isLoading && !rosterQ.error && roster.length <= 1 && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              You're the only person on this company's roster, so there are no other timecards to
              open. Add employees from the{" "}
              <Link to="/employees" className="underline">
                Employees
              </Link>{" "}
              page.
            </p>
          </div>
        )}

        {/* Everyone at once: one line per person for the period on screen. */}
        {viewingAll && (
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="font-semibold text-foreground">
                All employees · {fmtDate(rangeStart)} – {fmtDate(addDays(rangeEnd, -1))}
              </h2>
              <div className="flex items-center gap-3">
                {everyone.some((r) => r.cardCount > 0) && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() =>
                      setExpanded((e) =>
                        e.length > 0
                          ? []
                          : everyone.filter((r) => r.cardCount > 0).map((r) => r.id),
                      )
                    }
                  >
                    {expanded.length > 0 ? "Collapse all" : "Expand all"}
                  </button>
                )}
                {allQ.isLoading && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Time card</th>
                    <th className="px-3 py-2 text-right font-medium">Actual hours</th>
                    <th className="px-3 py-2 text-right font-medium">Total paid hours</th>
                    <th className="px-3 py-2 text-right font-medium">Regular hours</th>
                    <th className="px-3 py-2 text-right font-medium">OT hours</th>
                    <th className="px-3 py-2 text-right font-medium">Double time</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {everyone.map((r, rowIndex) => {
                    const open = expanded.includes(r.id);
                    // Every other person is banded, and their expanded time
                    // cards carry the same band, so one person's days never
                    // read as belonging to the name above them. A shadow under
                    // the row cannot do this job: the next row paints its own
                    // background straight over it.
                    const banded = rowIndex % 2 === 1;
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={`border-t border-border ${banded ? "bg-muted/40" : "bg-card"}`}
                        >
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={r.cardCount === 0}
                                onClick={() =>
                                  setExpanded((e) =>
                                    e.includes(r.id) ? e.filter((x) => x !== r.id) : [...e, r.id],
                                  )
                                }
                                aria-expanded={open}
                                aria-label={`${open ? "Hide" : "Show"} ${r.name}'s time cards`}
                                className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                              >
                                <ChevronDown
                                  className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`}
                                />
                              </button>
                              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary">
                                {initials(r.name)}
                              </span>
                              <div>
                                <div className="font-medium text-foreground">{r.name}</div>
                                {r.position && (
                                  <div className="text-xs text-muted-foreground">{r.position}</div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 font-medium text-foreground">
                            {r.cardCount === 0
                              ? "—"
                              : `${r.cardCount} Time Card${r.cardCount === 1 ? "" : "s"}`}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-foreground">
                            {fmtDecimal(r.grossMs)}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-foreground">
                            {fmtDecimal(r.workedMs)}
                          </td>
                          <td className="px-3 py-2 text-right text-foreground">
                            {fmtDecimal(r.regularMs)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right ${r.overtimeMs > 0 ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                          >
                            {fmtDecimal(r.overtimeMs)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right ${r.doubleTimeMs > 0 ? "font-medium text-destructive" : "text-muted-foreground"}`}
                          >
                            {fmtDecimal(r.doubleTimeMs)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedUser(r.id)}
                            >
                              Open
                            </Button>
                          </td>
                        </tr>

                        {open &&
                          r.days.map((d) =>
                            d.spans.map((span, i) => (
                              <tr
                                key={`${d.key}-${span.inAt}`}
                                className={`border-t border-border/50 ${banded ? "bg-muted/60" : "bg-muted/25"}`}
                              >
                                <td className="py-1.5 pl-14 pr-4 text-muted-foreground">
                                  {i === 0 ? fmtDayShort(d.date) : ""}
                                </td>
                                <td className="px-3 py-1.5 text-foreground">
                                  {fmtTime(span.inAt, rules.punch_round_minutes)}
                                  {" – "}
                                  {span.outAt ? (
                                    fmtTime(span.outAt, rules.punch_round_minutes)
                                  ) : (
                                    <span className="text-warning-foreground">
                                      still clocked in
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground">
                                  {fmtDecimal(span.grossMs)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground">
                                  {fmtDecimal(span.workedMs)}
                                </td>
                                <td className="px-3 py-1.5" colSpan={4} />
                              </tr>
                            )),
                          )}
                      </Fragment>
                    );
                  })}
                  {everyone.length === 0 && !allQ.isLoading && (
                    <tr>
                      <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                        No punches for this period.
                      </td>
                    </tr>
                  )}
                </tbody>
                {everyone.length > 0 && (
                  <tfoot>
                    <tr className="border-t border-border bg-muted/30 font-medium text-foreground">
                      <td className="px-4 py-2">Totals</td>
                      <td className="px-3 py-2">
                        {everyone.reduce((n, r) => n + r.cardCount, 0)} Time Cards
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.grossMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.workedMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.regularMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.overtimeMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.doubleTimeMs, 0))}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Actual hours is time on the clock. Total paid hours is the same less unpaid breaks,
              and splits into regular, overtime and double time.
            </p>
          </div>
        )}

        {!viewingAll && (
          <>
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div
                className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground`}
              >
                <div>Date</div>
                <div>Punches</div>
                <div className="text-right">Hours</div>
                {isManager && <div className="w-16 text-right">Edit</div>}
              </div>
              {!punchesQ.isLoading && !punchesQ.error && (punchesQ.data ?? []).length === 0 && (
                <div className="border-b border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  No punches for <span className="font-medium text-foreground">{employeeName}</span>{" "}
                  between {fmtDate(rangeStart)} and {fmtDate(addDays(rangeEnd, -1))}.
                  {isManager && " Use Edit on a day to add one."}
                </div>
              )}
              {grouped.rows.map((r) => (
                <div
                  key={r.date.toISOString()}
                  className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} items-start gap-2 border-b border-border px-4 py-3 text-sm last:border-0`}
                >
                  <div className="font-medium text-foreground">{fmtDate(r.date)}</div>
                  <div className="space-y-1">
                    {r.pairs.length === 0 && <span className="text-muted-foreground">—</span>}
                    {r.pairs.map((p, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="rounded bg-emerald-100 dark:bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                          IN {fmtTime(p.in.at, rules.punch_round_minutes)}
                        </span>
                        {p.out ? (
                          <span className="rounded bg-blue-100 dark:bg-blue-500/15 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                            OUT {fmtTime(p.out.at, rules.punch_round_minutes)}
                          </span>
                        ) : (
                          <span className="rounded bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                            Still clocked in
                          </span>
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
                    {/* Back on the clock before the break was up. The day is
                        flagged rather than docked — what they took is what
                        came off the shift. */}
                    {r.incompleteBreaks > 0 && (
                      <div className="text-[10px] font-normal text-destructive">
                        ⚠ {r.incompleteBreaks === 1 ? "incomplete break" : `${r.incompleteBreaks} incomplete breaks`}
                      </div>
                    )}
                    {/* Time they ran over and were not charged for. */}
                    {r.overBreakMs > 0 && (
                      <div className="text-[10px] font-normal text-muted-foreground">
                        {fmtHours(r.overBreakMs)} over, not counted
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
                const split = splitPeriod(
                  grouped.rows.map((r) => r.totalMs),
                  rules,
                  period === "week",
                );
                const isOT = split.overtimeMs > 0 || split.doubleTimeMs > 0;
                return (
                  <div className="grid grid-cols-[1fr_2fr_1fr] bg-muted/30 px-4 py-3 text-sm">
                    <div className="font-semibold text-foreground">Total</div>
                    <div className="text-xs text-muted-foreground">
                      Unpaid break: {fmtHours(grouped.weekUnpaid)} · Paid break:{" "}
                      {fmtHours(grouped.weekPaid)}
                      {split.overtimeMs > 0 && (
                        <span className="ml-2 rounded bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-200">
                          OT {fmtHours(split.overtimeMs)}
                        </span>
                      )}
                      {split.doubleTimeMs > 0 && (
                        <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                          2× {fmtHours(split.doubleTimeMs)}
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-right font-semibold ${isOT ? "text-amber-700 dark:text-amber-300" : "text-foreground"}`}
                    >
                      {fmtHours(grouped.weekTotal)}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Where each punch was made. Managers only: an employee's own timecard
          is about their hours, not a map of their movements. */}
            {isManager && (
              <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">Clock-in locations</h2>
                  <span className="text-xs text-muted-foreground">
                    {employeeName} · this {period === "week" ? "week" : "fortnight"}
                  </span>
                </div>
                {locationRows.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No locations recorded for this period.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {locationRows.map((p) => (
                      <div
                        key={p.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-foreground">{KIND_LABEL[p.kind]}</span>{" "}
                          <span className="text-muted-foreground">
                            {new Date(p.at).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {p.distance_m != null && (
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                p.within_geofence
                                  ? "bg-secondary text-muted-foreground"
                                  : "bg-destructive/10 text-destructive"
                              }`}
                            >
                              {Math.round(p.distance_m)} m from worksite
                            </span>
                          )}
                          <a
                            href={`https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=17/${p.latitude}/${p.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                          >
                            Map <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {wipeOpen && (
          <Dialog open onOpenChange={(o) => !o && setWipeOpen(false)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete timecards</DialogTitle>
                <DialogDescription>
                  Each deleted punch is recorded in the audit log under your name, but the hours
                  themselves are gone. Anything already paid from these timecards will no longer add
                  up.
                </DialogDescription>
              </DialogHeader>

              {wipeDone !== null ? (
                <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">
                  Deleted {wipeDone} punch{wipeDone === 1 ? "" : "es"}.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="wipe-who">Whose timecards</Label>
                    <select
                      id="wipe-who"
                      value={wipeWho}
                      onChange={(e) => setWipeWho(e.target.value as "one" | "all")}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="one" disabled={!targetUserId}>
                        Just {employeeName}
                      </option>
                      <option value="all">Everyone in the company</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="wipe-scope">Which dates</Label>
                    <select
                      id="wipe-scope"
                      value={wipeScope}
                      onChange={(e) => setWipeScope(e.target.value as "day" | "period" | "month")}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="day">One day</option>
                      <option value="period">
                        {period === "week" ? "This week" : "These two weeks"} ({fmtDate(rangeStart)}
                        {" – "}
                        {fmtDate(addDays(rangeEnd, -1))})
                      </option>
                      <option value="month">
                        The whole of{" "}
                        {anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                      </option>
                    </select>
                    {wipeScope === "day" && (
                      <Input
                        type="date"
                        value={wipeDay}
                        onChange={(e) => setWipeDay(e.target.value)}
                      />
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="wipe-reason">Note (optional)</Label>
                    <Input
                      id="wipe-reason"
                      value={wipeReason}
                      onChange={(e) => setWipeReason(e.target.value)}
                      placeholder="e.g. punches imported twice by mistake"
                    />
                  </div>

                  <p className="text-sm text-muted-foreground">
                    {wipeCountQ.isLoading
                      ? "Counting…"
                      : `${wipeCountQ.data ?? 0} punch${(wipeCountQ.data ?? 0) === 1 ? "" : "es"} will be deleted.`}
                  </p>

                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-border accent-destructive"
                      checked={wipeUnderstood}
                      onChange={(e) => setWipeUnderstood(e.target.checked)}
                    />
                    <span>
                      I have checked the people and the dates, and I understand these punches cannot
                      be brought back.
                    </span>
                  </label>

                  {wipeError && (
                    <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {wipeError}
                    </p>
                  )}
                </div>
              )}

              <DialogFooter>
                {wipeDone !== null ? (
                  <Button onClick={() => setWipeOpen(false)}>Done</Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setWipeOpen(false)}>
                      Keep them
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={
                        !wipeUnderstood || (wipeCountQ.data ?? 0) === 0 || wipePeriod.isPending
                      }
                      onClick={() => wipePeriod.mutate()}
                    >
                      {wipePeriod.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Delete {wipeCountQ.data ?? 0}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {isManager && editingDay && targetUserId && (
          <TimecardDayEditor
            open
            onOpenChange={(next) => !next && setEditingDay(null)}
            day={editingDay}
            employeeId={targetUserId}
            employeeName={employeeName}
            punches={
              (grouped.rows.find((r) => r.date.toDateString() === editingDay.toDateString())
                ?.punches ?? []) as EditablePunch[]
            }
          />
        )}
      </div>
    </>
  );
}
