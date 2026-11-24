import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useT } from "@/lib/i18n";
import { PAY_RULES_KEY, usePositionPayRules } from "@/lib/use-pay-rules";
import type { PositionPayRules } from "@/lib/pay-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/error-message";

const hhmm = (v: string) => v.slice(0, 5);

/**
 * Pay rules by position, under App rules. Each position can have paid meal
 * breaks and a shift differential window; people follow the rules of their
 * assigned position. Positions with nothing set follow the company rules.
 */
export function PositionPayRulesPanel() {
  const t = useT("people");
  const qc = useQueryClient();
  const { positions, missing, isLoading } = usePositionPayRules();
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (missing) {
    return (
      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h3 className="font-semibold text-foreground">{t("Pay rules by position")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Pay rules by position aren't set up on the database yet. Apply the position pay rules migration, then reload.",
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-1 flex items-center gap-2">
        <Briefcase className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">{t("Pay rules by position")}</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          "Paid lunch and a night differential for some positions only. People follow the rules of their assigned position; positions with nothing set follow the rules above.",
        )}
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : positions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          {t("No positions yet. Add positions under Organization first.")}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {positions.map((p) => (
            <PositionRow
              key={p.id}
              position={p}
              open={open === p.id}
              onToggle={() => setOpen((o) => (o === p.id ? null : p.id))}
              onChanged={() => qc.invalidateQueries({ queryKey: [PAY_RULES_KEY] })}
              onError={(e) => setErr(errorMessage(e))}
            />
          ))}
        </div>
      )}

      {err && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {err}
        </p>
      )}
    </section>
  );
}

function PositionRow({
  position,
  open,
  onToggle,
  onChanged,
  onError,
}: {
  position: PositionPayRules;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const t = useT("people");
  const [draft, setDraft] = useState(position);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(position), [position]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(position);
  const set = <K extends keyof PositionPayRules>(k: K, v: PositionPayRules[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("positions")
        .update({
          paid_meal_breaks: draft.paid_meal_breaks,
          diff_enabled: draft.diff_enabled,
          diff_label: draft.diff_label.trim() || "Night differential",
          diff_start: draft.diff_start,
          diff_end: draft.diff_end,
        })
        .eq("id", position.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onChanged();
    },
    onError,
  });

  const summary = [
    position.paid_meal_breaks && t("Paid lunch"),
    position.diff_enabled &&
      `${position.diff_label} ${hhmm(position.diff_start)}–${hhmm(position.diff_end)}`,
  ].filter(Boolean) as string[];

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground">{position.name}</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {summary.length ? summary.join(" · ") : t("Company rules")}
        </span>
      </button>

      {open && (
        <div className="space-y-3 bg-muted/20 px-3 pb-3 pt-1">
          <ToggleLine
            label={t("Paid meal breaks")}
            description={t(
              "30- and 60-minute breaks count as time worked, like the 10-minute break.",
            )}
            checked={draft.paid_meal_breaks}
            onChange={(v) => set("paid_meal_breaks", v)}
          />
          <ToggleLine
            label={t("Shift differential")}
            description={t(
              "Hours worked inside this window are marked on the time card. Breaks that aren't paid come off.",
            )}
            checked={draft.diff_enabled}
            onChange={(v) => set("diff_enabled", v)}
          />
          {draft.diff_enabled && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t("Shown on the card as")}</Label>
                <Input
                  value={draft.diff_label}
                  onChange={(e) => set("diff_label", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("From")}</Label>
                <Input
                  type="time"
                  value={hhmm(draft.diff_start)}
                  onChange={(e) => set("diff_start", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("To")}</Label>
                <Input
                  type="time"
                  value={hhmm(draft.diff_end)}
                  onChange={(e) => set("diff_end", e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button variant="outline" size="sm" onClick={() => setDraft(position)}>
                {t("Reset")}
              </Button>
            )}
            <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {saved && <Check className="h-4 w-4" />}
              {saved ? t("Saved") : t("Save")}
            </Button>
          </div>
        </div>
      )}
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
