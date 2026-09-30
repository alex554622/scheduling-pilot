import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Coffee, Loader2, LogIn, LogOut, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAppRules } from "@/lib/app-rules";
import {
  diffDay,
  newKey,
  resolveShift,
  shiftHours,
  toShifts,
  validateDay,
  type DraftBreak,
  type DraftShift,
} from "@/lib/shift-edit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type EditablePunch = {
  id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  break_minutes: number | null;
};

const BREAK_LENGTHS = [10, 30, 60] as const;

function fmtHours(ms: number) {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "HH:MM" now, for the "Now" buttons on today's card. */
function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A new 30-minute break, placed where one usually goes: after the last break,
 * or about three hours into the shift. Only a starting point to adjust.
 */
function suggestBreak(s: DraftShift, day: Date): DraftBreak {
  const r = resolveShift(s, day);
  const last = r.breaks[r.breaks.length - 1];
  const base = last?.endAt ?? last?.startAt ?? r.inAt;
  if (!base) return { key: newKey(), minutes: 30, start: "", end: "" };
  const start = new Date(base.getTime() + (last ? 2 : 3) * 3_600_000);
  if (r.outAt && start.getTime() + 30 * 60_000 > r.outAt.getTime()) {
    return { key: newKey(), minutes: 30, start: "", end: "" };
  }
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    key: newKey(),
    minutes: 30,
    start: hhmm(start),
    end: hhmm(new Date(start.getTime() + 30 * 60_000)),
  };
}

/**
 * Correct one day of an employee's time, shift by shift: a clock-in, a
 * clock-out and the breaks between, typed as times of day. A time earlier than
 * the clock-in is the next morning, so an overnight shift reads 20:00 – 02:00.
 *
 * Nothing is written until Save, and Save is held while anything on the day
 * doesn't add up. Every write still goes through the `manager_*` RPCs, which
 * enforce the manager check and keep the audit trail — a timecard is a payroll
 * record, and each change to it has to be attributable.
 */
