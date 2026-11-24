import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  mergeRules,
  POSITION_RULES_KEY,
  usePositionRules,
  type EffectiveRules,
  type PositionRuleKey,
  type PositionRules,
} from "@/lib/team-rules";
import { useAppRules } from "@/lib/app-rules";
import { PAY_RULES_KEY, usePositionPayRules } from "@/lib/use-pay-rules";
import type { PositionPayRules } from "@/lib/pay-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import {
  Briefcase,
  Check,
  Clock,
  Coffee,
  Eye,
  FileClock,
  Loader2,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { errorMessage } from "@/lib/error-message";

type Row = { key: PositionRuleKey; label: string; detail?: string };

const CLOCK_BOOLS: Row[] = [
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
      "Off: the shared clock-in tablet turns this position away; they clock in from their own phone.",
  },
];

const BREAK_BOOLS: Row[] = [
  { key: "allow_break_10", label: "Allow 10-min break (paid)" },
  { key: "allow_break_30", label: "Allow 30-min break (unpaid)" },
  { key: "allow_break_60", label: "Allow 60-min break (unpaid)" },
  {
    key: "cap_break_to_length",
    label: "Record a break as the length picked",
    detail: "A 30 that ran 37 comes off the shift as 30. A break cut short is flagged either way.",
  },
];

const TIMESHEET_BOOLS: Row[] = [
  {
    key: "schedule_lateness",
    label: "Mark late clock-ins against the schedule",
    detail:
      "A clock-in after the shift start plus the grace period is marked late on the time clock and the timecard, and the admins and the person's supervisors are told.",
  },
  {
    key: "require_edit_note",
    label: "Require a note when someone edits this position's time",
    detail:
      "Admins and supervisors must say why when they add, change or delete a punch, or correct a meal break, for this position.",
  },
];

const VISIBILITY_BOOLS: Row[] = [
  {
    key: "staff_see_coworkers",
    label: "Employees can see their department on the dashboard",
    detail:
      "On: people in this position see who else in their department is working, on a break or due in today. Off: they see only themselves. Admins and supervisors always see their people.",
  },
];

const OVERTIME_RULES: { key: PositionRuleKey; label: string; max: number }[] = [
  { key: "daily_overtime_hours", label: "Overtime after (hours/day)", max: 24 },
  { key: "daily_double_time_hours", label: "Double time after (hours/day)", max: 24 },
  { key: "overtime_threshold_hours", label: "Overtime threshold (hours/week)", max: 168 },
];

const REMINDER_RULES: { key: PositionRuleKey; label: string; max: number }[] = [
  { key: "break_reminder_hours", label: "Flag no break after (hours)", max: 24 },
  { key: "lunch_reminder_hours", label: "Flag no meal break after (hours)", max: 24 },
];

const ROUNDING = [0, 5, 10, 15];
const hhmm = (v: string) => v.slice(0, 5);

/**
 * Position rules: every employment rule a position can set — clock-in limits,
 * breaks, rounding, overtime, lateness, pay (paid meals, a differential) and
 * the automatic meal break. Everyone holding the position follows them,
 * whatever their department. Company admins only; the database refuses anyone
 * else (`can_manage_position_rules`).
 */
