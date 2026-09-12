import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Eraser, Loader2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fromDayString, toDayString, type DayString } from "@/lib/schedule-pattern";
import type { ScheduleSelection } from "@/lib/day-selection";

/**
 * Clearing part of a schedule: whole days, individual shifts, or everything on
 * screen. Only the shifts currently loaded can be erased, so a selection never
 * reaches past the period being looked at.
 */
function dayLabel(day: DayString): string {
  return fromDayString(day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function EraseSelectionBar({
  selection,
  shifts,
  scopeLabel = "this view",
  invalidateKeys = ["shifts", "sheet-shifts"],
}: {
  selection: ScheduleSelection;
  /** The shifts on screen; the only ones a selection can reach. */
  shifts: { id: string; starts_at: string }[];
  /** What "select everything" covers, in words: "this week", "August". */
  scopeLabel?: string;
  invalidateKeys?: string[];
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doomed = shifts.filter(
    (s) => selection.shifts.has(s.id) || selection.days.has(toDayString(new Date(s.starts_at))),
  );

  const erase = useMutation({
    mutationFn: async () => {
      const ids = doomed.map((s) => s.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { error: e } = await supabase
          .from("shifts")
          .delete()
          .in("id", ids.slice(i, i + 200));
        if (e) throw e;
      }
      return ids.length;
    },
    onSuccess: () => {
      for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: [key] });
      setConfirming(false);
      selection.clear();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!selection.active) return null;

  const days = [...selection.days].sort();
  const parts = [
    days.length ? `${days.length} day${days.length === 1 ? "" : "s"}` : null,
    selection.shifts.size
      ? `${selection.shifts.size} shift${selection.shifts.size === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-primary-soft px-4 py-2.5 text-sm">
        <span className="font-medium text-primary">{parts.join(" + ")} selected</span>
        <span className="text-primary/80">
          {doomed.length} shift{doomed.length === 1 ? "" : "s"} will be erased
          {days.length > 0 && ` · ${days.slice(0, 3).map(dayLabel).join(", ")}`}
          {days.length > 3 ? ` and ${days.length - 3} more days` : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => selection.selectShifts(shifts.map((s) => s.id))}
            disabled={shifts.length === 0 || doomed.length === shifts.length}
            title={`Select every shift in ${scopeLabel}`}
          >
            <CheckSquare className="mr-2 h-4 w-4" /> Select all of {scopeLabel}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            disabled={doomed.length === 0}
          >
            <Eraser className="mr-2 h-4 w-4" /> Erase selected
          </Button>
          <Button size="sm" variant="ghost" onClick={selection.clear}>
            <X className="mr-2 h-4 w-4" /> Cancel
          </Button>
        </div>
      </div>

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Erase {doomed.length} shift{doomed.length === 1 ? "" : "s"}?
              </DialogTitle>
              <DialogDescription>
                {days.length > 0
                  ? `Everything on ${days.map(dayLabel).join(", ")}, plus anything else picked, is deleted for everyone.`
                  : "The shifts you picked are deleted."}{" "}
                Published shifts go too, and this cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Keep them
              </Button>
              <Button
                variant="destructive"
                onClick={() => erase.mutate()}
                disabled={erase.isPending}
              >
                {erase.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Erase
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
