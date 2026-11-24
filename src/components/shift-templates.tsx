import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2, Users } from "lucide-react";
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
import { SHIFT_COLORS, shiftColorClass } from "@/lib/shift-colors";
import { localeTag, useT } from "@/lib/i18n";
import {
  shiftFromSource,
  sourceFromTemplate,
  templateDuration,
  timeToMinutes,
  type PasteSource,
  type TemplateRow,
} from "@/lib/paste-source";
import { errorMessage } from "@/lib/error-message";

/**
 * Saved shift times for the schedule builder. Tapping a template puts it in
 * the same paste mode as a copied shift: tap empty days to drop it, or apply
 * it to many people and days at once.
 */

type Position = { id: string; name: string };

export function fmtMinutes(min: number): string {
  const d = new Date(2000, 0, 1, 0, 0);
  d.setMinutes(min % 1440);
  return d.toLocaleTimeString(localeTag() ?? [], {
    hour: "numeric",
    minute: d.getMinutes() ? "2-digit" : undefined,
  });
}

export function sourceSummary(src: Pick<PasteSource, "startMinutes" | "durationMinutes">) {
  return `${fmtMinutes(src.startMinutes)}–${fmtMinutes(src.startMinutes + src.durationMinutes)}`;
}

function usePositions(companyId: string) {
  return useQuery({
    queryKey: ["positions-lite", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("id, name")
        .eq("company_id", companyId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Position[];
    },
  });
}

/* ------------------------------- the strip ------------------------------- */

export function ShiftTemplatesBar({
  companyId,
  activeTemplateId,
  onPick,
}: {
  companyId: string;
  activeTemplateId: string | null;
  /** A template tapped; `null` when the active one is tapped again. */
  onPick: (src: PasteSource | null) => void;
}) {
  const t = useT("schedule");
  const positions = usePositions(companyId);
  const [editing, setEditing] = useState<Partial<TemplateRow> | null>(null);

  const templatesQ = useQuery({
    queryKey: ["shift_templates", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_templates")
        .select("id, name, start_time, end_time, break_minutes, position_id, color")
        .eq("company_id", companyId)
        .order("start_time");
      if (error) throw error;
      return (data ?? []) as TemplateRow[];
    },
  });
  const templates = templatesQ.data ?? [];
  const positionName = (id: string | null) =>
    (id && positions.data?.find((p) => p.id === id)?.name) || "";

  function pick(tpl: TemplateRow) {
    if (tpl.id === activeTemplateId) return onPick(null);
    const src = sourceFromTemplate(tpl, positionName(tpl.position_id), "");
    src.label = `${tpl.name} · ${sourceSummary(src)}${src.position ? ` · ${src.position}` : ""}`;
    onPick(src);
  }

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{t("Shift templates")}</p>
          <p className="text-xs text-muted-foreground">
            {t("Tap one, then tap days to paste it — or give it to several people at once.")}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setEditing({ name: "", start_time: "08:00", end_time: "16:00", break_minutes: 0, color: "primary", position_id: null })
          }
        >
          <Plus className="mr-2 h-4 w-4" /> {t("New template")}
        </Button>
      </div>

      {templatesQ.isLoading ? (
        <p className="text-xs text-muted-foreground">{t("Loading…")}</p>
      ) : templates.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t("No templates yet. Save shift times you use a lot, like “Morning 8–4”.")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {templates.map((tpl) => {
            const active = tpl.id === activeTemplateId;
            const start = timeToMinutes(tpl.start_time);
            return (
              <div
                key={tpl.id}
                className={`inline-flex items-stretch overflow-hidden rounded-lg ${shiftColorClass(tpl.color)} ${active ? "ring-2 ring-foreground ring-offset-2 ring-offset-card" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => pick(tpl)}
                  aria-pressed={active}
                  title={active ? t("Tap again to stop pasting") : t("Tap to paste this template")}
                  className="px-3 py-1.5 text-left text-xs leading-tight"
                >
                  <span className="block font-semibold">{tpl.name}</span>
                  <span className="block opacity-90">
                    {fmtMinutes(start)}–{fmtMinutes(start + templateDuration(tpl))}
                    {tpl.position_id && positionName(tpl.position_id)
                      ? ` · ${positionName(tpl.position_id)}`
                      : ""}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(tpl)}
                  title={t("Edit template")}
                  aria-label={t("Edit template")}
                  className="border-l border-current/20 px-2 opacity-80 hover:opacity-100"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <TemplateDialog
        companyId={companyId}
        draft={editing}
        positions={positions.data ?? []}
        onClose={() => setEditing(null)}
        onDeleted={(id) => id === activeTemplateId && onPick(null)}
      />
    </div>
  );
}

/* ---------------------------- create / edit ----------------------------- */

function TemplateDialog({
  companyId,
  draft,
  positions,
  onClose,
  onDeleted,
}: {
  companyId: string;
  draft: Partial<TemplateRow> | null;
  positions: Position[];
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {draft && (
          <TemplateForm
            key={draft.id ?? "new"}
            companyId={companyId}
            draft={draft}
            positions={positions}
            onClose={onClose}
            onDeleted={onDeleted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TemplateForm({
  companyId,
  draft,
  positions,
  onClose,
  onDeleted,
}: {
  companyId: string;
  draft: Partial<TemplateRow>;
  positions: Position[];
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const t = useT("schedule");
  const qc = useQueryClient();
  const [name, setName] = useState(draft.name ?? "");
  const [start, setStart] = useState((draft.start_time ?? "08:00").slice(0, 5));
  const [end, setEnd] = useState((draft.end_time ?? "16:00").slice(0, 5));
  const [breakMin, setBreakMin] = useState(String(draft.break_minutes ?? 0));
  const [positionId, setPositionId] = useState(draft.position_id ?? "");
  const [color, setColor] = useState(draft.color ?? "primary");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error(t("Give the template a name."));
      if (start === end) throw new Error(t("Start and end can't be the same time."));
      const payload = {
        name: name.trim(),
        start_time: start,
        end_time: end,
        break_minutes: Math.max(0, Number(breakMin) || 0),
        position_id: positionId || null,
        color,
      };
      const { error } = draft.id
        ? await supabase.from("shift_templates").update(payload).eq("id", draft.id)
        : await supabase.from("shift_templates").insert({ company_id: companyId, ...payload });
      if (error) {
        if (error.code === "23505") throw new Error(t("There's already a template with that name."));
        throw error;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["shift_templates"] });
      onClose();
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!draft.id) return;
      const { error } = await supabase.from("shift_templates").delete().eq("id", draft.id);
      if (error) throw error;
    },
    onSuccess: () => {
      if (draft.id) onDeleted(draft.id);
      void qc.invalidateQueries({ queryKey: ["shift_templates"] });
      onClose();
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  });

  const overnight = timeToMinutes(end) < timeToMinutes(start);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{draft.id ? t("Edit template") : t("New shift template")}</DialogTitle>
        <DialogDescription>{t("Saved times you can tap to paste onto the schedule.")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tpl-name">{t("Name")}</Label>
          <Input
            id="tpl-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("e.g. Morning")}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-start">{t("Starts")}</Label>
            <Input id="tpl-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-end">{t("Ends")}</Label>
            <Input id="tpl-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-break">{t("Break (min)")}</Label>
            <Input
              id="tpl-break"
              type="number"
              min={0}
              value={breakMin}
              onChange={(e) => setBreakMin(e.target.value)}
            />
          </div>
        </div>
        {overnight && (
          <p className="text-xs text-muted-foreground">{t("Ends the next day.")}</p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="tpl-position">{t("Position")}</Label>
          <select
            id="tpl-position"
            value={positionId}
            onChange={(e) => setPositionId(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">{t("No position")}</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("Color")}</Label>
          <div className="flex flex-wrap gap-2">
            {SHIFT_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setColor(c.key)}
                title={c.label}
                aria-label={c.label}
                aria-pressed={color === c.key}
                className={`h-7 w-7 rounded-full ${c.swatch} ${color === c.key ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
              />
            ))}
          </div>
        </div>
        {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      </div>
      <DialogFooter className="flex-row justify-between sm:justify-between">
        <div>
          {draft.id && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              <Trash2 className="h-4 w-4" /> {t("Delete")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("Save")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/* --------------------------- apply to many ------------------------------- */

export function ApplyToManyDialog({
  open,
  onClose,
  source,
  companyId,
  members,
  days,
  hasShift,
  isOff,
}: {
  open: boolean;
  onClose: () => void;
  source: PasteSource | null;
  companyId: string;
  members: { id: string; full_name: string }[];
  /** The days on screen; the ones to fill are picked from these. */
  days: Date[];
  hasShift: (memberId: string, day: Date) => boolean;
  isOff: (memberId: string, day: Date) => boolean;
}) {
  return (
    <Dialog open={open && !!source} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {open && source && (
          <ApplyForm
            source={source}
            companyId={companyId}
            members={members}
            days={days}
            hasShift={hasShift}
            isOff={isOff}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApplyForm({
  source,
  companyId,
  members,
  days,
  hasShift,
  isOff,
  onClose,
}: {
  source: PasteSource;
  companyId: string;
  members: { id: string; full_name: string }[];
  days: Date[];
  hasShift: (memberId: string, day: Date) => boolean;
  isOff: (memberId: string, day: Date) => boolean;
  onClose: () => void;
}) {
  const t = useT("schedule");
  const qc = useQueryClient();
  const [people, setPeople] = useState<Set<string>>(new Set());
  // Weekdays are the usual starting point; weekends are a tap away.
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(days.map((d, i) => (d.getDay() === 0 || d.getDay() === 6 ? -1 : i)).filter((i) => i >= 0)),
  );
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const plan = useMemo(() => {
    let add = 0;
    let busy = 0;
    let off = 0;
    const rows: ReturnType<typeof shiftFromSource>[] = [];
    for (const id of people) {
      for (const i of picked) {
        const day = days[i];
        if (isOff(id, day)) off++;
        else if (hasShift(id, day)) busy++;
        else {
          add++;
          rows.push(shiftFromSource(source, companyId, id, day));
        }
      }
    }
    return { add, busy, off, rows };
  }, [people, picked, days, source, companyId, hasShift, isOff]);

  const apply = useMutation({
    mutationFn: async () => {
      for (let i = 0; i < plan.rows.length; i += 500) {
        const { error } = await supabase.from("shifts").insert(plan.rows.slice(i, i + 500));
        if (error) throw error;
      }
      return plan.rows.length;
    },
    onSuccess: (n) => {
      setErr(null);
      setDone(n === 1 ? t("Added 1 shift as a draft.") : t("Added {n} shifts as drafts.", { n }));
      void qc.invalidateQueries({ queryKey: ["shifts"] });
    },
    onError: (e: unknown) => setErr(errorMessage(e)),
  });

  const allPicked = members.length > 0 && people.size === members.length;
  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  if (done)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("Done")}</DialogTitle>
          <DialogDescription>{done}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("They're drafts until you press Publish.")}
        </p>
        <DialogFooter>
          <Button onClick={onClose}>{t("Close")}</Button>
        </DialogFooter>
      </>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Give this to several people")}</DialogTitle>
        <DialogDescription>{source.label}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("Days")}</Label>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPicked(new Set(days.map((_, i) => i)))}
              >
                {t("All days")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                {t("None")}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {days.map((d, i) => {
              const on = picked.has(i);
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked((p) => toggle(p, i))}
                  className={`min-w-12 rounded-md border px-2 py-1.5 text-center text-xs font-medium ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-accent"}`}
                >
                  <span className="block">
                    {d.toLocaleDateString(localeTag() ?? [], { weekday: "short" })}
                  </span>
                  <span className="block opacity-80">{d.getDate()}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("People ({n} picked)", { n: people.size })}</Label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPeople(allPicked ? new Set() : new Set(members.map((m) => m.id)))}
            >
              <Users className="mr-2 h-4 w-4" />
              {allPicked ? t("Clear all") : t("Select all ({n})", { n: members.length })}
            </Button>
          </div>
          <div className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {members.map((m) => (
              <label
                key={m.id}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)]"
                  checked={people.has(m.id)}
                  onChange={() => setPeople((p) => toggle(p, m.id))}
                />
                <span className="truncate">{m.full_name || t("(unnamed)")}</span>
              </label>
            ))}
          </div>
        </div>

        <div className={`rounded-md px-3 py-2 text-sm ${plan.add ? "bg-primary-soft text-foreground" : "bg-secondary text-muted-foreground"}`}>
          <p className="font-medium">
            {plan.add === 1 ? t("Adds 1 draft shift.") : t("Adds {n} draft shifts.", { n: plan.add })}
          </p>
          {(plan.busy > 0 || plan.off > 0) && (
            <p className="text-xs text-muted-foreground">
              {t("Skips {n} where the person is already scheduled or off that day.", {
                n: plan.busy + plan.off,
              })}
            </p>
          )}
        </div>
        {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button type="button" disabled={plan.add === 0 || apply.isPending} onClick={() => apply.mutate()}>
          {apply.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {plan.add === 1 ? t("Add 1 shift") : t("Add {n} shifts", { n: plan.add })}
        </Button>
      </DialogFooter>
    </>
  );
}
