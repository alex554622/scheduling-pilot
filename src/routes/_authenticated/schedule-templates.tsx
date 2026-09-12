import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Wand2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
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
import {
  describePattern,
  isWorkDay,
  monthPeriods,
  shiftTimes,
  toDayString,
  type TemplateTeam,
} from "@/lib/schedule-pattern";

/**
 * The template library: built-in rotations, the company's own, and the wizard
 * that turns one into a real schedule.
 *
 * Templates are one route to a schedule, not the route — the builder on
 * /schedule still works as it always did, and a schedule created here is an
 * ordinary schedule afterwards.
 */
export const Route = createFileRoute("/_authenticated/schedule-templates")({
  component: ScheduleTemplatesPage,
});

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  company_id: string | null;
  is_system_template: boolean;
  is_editable: boolean;
  schedule_view_type: string;
  pattern: boolean[];
  pattern_length: number;
  default_work_week_start: number;
}

interface TeamRow extends TemplateTeam {
  id: string;
  template_id: string;
}

const WEEK_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function patternOf(row: { pattern: unknown; pattern_length: number }): boolean[] {
  const raw = Array.isArray(row.pattern) ? (row.pattern as unknown[]) : [];
  const list = raw.map((v) => v === true);
  // A stored pattern shorter than its declared length is padded with off days
  // rather than silently repeating.
  while (list.length < row.pattern_length) list.push(false);
  return list.slice(0, row.pattern_length);
}

