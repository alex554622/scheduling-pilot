import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Check, Clock, FileClock, Calendar, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app-rules")({
  component: AppRulesPage,
});

type AppRules = {
  // Timecard rules
  overtime_threshold_hours: number; // weekly OT threshold
  /** Hours in one day before overtime. 0 = off. */
  daily_overtime_hours: number;
  /** Hours in one day before double time. 0 = off. */
  daily_double_time_hours: number;
  punch_round_minutes: number; // round punches to nearest N min (0 = off)
  workday_start_hour: number; // 0-23
  // Clock-in rules
  require_geofence: boolean;
  allow_break_10: boolean;
  allow_break_30: boolean;
  allow_break_60: boolean;
  /** Flag an employee who has worked this long with no break. 0 turns it off. */
  break_reminder_hours: number;
  /** Same, for a proper meal break (a 30 or 60). 0 turns it off. */
  lunch_reminder_hours: number;
  auto_clockout_hours: number; // 0 = off
  // Scheduling rules
  week_start_day: number; // 0=Sun..6=Sat
  allow_shift_trades: boolean;
  allow_time_off_requests: boolean;
  schedule_advance_notice_hours: number;
};

const DEFAULTS: AppRules = {
  overtime_threshold_hours: 40,
  daily_overtime_hours: 8,
  daily_double_time_hours: 12,
  punch_round_minutes: 0,
  workday_start_hour: 0,
  require_geofence: true,
  allow_break_10: true,
  allow_break_30: true,
  allow_break_60: true,
  break_reminder_hours: 2,
  lunch_reminder_hours: 5,
  auto_clockout_hours: 0,
  week_start_day: 0,
  allow_shift_trades: true,
  allow_time_off_requests: true,
  schedule_advance_notice_hours: 24,
};

