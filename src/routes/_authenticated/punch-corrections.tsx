import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import {
  groupByShiftDay,
  MAX_SHIFT_MS,
  punchesInPeriod,
  totalsByPerson,
} from "@/lib/timecard-totals";
import { TimecardDayEditor, type EditablePunch } from "@/components/timecard-day-editor";
import { Button } from "@/components/ui/button";
import { localeTag, translate, useT } from "@/lib/i18n";
import { ChevronLeft, ChevronRight, Pencil, History, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/punch-corrections")({
  component: PunchCorrectionsPage,
});

type Punch = EditablePunch & { user_id: string };

type AuditRow = {
  id: string;
  punch_id: string | null;
  user_id: string;
  actor_id: string;
  action: "create" | "update" | "delete";
  reason: string;
  before: any;
  after: any;
  created_at: string;
};

/** The week holding `d`, starting on the company's week-start day (0 = Sunday). */
function startOfWeek(d: Date, weekStartDay = 1) {
  const x = new Date(d);
  const day = (x.getDay() - weekStartDay + 7) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function fmtTime(s: string) {
  return new Date(s).toLocaleTimeString(localeTag(), { hour: "numeric", minute: "2-digit" });
}
function fmtHours(ms: number) {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDate(d: Date) {
  return d.toLocaleDateString(localeTag(), { weekday: "short", month: "short", day: "numeric" });
}
function fmtDT(s: string) {
  return new Date(s).toLocaleString(localeTag(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
const KIND_LABEL: Record<string, string> = {
  in: "Clock in",
  out: "Clock out",
  break_start: "Break start",
  break_end: "Break end",
};

/** One side of an audit entry: "Break start 12:00 PM, Sep 30 (30 min)". */
function auditPunch(p: { kind: string; at: string; break_minutes?: number | null }) {
  const len = p.break_minutes ? ` ${translate("({n} min)", { n: p.break_minutes })}` : "";
  return `${KIND_LABEL[p.kind] ? translate(KIND_LABEL[p.kind]) : p.kind} · ${fmtDT(p.at)}${len}`;
}

function PunchCorrectionsPage() {
  const t = useT("time");
  const qc = useQueryClient();
  const { user, company, primaryRole, loading } = useAuth();
  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";
  const rules = useAppRules();
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date(), rules.week_start_day));
  const [selectedUser, setSelectedUser] = useState<string>("");
  const [editingDay, setEditingDay] = useState<Date | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  // Same week as the timecards, once the company's week-start day has loaded.
  useEffect(() => {
    setAnchor((a) => startOfWeek(a, rules.week_start_day));
  }, [rules.week_start_day]);

  // Realtime: live-refresh punches and audit log for this company.
  useEffect(() => {
    if (!company?.id) return;
    const ch = supabase
      .channel(`corrections:${company.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "time_punches",
          filter: `company_id=eq.${company.id}`,
        },
        () => qc.invalidateQueries({ queryKey: ["correct-punches"] }),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "time_punch_audit",
          filter: `company_id=eq.${company.id}`,
        },
        () => qc.invalidateQueries({ queryKey: ["correct-audit"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [company?.id, qc]);

  const rangeStart = anchor;
  const rangeEnd = addDays(anchor, 7);

  const rosterQ = useQuery({
    queryKey: ["correct-roster", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", company!.id)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const targetUserId = selectedUser || rosterQ.data?.[0]?.id;

  const punchesQ = useQuery<Punch[]>({
    queryKey: ["correct-punches", targetUserId, rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select("id, user_id, kind, at, break_minutes")
        .eq("user_id", targetUserId!)
        // Past both ends of the week, so a shift is shown whole on the day it
        // was clocked in — the same reading as the timecards.
        .gte("at", new Date(rangeStart.getTime() - MAX_SHIFT_MS).toISOString())
        .lt("at", new Date(rangeEnd.getTime() + MAX_SHIFT_MS).toISOString())
        .order("at", { ascending: true });
      if (error) throw error;
      return punchesInPeriod((data ?? []) as Punch[], rangeStart, rangeEnd);
    },
  });

  const auditQ = useQuery<AuditRow[]>({
    queryKey: ["correct-audit", targetUserId],
    enabled: !!targetUserId && showAudit,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punch_audit")
        .select("*")
        .eq("user_id", targetUserId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
  });

  /** The week, day by day: that day's punches and what they add up to. */
  const weekDays = useMemo(() => {
    const byDay = groupByShiftDay(punchesQ.data ?? []);
    const totals = targetUserId
      ? totalsByPerson(punchesQ.data ?? [], rules.punch_round_minutes, rules.cap_break_to_length).get(
          targetUserId,
        )
      : undefined;
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(rangeStart, i);
      const key = date.toDateString();
      const detail = totals?.days.find((d) => d.key === key);
      return { date, punches: byDay.get(key) ?? [], detail };
    });
  }, [punchesQ.data, targetUserId, rangeStart, rules.punch_round_minutes, rules.cap_break_to_length]);
  const weekTotal = weekDays.reduce((n, d) => n + (d.detail?.workedMs ?? 0), 0);
  const rosterMap = useMemo(() => {
    const m = new Map<string, string>();
    (rosterQ.data ?? []).forEach((r: any) => m.set(r.id, r.full_name || t("Unnamed")));
    return m;
  }, [rosterQ.data, t]);

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  if (!company) return <div className="text-sm text-muted-foreground">{t("Join a company first.")}</div>;
  if (!isManager)
    return <div className="text-sm text-muted-foreground">{t("Manager access required.")}</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("Punch corrections")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Override or correct employee time punches. Every change is logged with your name, the time, and what the punch was before.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/timecards">
              <Clock className="mr-2 h-4 w-4" />
              {t("Timecards")}
            </Link>
          </Button>
          <Button
            variant={showAudit ? "default" : "outline"}
            size="sm"
            onClick={() => setShowAudit((v) => !v)}
          >
            <History className="mr-2 h-4 w-4" />
            {t("Audit log")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <select
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={targetUserId ?? ""}
          onChange={(e) => setSelectedUser(e.target.value)}
        >
          {(rosterQ.data ?? []).map((m: any) => (
            <option key={m.id} value={m.id}>
              {m.full_name || t("Unnamed")}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setAnchor((a) => addDays(a, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAnchor(startOfWeek(new Date(), rules.week_start_day))}
          >
            {t("This week")}
          </Button>
          <Button variant="outline" size="icon" onClick={() => setAnchor((a) => addDays(a, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>
          {t("Week of {start} – {end}", { start: fmtDate(rangeStart), end: fmtDate(addDays(rangeEnd, -1)) })}
        </span>
        <span>
          {t("Week total")}{" "}
          <span className="font-semibold tabular-nums text-foreground">{fmtHours(weekTotal)}</span>
        </span>
      </div>

      {/* One row per day. Edit opens the day as shifts — clock-in, clock-out,
          breaks — so a correction is typed the way the day was worked. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {weekDays.map(({ date, punches, detail }) => {
          const today = date.toDateString() === new Date().toDateString();
          return (
            <div
              key={date.toISOString()}
              className="flex items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-0"
            >
              <div className={`w-28 shrink-0 font-medium ${today ? "text-primary" : "text-foreground"}`}>
                {fmtDate(date)}
              </div>
              <div className="min-w-0 flex-1 text-muted-foreground">
                {!detail || detail.spans.length === 0 ? (
                  <span>—</span>
                ) : (
                  detail.spans.map((s, i) => (
                    <div key={i} className="truncate">
                      <span className="text-foreground">
                        {fmtTime(s.inAt)} – {s.outAt ? fmtTime(s.outAt) : t("still in")}
                      </span>
                      {s.outAt && new Date(s.outAt).toDateString() !== date.toDateString() && (
                        <span className="text-xs"> {t("(next day)")}</span>
                      )}
                    </div>
                  ))
                )}
                {detail && (detail.unpaidMs > 0 || detail.paidMs > 0) && (
                  <div className="text-xs">
                    {[
                      detail.unpaidMs > 0 && t("{time} unpaid break", { time: fmtHours(detail.unpaidMs) }),
                      detail.paidMs > 0 && t("{time} paid break", { time: fmtHours(detail.paidMs) }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </div>
              <div className="w-16 shrink-0 text-right font-medium tabular-nums text-foreground">
                {detail && detail.workedMs > 0 ? fmtHours(detail.workedMs) : ""}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!targetUserId || punchesQ.isLoading}
                onClick={() => setEditingDay(date)}
                aria-label={t("Edit {date}", { date: fmtDate(date) })}
              >
                <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">{punches.length ? t("Edit") : t("Add time")}</span>
              </Button>
            </div>
          );
        })}
      </div>

      {showAudit && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Recent audit entries (last 50)")}
          </div>
          {(auditQ.data ?? []).length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground">{t("No audit entries yet.")}</div>
          )}
          {(auditQ.data ?? []).map((a) => (
            <div key={a.id} className="border-b border-border px-4 py-3 text-sm last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                    a.action === "create"
                      ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : a.action === "update"
                        ? "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300"
                  }`}
                >
                  {t(a.action.toUpperCase())}
                </span>
                <span className="text-xs text-muted-foreground">{fmtDT(a.created_at)}</span>
                <span className="text-xs text-muted-foreground">
                  {t("by {name}", { name: rosterMap.get(a.actor_id) ?? a.actor_id.slice(0, 8) })}
                </span>
              </div>
              {/* A note is optional, so the before/after below is often the
                  whole story. Say so rather than leaving a blank line. */}
              <div
                className={a.reason.trim() ? "mt-1 text-foreground" : "mt-1 text-muted-foreground"}
              >
                {a.reason.trim() || t("No note given")}
              </div>
              {(a.before || a.after) && (
                <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  {a.before && (
                    <div>
                      <span className="font-medium">{t("Before:")}</span>{" "}
                      {auditPunch(a.before)}
                    </div>
                  )}
                  {a.after && (
                    <div>
                      <span className="font-medium">{t("After:")}</span>{" "}
                      {auditPunch(a.after)}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editingDay && targetUserId && (
        <TimecardDayEditor
          open
          onOpenChange={(next) => !next && setEditingDay(null)}
          day={editingDay}
          employeeId={targetUserId}
          employeeName={rosterMap.get(targetUserId) ?? t("Employee")}
          punches={
            weekDays.find((d) => d.date.toDateString() === editingDay.toDateString())?.punches ?? []
          }
        />
      )}
    </div>
  );
}

