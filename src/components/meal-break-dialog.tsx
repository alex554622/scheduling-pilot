import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useT } from "@/lib/i18n";
import { errorMessage } from "@/lib/error-message";
import { translateRuleMessage } from "@/lib/team-rules";
import { MEAL_ADJUSTMENTS_KEY, type MealAdjustment } from "@/lib/use-meal-adjustments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type MealDialogTarget = {
  inPunchId: string;
  /** "Mon, Nov 23 · 8:00 AM – 4:30 PM", for the title. */
  shiftLabel: string;
  /** What the position's rule takes off this shift, in minutes (before any correction). */
  ruleMinutes: number;
  /** What actually came off, in minutes. */
  deductedMinutes: number;
  adjustment: MealAdjustment | undefined;
};

/**
 * The employee's side: report that this shift's automatic meal break was
 * missed, cut short or interrupted. Changes no hours; an admin or supervisor
 * reviews it.
 */
export function ReportMealDialog({
  target,
  onClose,
}: {
  target: MealDialogTarget | null;
  onClose: () => void;
}) {
  const t = useT("timecards");
  const qc = useQueryClient();
  const [kind, setKind] = useState<"missed" | "short" | "interrupted">("missed");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const a = target?.adjustment;
    setKind(a?.report_kind ?? "missed");
    setMinutes(
      a?.report_minutes != null && a.report_kind !== "missed" ? String(a.report_minutes) : "",
    );
    setNote(a?.report_note ?? "");
    setErr(null);
  }, [target]);

  const send = useMutation({
    mutationFn: async (withdraw: boolean) => {
      const { error } = await supabase.rpc("report_meal_break", {
        _in_punch: target!.inPunchId,
        _kind: withdraw ? null : kind,
        _minutes: withdraw || kind === "missed" ? null : Number(minutes),
        _note: withdraw ? null : note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [MEAL_ADJUSTMENTS_KEY] });
      onClose();
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  });

  const needsMinutes = kind !== "missed";
  const minutesOk = !needsMinutes || (minutes.trim() !== "" && Number(minutes) >= 0);
  const reported = !!target?.adjustment?.report_kind;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Report a meal break problem")}</DialogTitle>
          <DialogDescription>
            {target?.shiftLabel}
            {" · "}
            {t("{n} min was taken off automatically.", { n: target?.deductedMinutes ?? 0 })}{" "}
            {t("Your supervisor or an admin will review it.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="meal-report-kind">{t("What happened")}</Label>
            <select
              id="meal-report-kind"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="missed">{t("I didn't get a meal break")}</option>
              <option value="short">{t("My meal break was cut short")}</option>
              <option value="interrupted">{t("My meal break was interrupted")}</option>
            </select>
          </div>
          {needsMinutes && (
            <div className="space-y-1.5">
              <Label htmlFor="meal-report-minutes">{t("Minutes of meal break I got")}</Label>
              <Input
                id="meal-report-minutes"
                type="number"
                min={0}
                max={180}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="meal-report-note">{t("Note (optional)")}</Label>
            <Textarea
              id="meal-report-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {err && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          )}
        </div>
        <DialogFooter className="gap-2">
          {reported && (
            <Button variant="outline" onClick={() => send.mutate(true)} disabled={send.isPending}>
              {t("Withdraw report")}
            </Button>
          )}
          <Button onClick={() => send.mutate(false)} disabled={send.isPending || !minutesOk}>
            {send.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("Send report")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An admin's or supervisor's side: take a different amount off this shift,
 * remove the deduction, or go back to the position's rule. Recorded in the
 * audit log by the database.
 */
export function CorrectMealDialog({
  target,
  noteRequired,
  onClose,
}: {
  target: MealDialogTarget | null;
  noteRequired: boolean;
  onClose: () => void;
}) {
  const t = useT("timecards");
  const qc = useQueryClient();
  const [mode, setMode] = useState<"rule" | "remove" | "custom">("rule");
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = target?.adjustment?.deduct_minutes;
    setMode(d == null ? "rule" : d === 0 ? "remove" : "custom");
    setMinutes(d != null && d > 0 ? String(d) : "");
    setNote(target?.adjustment?.decision_note ?? "");
    setErr(null);
  }, [target]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("set_meal_deduction", {
        _in_punch: target!.inPunchId,
        _minutes: mode === "rule" ? null : mode === "remove" ? 0 : Number(minutes),
        _note: note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [MEAL_ADJUSTMENTS_KEY] });
      onClose();
    },
    onError: (e: unknown) => {
      const m = errorMessage(e);
      setErr(translateRuleMessage(m) ?? m);
    },
  });

  const report = target?.adjustment;
  const ok =
    (mode !== "custom" ||
      (minutes.trim() !== "" && Number(minutes) > 0 && Number(minutes) <= 180)) &&
    (!noteRequired || note.trim() !== "");

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Correct the meal break")}</DialogTitle>
          <DialogDescription>
            {target?.shiftLabel}
            {" · "}
            {target && target.ruleMinutes > 0
              ? t("The position's rule takes off {n} min.", { n: target.ruleMinutes })
              : t("The position's rule takes nothing off this shift.")}
          </DialogDescription>
        </DialogHeader>
        {report?.report_kind && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="font-medium">
              {report.report_kind === "missed"
                ? t("Employee reports: no meal break")
                : report.report_kind === "short"
                  ? t("Employee reports: cut short, {n} min taken", {
                      n: report.report_minutes ?? 0,
                    })
                  : t("Employee reports: interrupted, {n} min taken", {
                      n: report.report_minutes ?? 0,
                    })}
            </div>
            {report.report_note && <div className="mt-0.5 text-xs">{report.report_note}</div>}
          </div>
        )}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="meal-correct-mode">{t("Take off this shift")}</Label>
            <select
              id="meal-correct-mode"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="rule">{t("The position's rule")}</option>
              <option value="remove">{t("Nothing — remove the deduction")}</option>
              <option value="custom">{t("A different amount")}</option>
            </select>
          </div>
          {mode === "custom" && (
            <div className="space-y-1.5">
              <Label htmlFor="meal-correct-minutes">{t("Minutes")}</Label>
              <Input
                id="meal-correct-minutes"
                type="number"
                min={1}
                max={180}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="meal-correct-note">
              {noteRequired ? t("Note (required for this position)") : t("Note (optional)")}
            </Label>
            <Textarea
              id="meal-correct-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {err && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !ok}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