export function PositionRulesPanel() {
  const t = useT("people");
  const { company, loading } = useAuth();
  const qc = useQueryClient();
  const companyRules = useAppRules();
  const rulesQ = usePositionRules();
  const pay = usePositionPayRules();

  const positions = useMemo(
    () => [...pay.positions].sort((a, b) => a.name.localeCompare(b.name)),
    [pay.positions],
  );
  const [positionId, setPositionId] = useState("");
  useEffect(() => {
    if (!positions.some((p) => p.id === positionId)) setPositionId(positions[0]?.id ?? "");
  }, [positions, positionId]);

  const stored = positionId ? (rulesQ.data?.get(positionId) ?? {}) : {};
  const storedSig = JSON.stringify(stored);
  const [draft, setDraft] = useState<PositionRules>({});
  useEffect(() => {
    setDraft(JSON.parse(storedSig) as PositionRules);
  }, [positionId, storedSig]);

  const storedPay = positions.find((p) => p.id === positionId) ?? null;
  const [payDraft, setPayDraft] = useState<PositionPayRules | null>(storedPay);
  const storedPaySig = JSON.stringify(storedPay);
  useEffect(() => {
    setPayDraft(JSON.parse(storedPaySig) as PositionPayRules | null);
  }, [storedPaySig]);

  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function refresh() {
    qc.invalidateQueries({ queryKey: [POSITION_RULES_KEY, company?.id] });
    qc.invalidateQueries({ queryKey: [PAY_RULES_KEY] });
  }

  const save = useMutation({
    mutationFn: async () => {
      const clean = Object.fromEntries(
        Object.entries(draft).filter(([, v]) => v !== null && v !== undefined),
      );
      const { error } = await supabase
        .from("position_rules")
        .upsert(
          { position_id: positionId, company_id: company!.id, rules: clean as never },
          { onConflict: "position_id" },
        );
      if (error) throw error;
      if (payDraft && JSON.stringify(payDraft) !== storedPaySig) {
        const { error: payErr } = await supabase
          .from("positions")
          .update({
            paid_meal_breaks: payDraft.paid_meal_breaks,
            diff_enabled: payDraft.diff_enabled,
            diff_label: payDraft.diff_label.trim() || "Night differential",
            diff_start: payDraft.diff_start,
            diff_end: payDraft.diff_end,
          })
          .eq("id", positionId);
        if (payErr) throw payErr;
      }
    },
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      refresh();
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("position_rules")
        .delete()
        .eq("position_id", positionId);
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      setDraft({});
      refresh();
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  });

  if (loading || pay.isLoading || rulesQ.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  }

  if (positions.length === 0) {
    return (
      <div className="max-w-xl rounded-xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-3 text-lg font-semibold text-foreground">
          {t("No positions to set rules for")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Employee position rules apply to positions. Add positions under Organization first.")}
        </p>
      </div>
    );
  }

  const set = (k: PositionRuleKey, v: boolean | number | undefined) =>
    setDraft((d) => {
      const next = { ...d } as Record<string, unknown>;
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next as PositionRules;
    });
  const setPay = <K extends keyof PositionPayRules>(k: K, v: PositionPayRules[K]) =>
    setPayDraft((d) => (d ? { ...d, [k]: v } : d));
  const companyEff = mergeRules(companyRules);
  const companyValue = (k: PositionRuleKey) => (companyEff as Record<string, unknown>)[k];
  const onOff = (v: unknown) => (v ? t("On") : t("Off"));
  const effective: EffectiveRules = mergeRules(companyRules, draft);
  const dirty = JSON.stringify(draft) !== storedSig || JSON.stringify(payDraft) !== storedPaySig;

  const boolRow = (r: Row) => {
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
          <option value="on">{t("On for this position")}</option>
          <option value="off">{t("Off for this position")}</option>
        </select>
      </div>
    );
  };

  const numberInput = (
    key: PositionRuleKey,
    max: number,
    placeholder: string,
    label: string,
    step?: number,
  ) => (
    <Input
      type="number"
      min={0}
      max={max}
      step={step}
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

  const early = draft.early_clock_in_minutes;
  const earlyMode = early === undefined ? "inherit" : early === false ? "off" : "custom";
  const mealMinutes = draft.auto_meal_minutes ?? 0;
  const mealMode =
    mealMinutes <= 0 ? "off" : mealMinutes === 30 ? "30" : mealMinutes === 60 ? "60" : "custom";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">{t("Employee position rules")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Employment rules for one position. Everyone with the position follows them, whatever their department. Anything left on the company setting follows the App rules.",
          )}
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-3 flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-primary" />
          <Label htmlFor="position-rules-pick" className="font-semibold text-foreground">
            {t("Position")}
          </Label>
        </div>
        <select
          id="position-rules-pick"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
        >
          {positions.map((p) => {
            const n = Object.keys(rulesQ.data?.get(p.id) ?? {}).length;
            return (
              <option key={p.id} value={p.id}>
                {n > 0
                  ? t("{name} — {n} own rules", { name: p.name, n })
                  : t("{name} — company rules", { name: p.name })}
                {p.is_active === false ? ` (${t("inactive")})` : ""}
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
          <div className="space-y-1.5">
            <Label>{t("Earliest clock-in (minutes before the shift)")}</Label>
            <select
              aria-label={t("Earliest clock-in (minutes before the shift)")}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={earlyMode}
              onChange={(e) =>
                set(
                  "early_clock_in_minutes",
                  e.target.value === "inherit"
                    ? undefined
                    : e.target.value === "off"
                      ? false
                      : (companyRules.early_clock_in_minutes ?? 15),
                )
              }
            >
              <option value="inherit">
                {t("Company setting ({value})", {
                  value:
                    companyRules.early_clock_in_minutes == null
                      ? t("No limit")
                      : t("{n} min", { n: companyRules.early_clock_in_minutes }),
                })}
              </option>
              <option value="custom">{t("Set for this position")}</option>
              <option value="off">{t("No limit")}</option>
            </select>
            {earlyMode === "custom" &&
              numberInput(
                "early_clock_in_minutes",
                720,
                "",
                t("Earliest clock-in (minutes before the shift)"),
              )}
            <p className="text-xs text-muted-foreground">
              {t("Only counts on a day the person has a published shift.")}
            </p>
          </div>
          {CLOCK_BOOLS.map(boolRow)}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <Coffee className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Breaks")}</h3>
        </div>
        <div className="space-y-3">
          {BREAK_BOOLS.map(boolRow)}
          {payDraft && (
            <ToggleLine
              label={t("Paid meal breaks")}
              description={t(
                "30- and 60-minute breaks count as time worked, like the 10-minute break.",
              )}
              checked={payDraft.paid_meal_breaks}
              onChange={(v) => setPay("paid_meal_breaks", v)}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {REMINDER_RULES.map((r) => (
              <div key={r.key} className="space-y-1.5">
                <Label>{t(r.label)}</Label>
                {numberInput(
                  r.key,
                  r.max,
                  t("Company: {n}", { n: companyValue(r.key) as number }),
                  t(r.label),
                  0.5,
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm font-medium text-foreground">{t("Automatic meal break")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                "Takes an unpaid meal break off each shift automatically, so people don't clock out and back in for it. A shift where a 30- or 60-minute break was punched is never charged twice. Employees can report a missed, short or interrupted meal break on their timecard; admins and supervisors can correct or remove it.",
              )}
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="auto-meal-mode">{t("Deduction")}</Label>
                <select
                  id="auto-meal-mode"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={mealMode}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "off") {
                      set("auto_meal_minutes", undefined);
                      set("auto_meal_after_hours", undefined);
                    } else {
                      set("auto_meal_minutes", v === "custom" ? 45 : Number(v));
                      if (draft.auto_meal_after_hours === undefined)
                        set("auto_meal_after_hours", 6);
                    }
                  }}
                >
                  <option value="off">{t("Off — employees punch their own meal break")}</option>
                  <option value="30">{t("30 minutes, unpaid")}</option>
                  <option value="60">{t("60 minutes, unpaid")}</option>
                  <option value="custom">{t("Custom length")}</option>
                </select>
              </div>
              {mealMode === "custom" && (
                <div className="space-y-1.5">
                  <Label>{t("Minutes")}</Label>
                  {numberInput("auto_meal_minutes", 180, "45", t("Minutes"))}
                </div>
              )}
              {mealMode !== "off" && (
                <div className="space-y-1.5">
                  <Label>{t("Only on shifts of at least (hours)")}</Label>
                  {numberInput(
                    "auto_meal_after_hours",
                    24,
                    "6",
                    t("Only on shifts of at least (hours)"),
                    0.5,
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <FileClock className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Timesheet rules")}</h3>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="position-rules-round">{t("Round punches to")}</Label>
            <select
              id="position-rules-round"
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
                    companyRules.punch_round_minutes > 0
                      ? t("{n} min", { n: companyRules.punch_round_minutes })
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
                "Leave a field empty to use the company's number. 0 turns that rule off for this position.",
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
                t("Company: {n}", { n: companyRules.late_grace_minutes }),
                t("Grace period before late (minutes)"),
              )}
            </div>
          )}
        </div>
      </section>

      {payDraft && (
        <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
          <div className="mb-4 flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">{t("Pay")}</h3>
          </div>
          <div className="space-y-3">
            <ToggleLine
              label={t("Shift differential")}
              description={t(
                "Hours worked inside this window are marked on the time card. Breaks that aren't paid come off.",
              )}
              checked={payDraft.diff_enabled}
              onChange={(v) => setPay("diff_enabled", v)}
            />
            {payDraft.diff_enabled && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>{t("Shown on the card as")}</Label>
                  <Input
                    value={payDraft.diff_label}
                    onChange={(e) => setPay("diff_label", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("From")}</Label>
                  <Input
                    type="time"
                    value={hhmm(payDraft.diff_start)}
                    onChange={(e) => setPay("diff_start", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("To")}</Label>
                  <Input
                    type="time"
                    value={hhmm(payDraft.diff_end)}
                    onChange={(e) => setPay("diff_end", e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <div className="mb-4 flex items-center gap-2">
          <Eye className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">{t("Who they can see")}</h3>
        </div>
        <div className="space-y-3">{VISIBILITY_BOOLS.map(boolRow)}</div>
      </section>

      <p className="text-xs text-muted-foreground">
        {t(
          "In effect for this position: breaks {breaks}; overtime after {daily}h a day and {weekly}h a week; automatic meal break {meal}.",
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
            meal:
              effective.auto_meal_minutes > 0
                ? t("{n} min on shifts of {h}h or more", {
                    n: effective.auto_meal_minutes,
                    h: effective.auto_meal_after_hours,
                  })
                : t("off"),
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
          disabled={clear.isPending || storedSig === "{}"}
        >
          {clear.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("Use company rules for this position")}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !positionId || !dirty}>
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {saved && <Check className="h-4 w-4" />}
          {saved ? t("Saved") : t("Save employee position rules")}
        </Button>
      </div>
    </div>
  );
}

function ToggleLine({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/30 px-3 py-2">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
