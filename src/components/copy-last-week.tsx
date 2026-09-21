import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { addDays, fromDayString, toDayString, type DayString } from "@/lib/schedule-pattern";
import {
  dropDuplicates,
  encodeShifts,
  materialize,
  type ScheduleClipboard,
  type SourceShift,
} from "@/lib/schedule-clipboard";

/**
 * Last week, laid down again on this one — the job most weeks start with.
 *
 * Copy and Paste already do this, but as three steps: go back a week, copy,
 * come forward, paste. For the one move a scheduler makes every week that is
 * two steps too many, and the middle one — paging backwards to find the week
 * you meant — is where the wrong week gets copied.
 *
 * It uses the same encoding as the clipboard, so a 9:30 shift stays a 9:30
 * shift across a daylight-saving change and an overnight shift keeps its
 * length. It does not touch the clipboard itself: copying last week should
 * not quietly throw away whatever someone had copied on purpose.
 *
 * Everything lands as a draft. A copied week is a starting point, and it
 * reaches nobody until it is looked over and published — the same as a week
 * built by hand.
 *
 * Onto a week that already has shifts there is no safe default, so it asks.
 * "Like it is" means replace: this week becomes last week. But the obvious
 * alternative — lay last week on top — double-books everyone whose two weeks
 * differ, and on a real, fully scheduled week that is most of the roster. So
 * the button stays shut until someone has chosen which one they meant.
 */
