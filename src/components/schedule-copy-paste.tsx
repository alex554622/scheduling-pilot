import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Copy, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
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
import { addDays, fromDayString, type DayString } from "@/lib/schedule-pattern";
import {
  clipboardSpan,
  describeClipboard,
  dropDuplicates,
  encodeShifts,
  materialize,
  readClipboard,
  subscribeClipboard,
  writeClipboard,
  type ClipboardScope,
  type ScheduleClipboard,
  type SourceShift,
} from "@/lib/schedule-clipboard";

/**
 * Copy and paste a stretch of schedule, shared by the builder and the monthly
 * sheet so both behave the same way.
 *
 * A copy holds whatever is on screen — a day, a week, a month — or one
 * person's part of it. A paste drops it at a chosen date, optionally onto a
 * different person, and skips anything already there so pasting twice does not
 * double-book.
 */
export interface CopyPasteProps {
  companyId: string;
  /** First day of what is currently displayed. */
  rangeStart: DayString;
  rangeLabel: string;
  scope: ClipboardScope;
  /** Shifts currently displayed, which is what "copy" takes. */
  shifts: (SourceShift & { id?: string })[];
  members: { id: string; full_name: string }[];
  /** Query keys to refresh once a paste lands. */
  invalidateKeys?: string[];
  size?: "sm" | "default";
}

export function ScheduleCopyPaste({
  companyId,
  rangeStart,
  rangeLabel,
  scope,
  shifts,
  members,
  invalidateKeys = ["shifts", "sheet-shifts"],
  size = "sm",
}: CopyPasteProps) {
  const qc = useQueryClient();
  const [clip, setClip] = useState<ScheduleClipboard | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [who, setWho] = useState<string>("all");
  const [target, setTarget] = useState<DayString>(rangeStart);
  const [assignTo, setAssignTo] = useState<string>("keep");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setClip(readClipboard());
    return subscribeClipboard(() => setClip(readClipboard()));
  }, []);

  useEffect(() => setTarget(rangeStart), [rangeStart]);

  function doCopy() {
    const chosen = who === "all" ? shifts : shifts.filter((s) => s.employee_id === who);
    const label =
      who === "all"
        ? rangeLabel
        : `${members.find((m) => m.id === who)?.full_name ?? "One person"} · ${rangeLabel}`;
    writeClipboard({
      label,
      scope: who === "all" ? scope : "person",
      singleEmployee: who === "all" ? null : who,
      dayCount: 1,
      shifts: encodeShifts(chosen, rangeStart),
      copiedAt: Date.now(),
    });
    setCopyOpen(false);
  }

  const paste = useMutation({
    mutationFn: async () => {
      if (!clip) return 0;
      const rows = materialize(
        clip,
        target,
        companyId,
        assignTo === "keep" ? undefined : assignTo === "open" ? null : assignTo,
      );
      if (rows.length === 0) return 0;

      // What is already in the target window, so a second paste is a no-op.
      const from = fromDayString(target);
      const to = fromDayString(addDays(target, clipboardSpan(clip) + 1));
      const { data, error: e } = await supabase
        .from("shifts")
        .select("employee_id, position, color, starts_at, ends_at")
        .eq("company_id", companyId)
        .gte("starts_at", from.toISOString())
        .lt("starts_at", to.toISOString());
      if (e) throw e;

      const fresh = dropDuplicates(rows, (data ?? []) as SourceShift[]);
      for (let i = 0; i < fresh.length; i += 500) {
        const { error: ie } = await supabase.from("shifts").insert(fresh.slice(i, i + 500));
        if (ie) throw ie;
      }
      return fresh.length;
    },
    onSuccess: (n) => {
      setResult(
        n === 0
          ? "Everything on the clipboard is already on those days — nothing to add."
          : `Pasted ${n} shift${n === 1 ? "" : "s"} as drafts.`,
      );
      for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={() => {
          setWho("all");
          setCopyOpen(true);
        }}
        disabled={shifts.length === 0}
        title="Copy what is on screen"
      >
        <Copy className="mr-2 h-4 w-4" /> Copy
      </Button>
      <Button
        variant="outline"
        size={size}
        onClick={() => {
          setResult(null);
          setError(null);
          setAssignTo("keep");
          setTarget(rangeStart);
          setPasteOpen(true);
        }}
        disabled={!clip}
        title={describeClipboard(clip)}
      >
        <ClipboardPaste className="mr-2 h-4 w-4" /> Paste
      </Button>

      {copyOpen && (
        <Dialog open onOpenChange={(o) => !o && setCopyOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Copy {rangeLabel}</DialogTitle>
              <DialogDescription>
                Copies the shifts you can see. Paste them onto another day, week or month — here or
                on the other schedule screen.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="copy-who">What to copy</Label>
              <select
                id="copy-who"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="all">Everyone ({shifts.length} shifts)</option>
                {members.map((m) => {
                  const n = shifts.filter((s) => s.employee_id === m.id).length;
                  return (
                    <option key={m.id} value={m.id} disabled={n === 0}>
                      {m.full_name || "Unnamed"} ({n} shift{n === 1 ? "" : "s"})
                    </option>
                  );
                })}
              </select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCopyOpen(false)}>
                Cancel
              </Button>
              <Button onClick={doCopy}>Copy</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {pasteOpen && (
        <Dialog open onOpenChange={(o) => !o && setPasteOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Paste schedule</DialogTitle>
              <DialogDescription>{describeClipboard(clip)}</DialogDescription>
            </DialogHeader>

            {result ? (
              <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">{result}</p>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="paste-target">Starting on</Label>
                  <Input
                    id="paste-target"
                    type="date"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The copied days are laid down from here, keeping their order and times.
                    {clip
                      ? ` Covers ${clipboardSpan(clip)} day${clipboardSpan(clip) === 1 ? "" : "s"}.`
                      : ""}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="paste-who">Give these shifts to</Label>
                  <select
                    id="paste-who"
                    value={assignTo}
                    onChange={(e) => setAssignTo(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="keep">The same people as the copy</option>
                    <option value="open">Nobody — create open shifts</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name || "Unnamed"}
                      </option>
                    ))}
                  </select>
                </div>

                {error && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              {result ? (
                <Button onClick={() => setPasteOpen(false)}>Done</Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setPasteOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => paste.mutate()} disabled={paste.isPending || !clip}>
                    {paste.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Paste
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
