import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Wand2, CalendarRange, Loader2, Trash2, Send, AlertTriangle, CheckCircle2, UserX } from "lucide-react";

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type ScheduleRow = {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  status: string;
  published_at: string | null;
};

type TemplateRow = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  required_headcount: number;
};

type Rule = { enabled: boolean; weekdays: number[]; headcount: number };

type GenerateResult = { schedule_id: string; shifts_created: number; assigned: number; open: number };

/** Local YYYY-MM-DD — toISOString() would shift the date across the UTC boundary. */
function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday of the week containing d. */
function mondayOf(d: Date): Date {
  const x = new Date(d);
  const shift = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - shift);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Generating, publishing and discarding whole schedules.
 *
 * This used to be its own page next to the builder, which meant hopping between
 * two screens to do one job — generate a week, then fix it up. It lives under
 * the builder now; the parent handles the role and capability checks.
 */
export function ScheduleRunsPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [genOpen, setGenOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const schedulesQ = useQuery({
    queryKey: ["schedules", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("schedules")
        .select("id, name, starts_on, ends_on, status, published_at")
        .eq("company_id", companyId)
        .order("starts_on", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ScheduleRow[];
    },
  });

  // Per-schedule totals, fetched in one pass rather than a query per row.
  const countsQ = useQuery({
    queryKey: ["schedule-counts", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("schedule_id, employee_id")
        .eq("company_id", companyId)
        .not("schedule_id", "is", null);
      if (error) throw error;
      const map: Record<string, { total: number; open: number }> = {};
      for (const row of data ?? []) {
        const id = row.schedule_id as string;
        map[id] ??= { total: 0, open: 0 };
        map[id].total += 1;
        if (row.employee_id === null) map[id].open += 1;
      }
      return map;
    },
  });

  const publish = useMutation({
    mutationFn: async (id: string) => {
      // Setting the status is enough: a trigger releases the schedule's shifts
      // in the same transaction, so the two can't end up disagreeing.
      const { error } = await supabase.from("schedules").update({ status: "published" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["shifts"] });
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const discard = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("discard_schedule", { _schedule_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["schedule-counts"] });
      qc.invalidateQueries({ queryKey: ["shifts"] });
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });


  const rows = schedulesQ.data ?? [];
  const counts = countsQ.data ?? {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Generated schedules</h2>
          <p className="text-sm text-muted-foreground">
            Build coverage from your shift templates, then publish it to the team.
          </p>
        </div>
        <Button onClick={() => { setErr(null); setGenOpen(true); }}>
          <Wand2 className="mr-2 h-4 w-4" />Generate schedule
        </Button>
      </div>

      {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {schedulesQ.isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center">
            <CalendarRange className="mx-auto mb-2 h-6 w-6 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">No schedules yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Define shift templates under Organization, then generate your first schedule.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((s) => {
              const c = counts[s.id] ?? { total: 0, open: 0 };
              const isDraft = s.status === "draft";
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground">{s.name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        s.status === "published" ? "bg-success/15 text-success"
                        : s.status === "archived" ? "bg-secondary text-muted-foreground"
                        : "bg-primary-soft text-primary"}`}>
                        {s.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(s.starts_on + "T00:00:00").toLocaleDateString()} – {new Date(s.ends_on + "T00:00:00").toLocaleDateString()}
                      {" · "}{c.total} shift{c.total === 1 ? "" : "s"}
                      {c.open > 0 && (
                        <span className="ml-1 inline-flex items-center gap-1 font-medium text-warning-foreground">
                          <UserX className="h-3 w-3" />{c.open} open
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {isDraft && (
                      <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate(s.id)}>
                        {publish.isPending && publish.variables === s.id
                          ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          : <Send className="mr-2 h-3.5 w-3.5" />}
                        Publish
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={discard.isPending}
                      onClick={() => discard.mutate(s.id)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />Discard
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <GenerateDialog
        open={genOpen}
        companyId={companyId}
        onClose={() => setGenOpen(false)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["schedules"] });
          qc.invalidateQueries({ queryKey: ["schedule-counts"] });
          qc.invalidateQueries({ queryKey: ["shifts"] });
        }}
      />
    </div>
  );
}

function GenerateDialog({
  open, companyId, onClose, onDone,
}: {
  open: boolean; companyId: string; onClose: () => void; onDone: () => void;
}) {
  const monday = useMemo(() => mondayOf(new Date()), []);
  const [name, setName] = useState("");
  const [startsOn, setStartsOn] = useState(isoDate(monday));
  const [endsOn, setEndsOn] = useState(isoDate(addDays(monday, 13)));
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [respectAvailability, setRespectAvailability] = useState(true);
  const [allowOvertime, setAllowOvertime] = useState(false);
  const [pool, setPool] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: ["shift_templates", companyId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_templates")
        .select("id, name, start_time, end_time, required_headcount")
        .eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as TemplateRow[];
    },
  });

  const membersQ = useQuery({
    queryKey: ["active-members", companyId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id, full_name")
        .eq("company_id", companyId).eq("is_active", true).order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });

  // Memoised because the seeding effect below depends on it — a fresh `[]` on
  // every render would re-run that effect forever.
  const templates = useMemo(() => templatesQ.data ?? [], [templatesQ.data]);
  const members = membersQ.data ?? [];

  // Seed each template with Mon–Fri and its own headcount the first time it loads.
  useEffect(() => {
    if (!templates.length) return;
    setRules((prev) => {
      const next = { ...prev };
      for (const t of templates) {
        next[t.id] ??= { enabled: false, weekdays: [1, 2, 3, 4, 5], headcount: t.required_headcount };
      }
      return next;
    });
  }, [templates]);

  useEffect(() => {
    if (!open) { setResult(null); setErr(null); }
  }, [open]);

  const generate = useMutation({
    mutationFn: async () => {
      const payload = Object.entries(rules)
        .filter(([, r]) => r.enabled && r.weekdays.length > 0)
        .map(([template_id, r]) => ({ template_id, weekdays: r.weekdays, headcount: r.headcount }));
      if (payload.length === 0) throw new Error("Enable at least one template and pick its days.");

      const { data, error } = await supabase.rpc("generate_schedule", {
        _name: name.trim() || "Generated schedule",
        _starts_on: startsOn,
        _ends_on: endsOn,
        _rules: payload,
        _respect_availability: respectAvailability,
        _allow_overtime: allowOvertime,
        ...(pool.size > 0 ? { _employee_ids: [...pool] } : {}),
      });
      if (error) throw error;
      return data as unknown as GenerateResult;
    },
    onSuccess: (r) => { setResult(r); setErr(null); onDone(); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  function setRule(id: string, patch: Partial<Rule>) {
    setRules((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function toggleWeekday(id: string, day: number) {
    const cur = rules[id]?.weekdays ?? [];
    setRule(id, { weekdays: cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort() });
  }

  function quickRange(kind: "week" | "twoweek" | "month" | "quarter" | "year") {
    const start = mondayOf(new Date());
    const end =
      kind === "week" ? addDays(start, 6)
      : kind === "twoweek" ? addDays(start, 13)
      : kind === "month" ? addDays(start, 27)
      : kind === "quarter" ? addDays(start, 90)
      : addDays(start, 364);
    setStartsOn(isoDate(start));
    setEndsOn(isoDate(end));
  }

  const dayCount = Math.round(
    (new Date(endsOn + "T00:00:00").getTime() - new Date(startsOn + "T00:00:00").getTime()) / 86_400_000,
  ) + 1;

  const enabledCount = Object.values(rules).filter((r) => r.enabled && r.weekdays.length).length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate schedule</DialogTitle>
          <DialogDescription>
            Shifts are assigned to the least-loaded eligible person, skipping anyone on approved
            time off, already booked, or over their weekly cap. Slots nobody can cover are created
            as open shifts.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            <div className="rounded-xl border border-success/40 bg-success/10 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-success">
                <CheckCircle2 className="h-4 w-4" />Schedule created
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
                <div><dt className="text-xs text-muted-foreground">Shifts</dt><dd className="text-xl font-semibold text-foreground">{result.shifts_created}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Assigned</dt><dd className="text-xl font-semibold text-foreground">{result.assigned}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Open</dt><dd className={`text-xl font-semibold ${result.open > 0 ? "text-warning-foreground" : "text-foreground"}`}>{result.open}</dd></div>
              </dl>
            </div>
            {result.open > 0 && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-foreground" />
                {result.open} slot{result.open === 1 ? "" : "s"} could not be filled from the selected
                pool — those days are understaffed. They are saved as open shifts so you can assign
                them by hand or widen availability.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The schedule is a draft: nothing is visible to employees until you publish it.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResult(null)}>Generate another</Button>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="max-h-[55vh] space-y-4 overflow-y-auto py-2 pr-1">
              <div className="space-y-1.5">
                <Label htmlFor="sched-name">Name</Label>
                <Input id="sched-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. October coverage" />
              </div>

              <div>
                <Label className="text-xs text-muted-foreground">Quick range</Label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {([["week", "1 week"], ["twoweek", "2 weeks"], ["month", "4 weeks"], ["quarter", "3 months"], ["year", "Full year"]] as const).map(
                    ([k, label]) => (
                      <button key={k} type="button" onClick={() => quickRange(k)}
                        className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                        {label}
                      </button>
                    ),
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sd">Starts</Label>
                  <Input id="sd" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ed">Ends</Label>
                  <Input id="ed" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {dayCount > 0 ? `${dayCount} day${dayCount === 1 ? "" : "s"}` : "End date is before the start date"}
                {dayCount > 366 && " — the maximum is 366"}
              </p>

              <div>
                <Label>Templates to schedule</Label>
                {templates.length === 0 ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    No shift templates yet — create them under Organization → Shift templates.
                  </p>
                ) : (
                  <div className="mt-1.5 space-y-2">
                    {templates.map((t) => {
                      const r = rules[t.id] ?? { enabled: false, weekdays: [], headcount: t.required_headcount };
                      return (
                        <div key={t.id} className={`rounded-xl border p-3 ${r.enabled ? "border-primary bg-primary-soft/30" : "border-border"}`}>
                          <label className="flex cursor-pointer items-center gap-2">
                            <input type="checkbox" className="h-4 w-4" checked={r.enabled}
                              onChange={() => setRule(t.id, { enabled: !r.enabled })} />
                            <span className="text-sm font-medium text-foreground">{t.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)}
                            </span>
                          </label>

                          {r.enabled && (
                            <div className="mt-3 space-y-2 pl-6">
                              <div>
                                <span className="text-xs text-muted-foreground">Repeat on</span>
                                <div className="mt-1 flex gap-1">
                                  {DAY_LETTERS.map((letter, day) => (
                                    <button
                                      key={day}
                                      type="button"
                                      title={DAY_NAMES[day]}
                                      aria-label={DAY_NAMES[day]}
                                      aria-pressed={r.weekdays.includes(day)}
                                      onClick={() => toggleWeekday(t.id, day)}
                                      className={`h-7 w-7 rounded-md text-xs font-semibold ${
                                        r.weekdays.includes(day)
                                          ? "bg-primary text-primary-foreground"
                                          : "bg-secondary text-muted-foreground hover:text-foreground"}`}
                                    >
                                      {letter}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Label htmlFor={`hc-${t.id}`} className="text-xs text-muted-foreground">People per day</Label>
                                <Input id={`hc-${t.id}`} type="number" min={1} className="h-8 w-20"
                                  value={r.headcount}
                                  onChange={(e) => setRule(t.id, { headcount: Math.max(1, Number(e.target.value)) })} />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <Label>Who to schedule</Label>
                <p className="mb-1.5 text-xs text-muted-foreground">
                  {pool.size === 0 ? "Everyone active" : `${pool.size} selected`} — leave all unchecked to use the whole team.
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {members.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={pool.has(m.id)}
                        onChange={() => setPool((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                          return next;
                        })}
                      />
                      <span className="truncate text-foreground">{m.full_name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={respectAvailability}
                    onChange={(e) => setRespectAvailability(e.target.checked)} />
                  <span>
                    <span className="text-foreground">Respect stated availability</span>
                    <span className="block text-xs text-muted-foreground">
                      Skip people outside their declared hours. Anyone who hasn&rsquo;t set availability is always eligible.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={allowOvertime}
                    onChange={(e) => setAllowOvertime(e.target.checked)} />
                  <span>
                    <span className="text-foreground">Allow exceeding weekly hour caps</span>
                    <span className="block text-xs text-muted-foreground">
                      Fills more slots, but can push people past their maximum weekly hours.
                    </span>
                  </span>
                </label>
              </div>

              {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                disabled={generate.isPending || enabledCount === 0 || dayCount < 1 || dayCount > 366}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
                Generate
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
