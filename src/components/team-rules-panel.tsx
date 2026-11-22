import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  mergeRules,
  useDepartmentRules,
  useMyRuleDepartments,
  type EffectiveRules,
  type TeamRuleKey,
  type TeamRules,
} from "@/lib/team-rules";
import { useAppRules } from "@/lib/app-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import { Check, Clock, FileClock, Loader2, ShieldAlert, Users } from "lucide-react";

const BOOL_RULES: { key: TeamRuleKey; label: string; detail?: string }[] = [
  {
    key: "require_geofence",
    label: "Block punches outside the worksite radius",
    detail: "Off: punches go through from anywhere and the location is recorded.",
  },
  {
    key: "require_gps",
    label: "Require GPS to clock in",
    detail:
      "On: Clock IN waits until location is on, with no 7-day grace period. Clock OUT always works.",
  },
  {
    key: "allow_kiosk",
    label: "Allow the shared clock-in",
    detail:
      "Off: the shared clock-in tablet turns this team away; they clock in from their own phone.",
  },
  { key: "allow_break_10", label: "Allow 10-min break (paid)" },
  { key: "allow_break_30", label: "Allow 30-min break (unpaid)" },
  { key: "allow_break_60", label: "Allow 60-min break (unpaid)" },
];

const TIMESHEET_BOOLS: { key: TeamRuleKey; label: string; detail?: string }[] = [
  {
    key: "schedule_lateness",
    label: "Mark late clock-ins against the schedule",
    detail:
      "A clock-in after the shift start plus the grace period is marked late on the time clock and the timecard, and the admins and the team's supervisors are told.",
  },
  {
    key: "require_edit_note",
    label: "Require a note when someone edits this team's time",
    detail:
      "Admins and supervisors must say why when they add, change or delete a punch for this team.",
  },
];

const NUMBER_RULES: {
  key: TeamRuleKey;
  label: string;
  detail: string;
  max: number;
  /** What "Set for this team" starts at when the company has no number. */
  suggested: number;
  /** The rule switched off. */
  off: string;
}[] = [
  {
    key: "early_clock_in_minutes",
    label: "Earliest clock-in (minutes before the shift)",
    detail: "Only counts on a day the person has a published shift.",
    max: 720,
    suggested: 15,
    off: "No limit",
  },
];

const OVERTIME_RULES: { key: TeamRuleKey; label: string; max: number }[] = [
  { key: "daily_overtime_hours", label: "Overtime after (hours/day)", max: 24 },
  { key: "daily_double_time_hours", label: "Double time after (hours/day)", max: 24 },
  { key: "overtime_threshold_hours", label: "Overtime threshold (hours/week)", max: 168 },
];

const ROUNDING = [0, 5, 10, 15];

/**
 * Team rules: per-department overrides of the clock-in and timesheet App
 * rules. Admins see every team; a supervisor sees the teams they supervise as
 * a whole department. The database decides which (`my_rule_departments`) and
 * enforces the same on every write.
 */