function AppRulesPage() {
  const { primaryRole, company, loading } = useAuth();
  const qc = useQueryClient();
  const isAdmin = primaryRole === "company_admin" || primaryRole === "super_admin";

  const settingsQ = useQuery({
    queryKey: ["company-settings", company?.id],
    enabled: !!company?.id && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("settings")
        .eq("id", company!.id)
        .single();
      if (error) throw error;
      return { ...DEFAULTS, ...((data?.settings as Partial<AppRules>) ?? {}) } as AppRules;
    },
  });

  const [rules, setRules] = useState<AppRules>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQ.data) setRules(settingsQ.data);
  }, [settingsQ.data]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("companies")
        .update({ settings: rules as unknown as never })
        .eq("id", company!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      qc.invalidateQueries({ queryKey: ["company-settings", company?.id] });
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  if (!isAdmin) {
    return (
      <div className="max-w-xl rounded-xl border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-3 text-lg font-semibold text-foreground">Admin only</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Only company admins can manage app rules. Contact your administrator if you need a change.
        </p>
        <Link to="/dashboard" className="mt-4 inline-block text-sm text-primary underline">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const set = <K extends keyof AppRules>(k: K, v: AppRules[K]) =>
    setRules((r) => ({ ...r, [k]: v }));

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">App rules</h2>
        <p className="text-sm text-muted-foreground">
          Admin-only controls for timecards, clock-in behavior, and scheduling across{" "}
          {company?.name ?? "your company"}.
        </p>
      </div>

      {settingsQ.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading settings…</div>
      ) : (
        <>
          {/* Timecard rules */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center gap-2">
              <FileClock className="h-5 w-5 text-primary" />
              <h3 className="font-semibold text-foreground">Timecard rules</h3>
            </div>
            <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm font-medium text-foreground">Overtime</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Daily rules apply first; the weekly threshold then promotes whatever regular hours
                are left, so a long day is never counted twice. Any field set to 0 turns that rule
                off.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <Field label="Overtime after (hours/day)">
                  <Input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    value={rules.daily_overtime_hours}
                    onChange={(e) => set("daily_overtime_hours", Number(e.target.value))}
                  />
                </Field>
                <Field label="Double time after (hours/day)">
                  <Input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    value={rules.daily_double_time_hours}
                    onChange={(e) => set("daily_double_time_hours", Number(e.target.value))}
                  />
                </Field>
                <Field label="Overtime threshold (hours/week)">
                  <Input
                    type="number"
                    min={0}
                    max={168}
                    value={rules.overtime_threshold_hours}
                    onChange={(e) => set("overtime_threshold_hours", Number(e.target.value))}
                  />
                </Field>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Round punches (minutes)">
                <Input
                  type="number"
                  min={0}
                  max={30}
                  value={rules.punch_round_minutes}
                  onChange={(e) => set("punch_round_minutes", Number(e.target.value))}
                />
              </Field>
              <Field label="Workday start hour (0–23)">
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={rules.workday_start_hour}
                  onChange={(e) => set("workday_start_hour", Number(e.target.value))}
                />
              </Field>
            </div>
          </section>

          {/* Clock-in rules */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              <h3 className="font-semibold text-foreground">Clock-in rules</h3>
            </div>
            <div className="space-y-4">
              {/* Two ways to use the worksite location. Either way the punch
                  records where it happened; this only decides whether being
                  too far away stops the punch or is simply noted. */}
              <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
                <div className="text-sm font-medium text-foreground">Clock-in location</div>
                <div className="text-xs text-muted-foreground">
                  Every punch records where it was made. Only company admins can see those
                  locations.
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <ModeChoice
                    active={rules.require_geofence}
                    onClick={() => set("require_geofence", true)}
                    title="Block off-site punches"
                    detail="Staff have to be inside the worksite radius to clock in or out."
                  />
                  <ModeChoice
                    active={!rules.require_geofence}
                    onClick={() => set("require_geofence", false)}
                    title="Record location only"
                    detail="Punches go through from anywhere, and you see where each one was made."
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <ToggleRow
                  label="Allow 10-min break (paid)"
                  checked={rules.allow_break_10}
                  onChange={(v) => set("allow_break_10", v)}
                />
                <ToggleRow
                  label="Allow 30-min break (unpaid)"
                  checked={rules.allow_break_30}
                  onChange={(v) => set("allow_break_30", v)}
                />
                <ToggleRow
                  label="Allow 60-min break (unpaid)"
                  checked={rules.allow_break_60}
                  onChange={(v) => set("allow_break_60", v)}
                />
              </div>
              <Field label="Auto clock-out after (hours, 0 = off)">
                <Input
                  type="number"
                  min={0}
                  max={24}
                  value={rules.auto_clockout_hours}
                  onChange={(e) => set("auto_clockout_hours", Number(e.target.value))}
                />
              </Field>

              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm font-medium text-foreground">Break reminders</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Flags anyone on the dashboard who has been working this long without a break.
                  Taking one clears the flag; a manager can also dismiss it.
                </p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Remind about a break after (hours, 0 = off)">
                    <Input
                      type="number"
                      min={0}
                      max={12}
                      step={0.5}
                      value={rules.break_reminder_hours}
                      onChange={(e) => set("break_reminder_hours", Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Remind about lunch after (hours, 0 = off)">
                    <Input
                      type="number"
                      min={0}
                      max={12}
                      step={0.5}
                      value={rules.lunch_reminder_hours}
                      onChange={(e) => set("lunch_reminder_hours", Number(e.target.value))}
                    />
                  </Field>
                </div>
              </div>
            </div>
          </section>

          {/* Scheduling options */}
          <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              <h3 className="font-semibold text-foreground">Scheduling options</h3>
            </div>
            <div className="space-y-4">
              <Field label="Week starts on">
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={rules.week_start_day}
                  onChange={(e) => set("week_start_day", Number(e.target.value))}
                >
                  {[
                    "Sunday",
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                  ].map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Schedule advance notice (hours)">
                <Input
                  type="number"
                  min={0}
                  max={720}
                  value={rules.schedule_advance_notice_hours}
                  onChange={(e) => set("schedule_advance_notice_hours", Number(e.target.value))}
                />
              </Field>
              <ToggleRow
                label="Allow shift trades"
                description="Let employees request to swap shifts with each other."
                checked={rules.allow_shift_trades}
                onChange={(v) => set("allow_shift_trades", v)}
              />
              <ToggleRow
                label="Allow time-off requests"
                description="Let employees submit time-off requests for approval."
                checked={rules.allow_time_off_requests}
                onChange={(v) => set("allow_time_off_requests", v)}
              />
            </div>
          </section>

          {err && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => settingsQ.data && setRules(settingsQ.data)}>
              Reset
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {saved && <Check className="h-4 w-4" />}
              {saved ? "Saved" : "Save rules"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** One of two mutually exclusive settings, shown side by side with its reason. */
function ModeChoice({
  active,
  onClick,
  title,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
        active ? "border-primary bg-primary-soft" : "border-border bg-card hover:bg-accent"
      }`}
    >
      <div className={`text-sm font-medium ${active ? "text-primary" : "text-foreground"}`}>
        {title}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/30 px-3 py-2">
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