export function CopyLastWeekButton({
  companyId,
  weekStart,
  disabled,
}: {
  companyId: string;
  /** The Monday of the week being built; last week is the seven days before it. */
  weekStart: Date;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Only asked when this week already has shifts; see the note above.
  const [mode, setMode] = useState<"replace" | "add" | null>(null);

  const target: DayString = toDayString(weekStart);
  const source: DayString = addDays(target, -7);

  // Both weeks are read when the dialog opens rather than taken from the grid,
  // because the grid shows whatever view is on screen — a day, a month — and
  // this is always exactly one week onto exactly the next.
  const previewQ = useQuery({
    queryKey: ["copy-last-week", companyId, target],
    enabled: open,
    // Always fresh: the whole point of the preview is an accurate count.
    staleTime: 0,
    queryFn: async () => {
      const read = async (from: DayString) => {
        const { data, error } = await supabase
          .from("shifts")
          .select("id, published, employee_id, position, color, starts_at, ends_at")
          .eq("company_id", companyId)
          .gte("starts_at", fromDayString(from).toISOString())
          .lt("starts_at", fromDayString(addDays(from, 7)).toISOString())
          .order("starts_at");
        if (error) throw error;
        return (data ?? []) as (SourceShift & { id: string; published: boolean })[];
      };
      const [lastWeek, thisWeek] = await Promise.all([read(source), read(target)]);

      const clip: ScheduleClipboard = {
        label: "last week",
        scope: "week",
        singleEmployee: null,
        dayCount: 7,
        shifts: encodeShifts(lastWeek, source),
        copiedAt: Date.now(),
      };
      const all = materialize(clip, target, companyId);
      return {
        lastWeek: lastWeek.length,
        existingIds: thisWeek.map((s) => s.id),
        existingPublished: thisWeek.filter((s) => s.published).length,
        // Replace lays the whole of last week down.
        replaceRows: all,
        // Add skips anything already there — same person, same post, same
        // start — so a second click on the same week adds nothing.
        addRows: dropDuplicates(all, thisWeek),
      };
    },
  });

  const copy = useMutation({
    mutationFn: async () => {
      const p = previewQ.data;
      if (!p) return 0;
      const replacing = mode === "replace" && p.existingIds.length > 0;
      const rows = replacing ? p.replaceRows : p.addRows;
      if (rows.length === 0) return 0;

      // In, then out. If the insert fails nothing has changed. Removing the old
      // week first would leave it empty on a failure halfway, and an empty
      // published week is a message to every employee on it.
      const { error: insErr } = await supabase.from("shifts").insert(rows);
      if (insErr) throw insErr;
      if (replacing) {
        const { error: delErr } = await supabase.from("shifts").delete().in("id", p.existingIds);
        if (delErr) {
          throw new Error(
            `Last week was copied, but this week's old shifts could not be removed: ${delErr.message}. Both are on the schedule now — clear the old ones by hand.`,
          );
        }
      }
      return rows.length;
    },
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ["shifts"] });
      void qc.invalidateQueries({ queryKey: ["copy-last-week"] });
      setOpen(false);
      toast.success(`Copied ${n} shift${n === 1 ? "" : "s"} from last week`, {
        description: "They are drafts — nobody sees them until you publish.",
      });
    },
  });

  // A failed copy, or the last choice made, should not linger into the next
  // time the dialog is opened.
  useEffect(() => {
    if (!open) {
      copy.reset();
      setMode(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fmt = (d: DayString) =>
    fromDayString(d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const p = previewQ.data;
  const occupied = (p?.existingIds.length ?? 0) > 0;
  const toAdd = !p ? 0 : occupied && mode === "replace" ? p.replaceRows.length : p.addRows.length;
  // Onto an empty week there is nothing to choose; onto a full one there must be.
  const ready = !!p && p.lastWeek > 0 && (!occupied || mode !== null) && toAdd > 0;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Lay last week's shifts onto this week, as drafts"
      >
        <CalendarClock className="mr-2 h-4 w-4" />
        Copy last week
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy last week onto this one</DialogTitle>
            <DialogDescription>
              From the week of <span className="font-medium text-foreground">{fmt(source)}</span> to
              the week of <span className="font-medium text-foreground">{fmt(target)}</span> — same
              people, same days, same times.
            </DialogDescription>
          </DialogHeader>

          {previewQ.isLoading ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading both weeks…
            </p>
          ) : previewQ.error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {(previewQ.error as Error).message}
            </p>
          ) : !p || p.lastWeek === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              Last week has no shifts, so there is nothing to copy.
            </p>
          ) : !occupied ? (
            // The common case, and the easy one: an empty week gets last week.
            <p className="text-sm text-foreground">
              This week is empty. <span className="font-semibold">{p.lastWeek}</span> shift
              {p.lastWeek === 1 ? "" : "s"} will be laid onto it as drafts.
            </p>
          ) : (
            // A week that already has a schedule. What happens to it is the one
            // thing most likely to surprise, so it is chosen, not defaulted.
            <div className="space-y-3 text-sm">
              <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                This week already has {p.existingIds.length} shift
                {p.existingIds.length === 1 ? "" : "s"}
                {p.existingPublished > 0 ? `, ${p.existingPublished} of them published` : ""}.
                Choose what happens to them.
              </p>

              <ChoiceRow
                selected={mode === "replace"}
                onSelect={() => setMode("replace")}
                title="Replace this week with last week"
                detail={
                  <>
                    The {p.existingIds.length} shift{p.existingIds.length === 1 ? "" : "s"} on this
                    week are removed and last week's {p.replaceRows.length} take their place — this
                    week ends up exactly like last week.
                    {p.existingPublished > 0 && (
                      <span className="mt-1 block font-medium text-warning-foreground">
                        {p.existingPublished} of them are published, so the people on those shifts
                        are told a shift was removed.
                      </span>
                    )}
                  </>
                }
              />
              <ChoiceRow
                selected={mode === "add"}
                onSelect={() => setMode("add")}
                title="Add last week on top"
                detail={
                  p.addRows.length === 0 ? (
                    "Every one of last week's shifts is already on this week, so nothing would be added."
                  ) : (
                    <>
                      This week's shifts stay, and {p.addRows.length} from last week are added
                      beside them
                      {p.replaceRows.length - p.addRows.length > 0
                        ? ` (${p.replaceRows.length - p.addRows.length} exact repeats skipped)`
                        : ""}
                      . Anyone whose two weeks differ ends up with both.
                    </>
                  )
                }
              />
            </div>
          )}

          {copy.error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {(copy.error as Error).message}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={copy.isPending}>
              Cancel
            </Button>
            <Button onClick={() => copy.mutate()} disabled={!ready || copy.isPending}>
              {copy.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {/* Checked first: with nothing to copy there are no choices
                  either, and asking for one would point at an empty space. */}
              {!p || p.lastWeek === 0
                ? "Nothing to copy"
                : occupied && mode === null
                  ? "Choose one above"
                  : occupied && mode === "replace"
                    ? "Replace this week"
                    : `Copy ${toAdd > 0 ? `${toAdd} shift${toAdd === 1 ? "" : "s"}` : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One of the two answers, as a card you pick rather than a radio you squint at. */
function ChoiceRow({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        selected
          ? "border-primary bg-primary-soft/40 ring-1 ring-primary"
          : "border-border hover:bg-accent/50"
      }`}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </button>
  );
}
