import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type EditablePunch = {
  id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  break_minutes: number | null;
};

const KIND_LABEL: Record<EditablePunch["kind"], string> = {
  in: "Clock in",
  out: "Clock out",
  break_start: "Break start",
  break_end: "Break end",
};

const BREAK_LENGTHS = [10, 30, 60] as const;

/** `datetime-local` wants local wall-clock time, not the ISO instant. */
function toLocalInput(value: string | Date): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A new punch defaults to 9am on the day being edited, not "now". */
function dayAtNine(day: Date): string {
  const d = new Date(day);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d);
}

/**
 * Correct one day of an employee's punches: retime them, retype them, change a
 * break's length, delete one, or add one that was never recorded.
 *
 * Everything goes through the `manager_*` RPCs rather than the table, because
 * those are what enforce the manager check and write the audit trail — a
 * timecard is a payroll record and edits to it have to be attributable.
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
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<EditablePunch["kind"]>("in");
  const [newAt, setNewAt] = useState(() => dayAtNine(day));
  const [newMinutes, setNewMinutes] = useState<number>(30);

  // Local edits, keyed by punch id, so a row can be changed and saved on its own.
  const [drafts, setDrafts] = useState<Record<string, { at: string; kind: EditablePunch["kind"]; minutes: number | null }>>({});

  function draftFor(p: EditablePunch) {
    return drafts[p.id] ?? { at: toLocalInput(p.at), kind: p.kind, minutes: p.break_minutes };
  }
  function setDraft(p: EditablePunch, patch: Partial<{ at: string; kind: EditablePunch["kind"]; minutes: number | null }>) {
    setDrafts((d) => ({ ...d, [p.id]: { ...draftFor(p), ...patch } }));
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["timecards"] });
    qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
    qc.invalidateQueries({ queryKey: ["correct-punches"] });
  }

  function requireReason(): string | null {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setError("Give a reason for the correction (at least 3 characters) — it goes on the audit trail.");
      return null;
    }
    return trimmed;
  }

  const saveMut = useMutation({
    mutationFn: async (p: EditablePunch) => {
      const why = requireReason();
      if (!why) throw new Error("__reason__");
      const d = draftFor(p);
      const isBreak = d.kind === "break_start" || d.kind === "break_end";
      // `_minutes` only exists once the break-length migration is pushed. Send it
      // only when a break's length actually changed, so ordinary time and kind
      // corrections keep working on an un-migrated database.
      const lengthChanged = isBreak && d.minutes != null && d.minutes !== p.break_minutes;
      const { error: rpcError } = await supabase.rpc("manager_update_punch", {
        _id: p.id,
        _at: new Date(d.at).toISOString(),
        _kind: d.kind,
        _reason: why,
        ...(lengthChanged ? { _minutes: d.minutes } : {}),
      });
      if (rpcError) throw rpcError;
    },
    onSuccess: (_r, p) => {
      setDrafts((d) => {
        const next = { ...d };
        delete next[p.id];
        return next;
      });
      setError(null);
      refresh();
    },
    onError: (e: Error) => {
      if (e.message !== "__reason__") setError(e.message);
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (p: EditablePunch) => {
      const why = requireReason();
      if (!why) throw new Error("__reason__");
      const { error: rpcError } = await supabase.rpc("manager_delete_punch", { _id: p.id, _reason: why });
      if (rpcError) throw rpcError;
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e: Error) => {
      if (e.message !== "__reason__") setError(e.message);
    },
  });

  const addMut = useMutation({
    mutationFn: async () => {
      const why = requireReason();
      if (!why) throw new Error("__reason__");
      const isBreak = newKind === "break_start" || newKind === "break_end";
      const { error: rpcError } = await supabase.rpc("manager_insert_punch", {
        _user_id: employeeId,
        _at: new Date(newAt).toISOString(),
        _kind: newKind,
        _reason: why,
        ...(isBreak ? { _minutes: newMinutes } : {}),
      });
      if (rpcError) throw rpcError;
    },
    onSuccess: () => {
      setAdding(false);
      setError(null);
      refresh();
    },
    onError: (e: Error) => {
      if (e.message !== "__reason__") setError(e.message);
    },
  });

  const busy = saveMut.isPending || deleteMut.isPending || addMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit punches — {employeeName}</DialogTitle>
          <DialogDescription>
            {day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="correction-reason">Reason for the correction</Label>
          <Input
            id="correction-reason"
            placeholder="e.g. Forgot to clock out — confirmed with supervisor"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Recorded against every change below and visible in the audit log.
          </p>
        </div>

        <div className="max-h-[45vh] space-y-2 overflow-y-auto">
          {punches.length === 0 && (
            <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
              No punches recorded for this day.
            </p>
          )}

          {punches.map((p) => {
            const d = draftFor(p);
            const dirty = d.at !== toLocalInput(p.at) || d.kind !== p.kind || d.minutes !== p.break_minutes;
            const isBreak = d.kind === "break_start" || d.kind === "break_end";
            return (
              <div key={p.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2.5">
                <div className="w-32 shrink-0 space-y-1">
                  <Label className="text-xs">Type</Label>
                  <select
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={d.kind}
                    onChange={(e) => setDraft(p, { kind: e.target.value as EditablePunch["kind"] })}
                  >
                    {(Object.keys(KIND_LABEL) as EditablePunch["kind"][]).map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </div>

                <div className="w-44 shrink-0 space-y-1">
                  <Label className="text-xs">Time</Label>
                  <Input
                    type="datetime-local"
                    className="h-9"
                    value={d.at}
                    onChange={(e) => setDraft(p, { at: e.target.value })}
                  />
                </div>

                {isBreak && (
                  <div className="w-28 shrink-0 space-y-1">
                    <Label className="text-xs">Break length</Label>
                    <select
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                      value={d.minutes ?? ""}
                      onChange={(e) => setDraft(p, { minutes: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">—</option>
                      {BREAK_LENGTHS.map((m) => (
                        <option key={m} value={m}>{m} min{m === 10 ? " (paid)" : ""}</option>
                      ))}
                    </select>
                  </div>
                )}

                <Button size="sm" disabled={!dirty || busy} onClick={() => saveMut.mutate(p)}>
                  {saveMut.isPending && saveMut.variables?.id === p.id && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() => deleteMut.mutate(p)}
                  aria-label="Delete punch"
                >
                  {deleteMut.isPending && deleteMut.variables?.id === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>

        {adding ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-primary/40 bg-primary-soft/40 p-2.5">
            <div className="w-32 shrink-0 space-y-1">
              <Label className="text-xs">Type</Label>
              <select
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as EditablePunch["kind"])}
              >
                {(Object.keys(KIND_LABEL) as EditablePunch["kind"][]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div className="w-44 shrink-0 space-y-1">
              <Label className="text-xs">Time</Label>
              <Input type="datetime-local" className="h-9" value={newAt} onChange={(e) => setNewAt(e.target.value)} />
            </div>
            {(newKind === "break_start" || newKind === "break_end") && (
              <div className="w-28 shrink-0 space-y-1">
                <Label className="text-xs">Break length</Label>
                <select
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={newMinutes}
                  onChange={(e) => setNewMinutes(Number(e.target.value))}
                >
                  {BREAK_LENGTHS.map((m) => (
                    <option key={m} value={m}>{m} min{m === 10 ? " (paid)" : ""}</option>
                  ))}
                </select>
              </div>
            )}
            <Button size="sm" disabled={busy} onClick={() => addMut.mutate()}>
              {addMut.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Add
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add a punch
          </Button>
        )}

        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