export function TimecardDayEditor({
  open,
  onOpenChange,
  day,
  punches,
  employeeId,
  employeeName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  day: Date;
  punches: EditablePunch[];
  employeeId: string;
  employeeName: string;
}) {
  const qc = useQueryClient();
  const rules = useAppRules();
  const [shifts, setShifts] = useState<DraftShift[]>(() => toShifts(punches));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const changes = useMemo(() => diffDay(punches, shifts, day), [punches, shifts, day]);
  const problems = useMemo(() => validateDay(shifts, day), [shifts, day]);
  const dirty = changes.length > 0;

  // The punches can land after the dialog opens, or change under it (the
  // employee punching while it is up). Follow them until the manager edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Set after a failed save: take the reloaded punches whatever the draft says.
  const reloadRef = useRef(false);
  const punchSig = punches.map((p) => `${p.id}:${p.at}:${p.kind}:${p.break_minutes}`).join("|");
  useEffect(() => {
    if (!dirtyRef.current || reloadRef.current) {
      reloadRef.current = false;
      setShifts(toShifts(punches));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [punchSig]);

  const isToday = day.toDateString() === new Date().toDateString();

  function refresh() {
    qc.invalidateQueries({ queryKey: ["timecards"] });
    qc.invalidateQueries({ queryKey: ["timecards-all"] });
    qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
    qc.invalidateQueries({ queryKey: ["correct-punches"] });
    qc.invalidateQueries({ queryKey: ["correct-audit"] });
    qc.invalidateQueries({ queryKey: ["today-punches"] });
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const why = reason.trim();
      // One call per punch, in the order diffDay gives (deletes, updates,
      // inserts). Each is audited on its own; if one fails the rest stop and
      // the day is reloaded to show what did land.
      for (const c of changes) {
        const { error: e } =
          c.op === "delete"
            ? await supabase.rpc("manager_delete_punch", { _id: c.id, _reason: why })
            : c.op === "update"
              ? await supabase.rpc("manager_update_punch", {
                  _id: c.id,
                  _at: c.at,
                  _kind: c.kind,
                  _reason: why,
                  ...(c.minutes != null ? { _minutes: c.minutes } : {}),
                })
              : await supabase.rpc("manager_insert_punch", {
                  _user_id: employeeId,
                  _at: c.at,
                  _kind: c.kind,
                  _reason: why,
                  ...(c.minutes != null ? { _minutes: c.minutes } : {}),
                });
        if (e) throw e;
      }
    },
    onSuccess: () => {
      toast.success(`Saved ${employeeName}'s day`);
      refresh();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      setError(`${e.message} — some changes may not have been saved; the day has been reloaded.`);
      reloadRef.current = true;
      refresh();
    },
  });

  function close(next: boolean) {
    if (next) return onOpenChange(true);
    if (dirty && !saveMut.isPending && !window.confirm("Discard your changes to this day?")) return;
    onOpenChange(false);
  }

  const patchShift = (key: string, patch: Partial<DraftShift>) =>
    setShifts((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const patchBreak = (shiftKey: string, breakKey: string, patch: Partial<DraftBreak>) =>
    setShifts((all) =>
      all.map((s) =>
        s.key === shiftKey
          ? { ...s, breaks: s.breaks.map((b) => (b.key === breakKey ? { ...b, ...patch } : b)) }
          : s,
      ),
    );

  function addShift() {
    setShifts((all) => [
      ...all,
      all.length === 0
        ? { key: newKey(), inTime: "09:00", outTime: "17:00", breaks: [] }
        : { key: newKey(), inTime: all[all.length - 1].outTime, outTime: "", breaks: [] },
    ]);
  }

  const removed = changes.filter((c) => c.op === "delete").length;
  const dayTotal = shifts.reduce(
    (n, s) => n + shiftHours(resolveShift(s, day), rules.cap_break_to_length).workedMs,
    0,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit time — {employeeName}</DialogTitle>
          <DialogDescription>
            {day.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
            {" · "}
            A time earlier than the clock-in counts as the next morning.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {shifts.length === 0 && (
            <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
              No time recorded for this day.
            </p>
          )}

          {shifts.map((s, i) => {
            const r = resolveShift(s, day);
            const hours = shiftHours(r, rules.cap_break_to_length);
            const issues = problems.get(s.key) ?? [];
            const nextDay = (d: Date | null) => !!d && d.toDateString() !== day.toDateString();
            return (
              <div
                key={s.key}
                className={`rounded-xl border p-3 ${issues.length ? "border-destructive/50 bg-destructive/5" : "border-border bg-card"}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {shifts.length > 1 ? `Shift ${i + 1}` : "Shift"}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium tabular-nums text-foreground">
                      {hours.open ? (
                        <span className="text-amber-600 dark:text-amber-400">Still clocked in</span>
                      ) : (
                        `${fmtHours(hours.workedMs)} worked`
                      )}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive"
                      aria-label="Remove this shift"
                      title="Remove this shift"
                      onClick={() => setShifts((all) => all.filter((x) => x.key !== s.key))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <TimeField
                    label="Clock in"
                    icon={<LogIn className="h-3.5 w-3.5" />}
                    value={s.inTime}
                    onChange={(v) => patchShift(s.key, { inTime: v })}
                    onNow={isToday ? () => patchShift(s.key, { inTime: nowTime() }) : undefined}
                  />
                  <TimeField
                    label="Clock out"
                    icon={<LogOut className="h-3.5 w-3.5" />}
                    value={s.outTime}
                    onChange={(v) => patchShift(s.key, { outTime: v })}
                    onNow={isToday ? () => patchShift(s.key, { outTime: nowTime() }) : undefined}
                    onClear={s.outTime ? () => patchShift(s.key, { outTime: "" }) : undefined}
                    nextDay={nextDay(r.outAt)}
                    placeholder="Still clocked in"
                  />
                </div>

                <div className="mt-3 space-y-2">
                  {s.breaks.map((b, bi) => {
                    const rb = r.breaks[bi];
                    return (
                      <div
                        key={b.key}
                        className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-2"
                      >
                        <div className="w-28 space-y-1">
                          <Label className="flex items-center gap-1 text-xs">
                            <Coffee className="h-3.5 w-3.5" /> Break
                          </Label>
                          <select
                            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                            value={b.minutes ?? ""}
                            onChange={(e) =>
                              patchBreak(s.key, b.key, {
                                minutes: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                          >
                            {b.minutes == null && <option value="">—</option>}
                            {BREAK_LENGTHS.map((m) => (
                              <option key={m} value={m}>
                                {m} min{m === 10 ? " · paid" : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="min-w-[7.5rem] flex-1">
                          <TimeField
                            label="Start"
                            value={b.start}
                            onChange={(v) => patchBreak(s.key, b.key, { start: v })}
                            nextDay={nextDay(rb.startAt)}
                            compact
                          />
                        </div>
                        <div className="min-w-[7.5rem] flex-1">
                          <TimeField
                            label="End"
                            value={b.end}
                            onChange={(v) => patchBreak(s.key, b.key, { end: v })}
                            onNow={
                              isToday ? () => patchBreak(s.key, b.key, { end: nowTime() }) : undefined
                            }
                            nextDay={nextDay(rb.endAt)}
                            placeholder={s.outTime ? undefined : "On break"}
                            compact
                          />
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 text-muted-foreground hover:text-destructive"
                          aria-label="Remove this break"
                          title="Remove this break"
                          onClick={() =>
                            patchShift(s.key, { breaks: s.breaks.filter((x) => x.key !== b.key) })
                          }
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 text-xs"
                    onClick={() =>
                      patchShift(s.key, { breaks: [...s.breaks, suggestBreak(s, day)] })
                    }
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add break
                  </Button>
                </div>

                {(hours.unpaidMs > 0 || hours.paidMs > 0) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {hours.unpaidMs > 0 && `${fmtHours(hours.unpaidMs)} unpaid break`}
                    {hours.unpaidMs > 0 && hours.paidMs > 0 && " · "}
                    {hours.paidMs > 0 && `${fmtHours(hours.paidMs)} paid break`}
                  </p>
                )}
                {issues.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {issues.map((msg) => (
                      <li key={msg} className="flex items-start gap-1.5 text-xs text-destructive">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {msg}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={addShift}>
              <Plus className="mr-1.5 h-4 w-4" /> Add shift
            </Button>
            {shifts.length > 0 && (
              <span className="text-sm text-muted-foreground">
                Day total{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {fmtHours(dayTotal)}
                </span>
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="correction-reason">Note (optional)</Label>
            <Input
              id="correction-reason"
              placeholder="e.g. Forgot to clock out — confirmed with supervisor"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Every change is logged with your name, the time, and what it was before.
            </p>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {!dirty
              ? "No changes yet"
              : `${changes.length} change${changes.length === 1 ? "" : "s"}${removed ? ` · ${removed} punch${removed === 1 ? "" : "es"} removed` : ""}`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => close(false)} disabled={saveMut.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setError(null);
                saveMut.mutate();
              }}
              disabled={!dirty || problems.size > 0 || saveMut.isPending}
            >
              {saveMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TimeField({
  label,
  icon,
  value,
  onChange,
  onNow,
  onClear,
  nextDay,
  placeholder,
  compact,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  onNow?: () => void;
  onClear?: () => void;
  nextDay?: boolean;
  placeholder?: string;
  compact?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-1">
        <Label className={`flex items-center gap-1 ${compact ? "text-xs" : "text-xs font-medium"}`}>
          {icon}
          {label}
          {nextDay && (
            <span className="rounded bg-blue-100 px-1 text-[10px] font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
              next day
            </span>
          )}
        </Label>
        <div className="flex gap-1">
          {onNow && (
            <button
              type="button"
              onClick={onNow}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Now
            </button>
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] font-medium text-muted-foreground hover:text-destructive hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <Input
        type="time"
        className="h-9"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {!value && placeholder && (
        <p className="text-[11px] text-muted-foreground">{placeholder}</p>
      )}
    </div>
  );
}