function ScheduleTemplatesPage() {
  const { company, primaryRole, user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = primaryRole === "company_admin" || primaryRole === "super_admin";

  const [preview, setPreview] = useState<TemplateRow | null>(null);
  const [useTemplate, setUseTemplate] = useState<TemplateRow | null>(null);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [copyPrompt, setCopyPrompt] = useState<TemplateRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: ["schedule-templates", company?.id],
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("schedule_templates")
        .select(
          "id, name, description, company_id, is_system_template, is_editable, schedule_view_type, pattern, pattern_length, default_work_week_start",
        )
        .order("is_system_template", { ascending: false })
        .order("name");
      if (e) throw e;
      return (data ?? []).map((t) => ({
        ...(t as unknown as TemplateRow),
        pattern: patternOf(t as unknown as TemplateRow),
      }));
    },
  });

  const teamsQ = useQuery({
    queryKey: ["schedule-template-teams", company?.id],
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("schedule_template_teams")
        .select("id, template_id, name, shift_start, shift_end, pattern_offset, sort_order")
        .order("sort_order");
      if (e) throw e;
      return (data ?? []) as unknown as TeamRow[];
    },
  });

  const teamsFor = (templateId: string) =>
    (teamsQ.data ?? []).filter((t) => t.template_id === templateId);

  /** Copy-on-edit: a built-in is duplicated into the company before anything changes. */
  const duplicate = useMutation({
    mutationFn: async ({ template, name }: { template: TemplateRow; name: string }) => {
      const { data, error: e } = await supabase
        .from("schedule_templates")
        .insert({
          name,
          description: template.description,
          owner_id: user?.id ?? null,
          company_id: company!.id,
          is_system_template: false,
          is_editable: true,
          schedule_view_type: template.schedule_view_type,
          pattern: template.pattern as never,
          pattern_length: template.pattern_length,
          default_work_week_start: template.default_work_week_start,
        })
        .select(
          "id, name, description, company_id, is_system_template, is_editable, schedule_view_type, pattern, pattern_length, default_work_week_start",
        )
        .single();
      if (e) throw e;
      const copy = { ...(data as unknown as TemplateRow), pattern: patternOf(data as never) };
      const teams = teamsFor(template.id);
      if (teams.length) {
        const { error: te } = await supabase.from("schedule_template_teams").insert(
          teams.map((t) => ({
            template_id: copy.id,
            name: t.name,
            shift_start: t.shift_start,
            shift_end: t.shift_end,
            pattern_offset: t.pattern_offset,
            sort_order: t.sort_order,
          })),
        );
        if (te) throw te;
      }
      return copy;
    },
    onSuccess: (copy) => {
      void qc.invalidateQueries({ queryKey: ["schedule-templates"] });
      void qc.invalidateQueries({ queryKey: ["schedule-template-teams"] });
      setCopyPrompt(null);
      setEditing(copy);
    },
    onError: (e: Error) => setError(e.message),
  });

  const createBlank = useMutation({
    mutationFn: async () => {
      const { data, error: e } = await supabase
        .from("schedule_templates")
        .insert({
          name: "New template",
          description: "",
          owner_id: user?.id ?? null,
          company_id: company!.id,
          is_system_template: false,
          is_editable: true,
          schedule_view_type: "monthly",
          pattern: [true, true, true, true, false, false, false] as never,
          pattern_length: 7,
          default_work_week_start: 0,
        })
        .select(
          "id, name, description, company_id, is_system_template, is_editable, schedule_view_type, pattern, pattern_length, default_work_week_start",
        )
        .single();
      if (e) throw e;
      const created = { ...(data as unknown as TemplateRow), pattern: patternOf(data as never) };
      const { error: te } = await supabase.from("schedule_template_teams").insert({
        template_id: created.id,
        name: "Team 1",
        shift_start: "08:00",
        shift_end: "17:00",
        pattern_offset: 0,
        sort_order: 1,
      });
      if (te) throw te;
      return created;
    },
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["schedule-templates"] });
      void qc.invalidateQueries({ queryKey: ["schedule-template-teams"] });
      setEditing(t);
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error: e } = await supabase.from("schedule_templates").delete().eq("id", id);
      if (e) throw e;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["schedule-templates"] }),
    onError: (e: Error) => setError(e.message),
  });

  if (!isAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        Only a company admin can manage schedule templates.
      </p>
    );
  }

  const all = templatesQ.data ?? [];
  const system = all.filter((t) => t.is_system_template);
  const mine = all.filter((t) => !t.is_system_template);

  const card = (t: TemplateRow) => {
    const teams = teamsFor(t.id);
    return (
      <section
        key={t.id}
        className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-card)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-foreground">
              {t.name}
              <span
                className={`rounded px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
                  t.is_system_template
                    ? "bg-primary-soft text-primary"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                {t.is_system_template ? "SYSTEM" : "CUSTOM"}
              </span>
            </h3>
            {t.description && (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t.description}</p>
            )}
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <li>
                {t.pattern_length}-day rotation · {describePattern(t.pattern)}
              </li>
              <li>
                {t.schedule_view_type === "monthly" ? "Monthly schedule" : t.schedule_view_type} ·{" "}
                {teams.length} team{teams.length === 1 ? "" : "s"}
              </li>
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPreview(t)}>
              <Eye className="mr-2 h-4 w-4" /> Preview
            </Button>
            <Button size="sm" onClick={() => setUseTemplate(t)}>
              <Wand2 className="mr-2 h-4 w-4" /> Use template
            </Button>
            {t.is_system_template ? (
              <Button variant="outline" size="sm" onClick={() => setCopyPrompt(t)}>
                <Copy className="mr-2 h-4 w-4" /> Customize
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditing(t)}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => duplicate.mutate({ template: t, name: `${t.name} (copy)` })}
                  disabled={duplicate.isPending}
                >
                  <Copy className="mr-2 h-4 w-4" /> Duplicate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Delete "${t.name}"? Schedules already created from it are kept.`))
                      remove.mutate(t.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        {teams.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {teams.map((team) => (
              <span
                key={team.id}
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground"
              >
                <span className="font-medium text-foreground">{team.name}</span>{" "}
                {team.shift_start.slice(0, 5)}–{team.shift_end.slice(0, 5)}
                {team.pattern_offset ? ` · starts day ${team.pattern_offset + 1}` : ""}
              </span>
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Schedule templates</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A rotation described once — the work/off cycle, the teams and their hours — then applied
            to any month. Templates are optional: you can still{" "}
            <Link to="/schedule" className="text-primary hover:underline">
              build a schedule from scratch
            </Link>
            .
          </p>
        </div>
        <Button onClick={() => createBlank.mutate()} disabled={createBlank.isPending || !company}>
          {createBlank.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Create new template
        </Button>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      {(templatesQ.isLoading || teamsQ.isLoading) && (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      )}

      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Built-in templates
        </h2>
        {system.map(card)}
        {!templatesQ.isLoading && system.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No built-in templates found. Run the schedule template migration in Supabase.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          My custom templates
        </h2>
        {mine.map(card)}
        {!templatesQ.isLoading && mine.length === 0 && (
          <p className="text-sm text-muted-foreground">
            None yet. Customize a built-in template, or create one from scratch.
          </p>
        )}
      </div>

      {preview && (
        <PreviewDialog
          template={preview}
          teams={teamsFor(preview.id)}
          onClose={() => setPreview(null)}
        />
      )}

      {copyPrompt && (
        <Dialog open onOpenChange={(o) => !o && setCopyPrompt(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Customize “{copyPrompt.name}”</DialogTitle>
              <DialogDescription>
                This is a built-in Scheduling Pilot template. To make changes, Scheduling Pilot will
                create a custom copy for your account. The built-in template stays as it is for
                everyone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCopyPrompt(null)}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  duplicate.mutate({
                    template: copyPrompt,
                    name: `${company?.name ?? "Custom"} ${copyPrompt.name}`,
                  })
                }
                disabled={duplicate.isPending}
              >
                {duplicate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create custom copy
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {editing && (
        <TemplateBuilder
          template={editing}
          teams={teamsFor(editing.id)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["schedule-templates"] });
            void qc.invalidateQueries({ queryKey: ["schedule-template-teams"] });
          }}
        />
      )}

      {useTemplate && company && (
        <UseTemplateWizard
          template={useTemplate}
          teams={teamsFor(useTemplate.id)}
          companyId={company.id}
          onClose={() => setUseTemplate(null)}
          onCreated={() => {
            setUseTemplate(null);
            void qc.invalidateQueries({ queryKey: ["shifts"] });
          }}
        />
      )}
    </div>
  );
}

/* --------------------------- month preview --------------------------- */

function MonthGrid({
  template,
  teams,
  anchor,
  year,
  month,
}: {
  template: TemplateRow;
  teams: TeamRow[];
  anchor: string;
  year: number;
  month: number;
}) {
  const periods = monthPeriods(year, month);
  return (
    <div className="space-y-4">
      {periods.map((p) => (
        <div key={p.label}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {p.label} · {p.days.length} days
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-center text-xs">
              <thead>
                <tr>
                  <th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                    Team
                  </th>
                  {p.days.map((d) => (
                    <th
                      key={d}
                      className="border-b border-border px-1 py-1 font-medium text-muted-foreground"
                    >
                      {Number(d.slice(-2))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teams.map((team) => (
                  <tr key={team.id}>
                    <td className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium text-foreground">
                      {team.name}
                      <span className="ml-1 font-normal text-muted-foreground">
                        {team.shift_start.slice(0, 5)}–{team.shift_end.slice(0, 5)}
                      </span>
                    </td>
                    {p.days.map((d) => {
                      const work = isWorkDay(template.pattern, anchor, d, team.pattern_offset);
                      return (
                        <td
                          key={d}
                          className={`border-b border-border px-1 py-1 ${
                            work
                              ? "bg-primary-soft font-semibold text-primary"
                              : "text-muted-foreground"
                          }`}
                        >
                          {work ? "W" : "O"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {teams.length === 0 && (
                  <tr>
                    <td
                      className="px-2 py-3 text-left text-muted-foreground"
                      colSpan={p.days.length + 1}
                    >
                      This template has no teams yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-primary">W</span> = work ·{" "}
        <span className="font-semibold">O</span> = off. The biweekly periods are a way of reading
        the month; the cycle itself runs unbroken from pattern day 1.
      </p>
    </div>
  );
}

function PreviewDialog({
  template,
  teams,
  onClose,
}: {
  template: TemplateRow;
  teams: TeamRow[];
  onClose: () => void;
}) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [anchor, setAnchor] = useState(
    toDayString(new Date(today.getFullYear(), today.getMonth(), 1)),
  );

  const step = (dir: -1 | 1) => {
    const d = new Date(year, month - 1 + dir, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{template.name} — preview</DialogTitle>
          <DialogDescription>
            {template.pattern_length}-day rotation · {describePattern(template.pattern)}. Nothing is
            created from a preview.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <Button variant="outline" size="sm" onClick={() => step(-1)}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous month
          </Button>
          <span className="min-w-40 text-center text-sm font-medium text-foreground">
            {MONTHS[month - 1]} {year}
          </span>
          <Button variant="outline" size="sm" onClick={() => step(1)}>
            Next month <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
          <div className="space-y-1.5">
            <Label htmlFor="preview-anchor">Pattern day 1</Label>
            <Input
              id="preview-anchor"
              type="date"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
              className="w-44"
            />
          </div>
        </div>

        <MonthGrid template={template} teams={teams} anchor={anchor} year={year} month={month} />

        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- template builder --------------------------- */

interface DraftTeam {
  id?: string;
  name: string;
  shift_start: string;
  shift_end: string;
  pattern_offset: number;
  sort_order: number;
}

function TemplateBuilder({
  template,
  teams,
  onClose,
  onSaved,
}: {
  template: TemplateRow;
  teams: TeamRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [viewType, setViewType] = useState(template.schedule_view_type);
  const [weekStart, setWeekStart] = useState(template.default_work_week_start);
  const [length, setLength] = useState(template.pattern_length);
  const [pattern, setPattern] = useState<boolean[]>(template.pattern);
  const [draftTeams, setDraftTeams] = useState<DraftTeam[]>(
    teams.map((t) => ({
      id: t.id,
      name: t.name,
      shift_start: t.shift_start.slice(0, 5),
      shift_end: t.shift_end.slice(0, 5),
      pattern_offset: t.pattern_offset,
      sort_order: t.sort_order,
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const resize = (next: number) => {
    const n = Math.max(1, Math.min(366, next || 1));
    setLength(n);
    setPattern((p) => {
      const copy = p.slice(0, n);
      while (copy.length < n) copy.push(false);
      return copy;
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const { error: e } = await supabase
        .from("schedule_templates")
        .update({
          name,
          description,
          schedule_view_type: viewType,
          default_work_week_start: weekStart,
          pattern: pattern as never,
          pattern_length: length,
        })
        .eq("id", template.id);
      if (e) throw e;

      // Teams are replaced wholesale: the list is short and this keeps removals,
      // renames and reordering in one round trip.
      const { error: de } = await supabase
        .from("schedule_template_teams")
        .delete()
        .eq("template_id", template.id);
      if (de) throw de;
      if (draftTeams.length) {
        const { error: ie } = await supabase.from("schedule_template_teams").insert(
          draftTeams.map((t, i) => ({
            template_id: template.id,
            name: t.name.trim() || `Team ${i + 1}`,
            shift_start: t.shift_start,
            shift_end: t.shift_end,
            pattern_offset: t.pattern_offset,
            sort_order: i + 1,
          })),
        );
        if (ie) throw ie;
      }
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit template</DialogTitle>
          <DialogDescription>
            Schedules already created from this template keep the settings they were made with.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">Template name</Label>
              <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-desc">Description</Label>
              <Input
                id="t-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="t-view">Schedule type</Label>
              <select
                id="t-view"
                value={viewType}
                onChange={(e) => setViewType(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="monthly">Monthly</option>
                <option value="biweekly">Biweekly</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-week">Work week starts on</Label>
              <select
                id="t-week"
                value={weekStart}
                onChange={(e) => setWeekStart(Number(e.target.value))}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {WEEK_DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-len">Pattern length (days)</Label>
              <Input
                id="t-len"
                type="number"
                min={1}
                max={366}
                value={length}
                onChange={(e) => resize(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Work pattern — click a day to switch it</Label>
            <div className="flex flex-wrap gap-1.5">
              {pattern.map((on, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPattern((p) => p.map((v, idx) => (idx === i ? !v : v)))}
                  className={`h-9 w-9 rounded-md text-xs font-semibold ${
                    on
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-muted-foreground"
                  }`}
                  title={`Cycle day ${i + 1}`}
                >
                  {on ? "W" : "O"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{describePattern(pattern)}</p>
          </div>

          <div className="space-y-2">
            <Label>Teams</Label>
            {draftTeams.map((t, i) => (
              <div
                key={i}
                className="grid items-end gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
              >
                <div className="space-y-1.5">
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={t.name}
                    onChange={(e) =>
                      setDraftTeams((list) =>
                        list.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Starts</Label>
                  <Input
                    type="time"
                    value={t.shift_start}
                    onChange={(e) =>
                      setDraftTeams((list) =>
                        list.map((x, idx) =>
                          idx === i ? { ...x, shift_start: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Ends</Label>
                  <Input
                    type="time"
                    value={t.shift_end}
                    onChange={(e) =>
                      setDraftTeams((list) =>
                        list.map((x, idx) => (idx === i ? { ...x, shift_end: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Starts on cycle day</Label>
                  <Input
                    type="number"
                    min={1}
                    max={length}
                    value={t.pattern_offset + 1}
                    onChange={(e) =>
                      setDraftTeams((list) =>
                        list.map((x, idx) =>
                          idx === i
                            ? {
                                ...x,
                                pattern_offset: Math.max(
                                  0,
                                  Math.min(length - 1, (Number(e.target.value) || 1) - 1),
                                ),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setDraftTeams((list) => list.filter((_, idx) => idx !== i))}
                  aria-label={`Remove ${t.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setDraftTeams((list) => [
                  ...list,
                  {
                    name: `Team ${list.length + 1}`,
                    shift_start: "08:00",
                    shift_end: "17:00",
                    pattern_offset: 0,
                    sort_order: list.length + 1,
                  },
                ])
              }
            >
              <Plus className="mr-2 h-4 w-4" /> Add team
            </Button>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- use template --------------------------- */

function UseTemplateWizard({
  template,
  teams,
  companyId,
  onClose,
  onCreated,
}: {
  template: TemplateRow;
  teams: TeamRow[];
  companyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const today = new Date();
  const [scheduleName, setScheduleName] = useState(
    `${template.name} — ${MONTHS[today.getMonth()]} ${today.getFullYear()}`,
  );
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [anchor, setAnchor] = useState(
    toDayString(new Date(today.getFullYear(), today.getMonth(), 1)),
  );
  const [weekStart, setWeekStart] = useState(template.default_work_week_start);
  // A team holds as many people as it needs — a patrol team is a sergeant, a
  // corporal, officers and dispatchers all working the same rotation.
  const [assignment, setAssignment] = useState<Record<string, string[]>>({});
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ shifts: number } | null>(null);

  const rosterQ = useQuery({
    queryKey: ["template-wizard-roster", companyId],
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", companyId)
        .order("full_name");
      if (e) throw e;
      return data ?? [];
    },
  });

  const days = useMemo(() => monthPeriods(year, month).flatMap((p) => p.days), [year, month]);

  /** The shifts this run would create — one per working day per team. */
  const plannedShifts = useMemo(() => {
    const rows: {
      company_id: string;
      employee_id: string | null;
      starts_at: string;
      ends_at: string;
      position: string;
      color: string;
      published: boolean;
    }[] = [];
    for (const team of teams) {
      // Nobody chosen leaves one open shift per day to fill in later; several
      // people get a shift each, since they all work the team's days and hours.
      const crew: (string | null)[] = assignment[team.id]?.length ? assignment[team.id] : [null];
      for (const day of days) {
        if (!isWorkDay(template.pattern, anchor, day, team.pattern_offset)) continue;
        const { starts, ends } = shiftTimes(
          day,
          team.shift_start.slice(0, 5),
          team.shift_end.slice(0, 5),
        );
        for (const person of crew) {
          rows.push({
            company_id: companyId,
            employee_id: person,
            starts_at: starts.toISOString(),
            ends_at: ends.toISOString(),
            position: team.name,
            color: "primary",
            published: false,
          });
        }
      }
    }
    return rows;
  }, [teams, days, template.pattern, anchor, assignment, companyId]);

  const create = useMutation({
    mutationFn: async () => {
      // The schedule keeps a copy of everything it was built from, so editing
      // the template later cannot rewrite a month that already exists.
      const { error: se } = await supabase.from("schedules").insert({
        company_id: companyId,
        name: scheduleName.trim() || template.name,
        starts_on: days[0],
        ends_on: days[days.length - 1],
        status: "draft",
        source_template_id: template.id,
        pattern_snapshot: {
          pattern: template.pattern,
          pattern_length: template.pattern_length,
        } as never,
        teams_snapshot: teams.map((t) => ({
          name: t.name,
          shift_start: t.shift_start,
          shift_end: t.shift_end,
          pattern_offset: t.pattern_offset,
          sort_order: t.sort_order,
        })) as never,
        work_week_start: weekStart,
        anchor_date: anchor,
        schedule_year: year,
      });
      if (se) throw se;

      for (let i = 0; i < plannedShifts.length; i += 500) {
        const { error: ie } = await supabase.from("shifts").insert(plannedShifts.slice(i, i + 500));
        if (ie) throw ie;
      }
      return plannedShifts.length;
    },
    onSuccess: (n) => setDone({ shifts: n }),
    onError: (e: Error) => setError(e.message),
  });

  const roster = rosterQ.data ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create schedule from template</DialogTitle>
          <DialogDescription>Template: {template.name}</DialogDescription>
        </DialogHeader>

        {done ? (
          <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">
            Created “{scheduleName}” with {done.shifts} draft shift{done.shifts === 1 ? "" : "s"}.
            Open the schedule to review and publish.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="w-name">Schedule name</Label>
                <Input
                  id="w-name"
                  value={scheduleName}
                  onChange={(e) => setScheduleName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="w-month">Start month</Label>
                  <select
                    id="w-month"
                    value={month}
                    onChange={(e) => setMonth(Number(e.target.value))}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {MONTHS.map((m, i) => (
                      <option key={m} value={i + 1}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="w-year">Year</Label>
                  <Input
                    id="w-year"
                    type="number"
                    min={2020}
                    max={2100}
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value) || today.getFullYear())}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="w-anchor">Pattern day 1</Label>
                <Input
                  id="w-anchor"
                  type="date"
                  value={anchor}
                  onChange={(e) => setAnchor(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The date cycle day 1 falls on. The rotation counts forward and backward from here
                  and never restarts.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-week">Work week starts on</Label>
                <select
                  id="w-week"
                  value={weekStart}
                  onChange={(e) => setWeekStart(Number(e.target.value))}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {WEEK_DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Affects how the month is displayed and totalled, not the rotation.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Who works each team (optional)</Label>
              <div className="grid gap-3 sm:grid-cols-2">
                {teams.map((team) => {
                  const picked = assignment[team.id] ?? [];
                  const allPicked = roster.length > 0 && picked.length === roster.length;
                  return (
                    <div key={team.id} className="rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {team.name}{" "}
                          <span className="font-normal text-muted-foreground">
                            {team.shift_start.slice(0, 5)}–{team.shift_end.slice(0, 5)}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {picked.length ? `${picked.length} on this team` : "Open shifts"}
                        </span>
                      </div>

                      <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
                        {roster.map((p) => (
                          <label
                            key={p.id}
                            className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border accent-primary"
                              checked={picked.includes(p.id)}
                              onChange={(e) =>
                                setAssignment((a) => {
                                  const current = a[team.id] ?? [];
                                  return {
                                    ...a,
                                    [team.id]: e.target.checked
                                      ? [...current, p.id]
                                      : current.filter((id) => id !== p.id),
                                  };
                                })
                              }
                            />
                            <span className="truncate">{p.full_name || "Unnamed"}</span>
                          </label>
                        ))}
                        {roster.length === 0 && (
                          <p className="text-xs text-muted-foreground">No employees yet.</p>
                        )}
                      </div>

                      {roster.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setAssignment((a) => ({
                              ...a,
                              [team.id]: allPicked ? [] : roster.map((p) => p.id),
                            }))
                          }
                          className="mt-2 text-xs font-medium text-primary hover:underline"
                        >
                          {allPicked ? "Clear all" : "Select everyone"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Everyone ticked gets their own shift on that team's working days. Leave a team empty
                to create open shifts and assign them on the schedule later.
              </p>
            </div>

            <Button variant="outline" size="sm" onClick={() => setShowPreview((s) => !s)}>
              <Eye className="mr-2 h-4 w-4" /> {showPreview ? "Hide preview" : "Preview"}
            </Button>

            {showPreview && (
              <MonthGrid
                template={template}
                teams={teams}
                anchor={anchor}
                year={year}
                month={month}
              />
            )}

            <p className="text-sm text-muted-foreground">
              This creates{" "}
              <span className="font-medium text-foreground">{plannedShifts.length}</span> draft
              shifts across {MONTHS[month - 1]} {year}.
            </p>

            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={onCreated}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => create.mutate()}
                disabled={create.isPending || plannedShifts.length === 0 || teams.length === 0}
              >
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create schedule
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