export function TeamRulesPanel() {
  const t = useT("people");
  const { company, loading } = useAuth();
  const qc = useQueryClient();
  const companyRules = useAppRules();
  const companyEff = companyRules;
  const mineQ = useMyRuleDepartments();
  const teamsQ = useDepartmentRules();

  const deptsQ = useQuery({
    queryKey: ["departments", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, name")
        .eq("company_id", company!.id)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const editable = useMemo(() => {
    const ids = new Set(mineQ.data ?? []);
    return (deptsQ.data ?? []).filter((d) => ids.has(d.id));
  }, [deptsQ.data, mineQ.data]);

  const [deptId, setDeptId] = useState("");
  useEffect(() => {
    if (!editable.some((d) => d.id === deptId)) setDeptId(editable[0]?.id ?? "");
  }, [editable, deptId]);

  const stored = deptId ? (teamsQ.data?.get(deptId) ?? {}) : {};
  const [draft, setDraft] = useState<TeamRules>({});
  const storedSig = JSON.stringify(stored);
  useEffect(() => {
    setDraft(JSON.parse(storedSig) as TeamRules);
  }, [deptId, storedSig]);

  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function refresh() {
    qc.invalidateQueries({ queryKey: ["department-rules", company?.id] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const clean = Object.fromEntries(
        Object.entries(draft).filter(([, v]) => v !== null && v !== undefined),
      );
      const { error } = await supabase
        .from("department_rules")
        .upsert(
          { department_id: deptId, company_id: company!.id, rules: clean as never },
          { onConflict: "department_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      refresh();
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("department_rules")
        .delete()
        .eq("department_id", deptId);
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      setDraft({});
      refresh();
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  if (loading || mineQ.isLoading || deptsQ.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  }

  if (editable.length === 0) {
    return (
      <div className="max-w-xl rounded-xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-3 text-lg font-semibold text-foreground">
          {t("No teams to set rules for")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {(deptsQ.data ?? []).length === 0
            ? t("Team rules apply to departments. Add departments under Organization first.")
            : t("Only company admins, and supervisors of a whole department, can set team rules.")}
        </p>
      </div>
    );
  }

  const set = (k: TeamRuleKey, v: boolean | number | undefined) =>
    setDraft((d) => {
      const next = { ...d } as Record<string, unknown>;
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next as TeamRules;
    });
  const companyValue = (k: TeamRuleKey) => (companyEff as Record<string, unknown>)[k];
  const onOff = (v: unknown) => (v ? t("On") : t("Off"));
  const overrides = Object.keys(draft).length;
  const effective: EffectiveRules = mergeRules(companyRules, draft);

  const boolRow = (r: { key: TeamRuleKey; label: string; detail?: string }) => {
    const v = draft[r.key] as boolean | undefined;
    return (
      <div
        key={r.key}
        className="flex flex-col gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
      >
        <div>
          <div className="text-sm font-medium text-foreground">{t(r.label)}</div>
          {r.detail && <div className="text-xs text-muted-foreground">{t(r.detail)}</div>}
        </div>
        <select
          aria-label={t(r.label)}
          className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-sm"
          value={v === undefined ? "inherit" : v ? "on" : "off"}
          onChange={(e) =>
            set(r.key, e.target.value === "inherit" ? undefined : e.target.value === "on")
          }
        >
          <option value="inherit">
            {t("Company setting ({value})", { value: onOff(companyValue(r.key)) })}
          </option>
          <option value="on">{t("On for this team")}</option>
          <option value="off">{t("Off for this team")}</option>
        </select>
      </div>
    );
  };

  const numberInput = (key: TeamRuleKey, max: number, placeholder: string, label: string) => (
    <Input
      type="number"
      min={0}
      max={max}
      aria-label={label}
      placeholder={placeholder}
      value={(draft[key] as number | undefined) ?? ""}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === "") return set(key, undefined);
        const n = Number(raw);
        if (Number.isFinite(n)) set(key, Math.max(0, Math.min(max, n)));
      }}
    />
  );

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">{t("Team rules")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Clock-in and timesheet rules for one team. Anything you leave on the company setting follows the App rules.",
          )}
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <Label htmlFor="team-rules-dept" className="font-semibold text-foreground">
            {t("Team")}
          </Label>
        </div>
        <select
          id="team-rules-dept"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={deptId}
          onChange={(e) => setDeptId(e.target.value)}
        >
          {editable.map((d) => {
            const n = Object.keys(teamsQ.data?.get(d.id) ?? {}).length;
            return (
              <option key={d.id} value={d.id}>
                {n > 0
                  ? t("{name} — {n} own rules", { name: d.name, n })
                  : t("{name} — company rules", { name: d.name })}
              </option>
            );
          })}
        </select>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <Clock className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Clock-in rules")}</h3>
        </div>
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {NUMBER_RULES.map((r) => {
              const cv = companyValue(r.key) as number | null;
              const v = draft[r.key] as number | false | undefined;
              const mode = v === undefined ? "inherit" : v === false ? "off" : "custom";
              return (
                <div key={r.key} className="space-y-1.5">
                  <Label>{t(r.label)}</Label>
                  <select
                    aria-label={t(r.label)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={mode}
                    onChange={(e) =>
                      set(
                        r.key,
                        e.target.value === "inherit"
                          ? undefined
                          : e.target.value === "off"
                            ? false
                            : (cv ?? r.suggested),
                      )
                    }
                  >
                    <option value="inherit">
                      {t("Company setting ({value})", {
                        value: cv == null ? t(r.off) : t("{n} min", { n: cv }),
                      })}
                    </option>
                    <option value="custom">{t("Set for this team")}</option>
                    <option value="off">{t(r.off)}</option>
                  </select>
                  {mode === "custom" && numberInput(r.key, r.max, "", t(r.label))}
                  <p className="text-xs text-muted-foreground">{t(r.detail)}</p>
                </div>
              );
            })}
          </div>
          {BOOL_RULES.map(boolRow)}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <FileClock className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Timesheet rules")}</h3>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="team-rules-round">{t("Round punches to")}</Label>
            <select
              id="team-rules-round"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={
                draft.punch_round_minutes === undefined
                  ? "inherit"
                  : String(draft.punch_round_minutes)
              }
              onChange={(e) =>
                set(
                  "punch_round_minutes",
                  e.target.value === "inherit" ? undefined : Number(e.target.value),
                )
              }
            >
              <option value="inherit">
                {t("Company setting ({value})", {
                  value:
                    companyEff.punch_round_minutes > 0
                      ? t("{n} min", { n: companyEff.punch_round_minutes })
                      : t("No rounding"),
                })}
              </option>
              {ROUNDING.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t("No rounding") : t("Nearest {n} minutes", { n })}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">{t("Overtime")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                "Leave a field empty to use the company's number. 0 turns that rule off for this team.",
              )}
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              {OVERTIME_RULES.map((r) => (
                <div key={r.key} className="space-y-1.5">
                  <Label>{t(r.label)}</Label>
                  {numberInput(
                    r.key,
                    r.max,
                    t("Company: {n}", { n: companyValue(r.key) as number }),
                    t(r.label),
                  )}
                </div>
              ))}
            </div>
          </div>
          {TIMESHEET_BOOLS.map(boolRow)}
          {effective.schedule_lateness && (
            <div className="space-y-1.5">
              <Label>{t("Grace period before late (minutes)")}</Label>
              {numberInput(
                "late_grace_minutes",
                120,
                t("Company: {n}", { n: companyEff.late_grace_minutes }),
                t("Grace period before late (minutes)"),
              )}
            </div>
          )}
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        {t(
          "In effect for this team: breaks {breaks}; overtime after {daily}h a day and {weekly}h a week.",
          {
            breaks:
              [
                effective.allow_break_10 && "10",
                effective.allow_break_30 && "30",
                effective.allow_break_60 && "60",
              ]
                .filter(Boolean)
                .join(", ") || t("none"),
            daily: effective.daily_overtime_hours,
            weekly: effective.overtime_threshold_hours,
          },
        )}
      </p>

      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => clear.mutate()}
          disabled={clear.isPending || (overrides === 0 && Object.keys(stored).length === 0)}
        >
          {clear.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("Use company rules for this team")}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !deptId}>
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {saved && <Check className="h-4 w-4" />}
          {saved ? t("Saved") : t("Save team rules")}
        </Button>
      </div>
    </div>
  );
}
