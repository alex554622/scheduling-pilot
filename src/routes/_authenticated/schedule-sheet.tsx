import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarRange,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ScheduleCopyPaste } from "@/components/schedule-copy-paste";
import { EraseSelectionBar } from "@/components/erase-days";
import { useScheduleSelection } from "@/lib/day-selection";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fromDayString,
  monthDays,
  shiftTimes,
  toDayString,
  type DayString,
} from "@/lib/schedule-pattern";

/**
 * The posted duty roster: a month across the page, teams as banded sections,
 * an X on every day worked — the shape a department pins to the wall.
 *
 * It is a view of the real shifts, not a drawing of them. Clicking a cell
 * creates or deletes the shift behind it, so the time clock, timecards and
 * trades all see the same thing the sheet shows.
 */
export const Route = createFileRoute("/_authenticated/schedule-sheet")({
  component: ScheduleSheetPage,
});

interface ShiftRow {
  id: string;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string;
  color: string;
  published: boolean;
}

const WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
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

/** "19:00" from a stored timestamp, in the viewer's local time. */
function clock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface SheetSettings {
  sheet_title?: string;
  sheet_subtitle?: string;
  sheet_revised?: string;
  sheet_team_hours?: Record<string, { start: string; end: string }>;
}

function ScheduleSheetPage() {
  const { company, primaryRole } = useAuth();
  const qc = useQueryClient();
  const isAdmin = primaryRole === "company_admin" || primaryRole === "super_admin";
  const today = new Date();

  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [extraRows, setExtraRows] = useState<{ group: string; employeeId: string }[]>([]);
  const [extraGroups, setExtraGroups] = useState<string[]>([]);
  const [newGroup, setNewGroup] = useState("");
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  // Double-click a day column to start picking days to clear.
  const sel = useScheduleSelection();
  const [error, setError] = useState<string | null>(null);

  // Sheet headings and team hours live in the company's settings blob, which
  // App rules also writes — so every save merges rather than replaces.
  const settingsQ = useQuery({
    queryKey: ["company-settings-sheet", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("companies")
        .select("settings")
        .eq("id", company!.id)
        .single();
      if (e) throw e;
      return (data?.settings ?? {}) as Record<string, unknown>;
    },
  });

  const settings = (settingsQ.data ?? {}) as SheetSettings & Record<string, unknown>;

  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [revised, setRevised] = useState("");
  useEffect(() => {
    if (!settingsQ.data) return;
    setTitle(settings.sheet_title ?? company?.name ?? "");
    setSubtitle(settings.sheet_subtitle ?? "PATROL SCHEDULE");
    setRevised(settings.sheet_revised ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsQ.data]);

  const saveSettings = useMutation({
    mutationFn: async (patch: SheetSettings) => {
      const merged = { ...(settingsQ.data ?? {}), ...patch };
      const { error: e } = await supabase
        .from("companies")
        .update({ settings: merged as never })
        .eq("id", company!.id);
      if (e) throw e;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["company-settings-sheet"] }),
    onError: (e: Error) => setError(e.message),
  });

  const days = useMemo(() => monthDays(year, month), [year, month]);
  const rangeStart = days[0];
  const rangeEnd = days[days.length - 1];

  const shiftsQ = useQuery({
    queryKey: ["sheet-shifts", company?.id, rangeStart, rangeEnd],
    enabled: !!company?.id,
    queryFn: async () => {
      const from = fromDayString(rangeStart);
      const to = fromDayString(rangeEnd);
      to.setDate(to.getDate() + 1);
      const { data, error: e } = await supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at, position, color, published")
        .eq("company_id", company!.id)
        .gte("starts_at", from.toISOString())
        .lt("starts_at", to.toISOString())
        .order("starts_at");
      if (e) throw e;
      return (data ?? []) as ShiftRow[];
    },
  });

  const membersQ = useQuery({
    queryKey: ["sheet-members", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", company!.id)
        .order("full_name");
      if (e) throw e;
      return data ?? [];
    },
  });

  const members = membersQ.data ?? [];
  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.full_name ?? "Unknown") : "Open shift";

  /** One lookup for "does this person work this day on this team". */
  const byCell = useMemo(() => {
    const map = new Map<string, ShiftRow>();
    for (const s of shiftsQ.data ?? []) {
      const day = toDayString(new Date(s.starts_at));
      map.set(`${s.position}|${s.employee_id ?? "open"}|${day}`, s);
    }
    return map;
  }, [shiftsQ.data]);

  /** Teams, in the order they start: nights first, then days, as on paper. */
  const groups = useMemo(() => {
    const found = new Map<
      string,
      { name: string; start: string; end: string; people: Set<string> }
    >();
    for (const s of shiftsQ.data ?? []) {
      const key = s.position || "Unassigned";
      if (!found.has(key)) {
        found.set(key, {
          name: key,
          start: clock(s.starts_at),
          end: clock(s.ends_at),
          people: new Set(),
        });
      }
      found.get(key)!.people.add(s.employee_id ?? "open");
    }
    for (const g of extraGroups) {
      if (!found.has(g)) found.set(g, { name: g, start: "07:00", end: "19:00", people: new Set() });
    }
    for (const r of extraRows) {
      if (!found.has(r.group)) {
        found.set(r.group, { name: r.group, start: "07:00", end: "19:00", people: new Set() });
      }
      found.get(r.group)!.people.add(r.employeeId);
    }
    const hours = settings.sheet_team_hours ?? {};
    return [...found.values()]
      .map((g) => ({
        ...g,
        start: hours[g.name]?.start ?? g.start,
        end: hours[g.name]?.end ?? g.end,
        rows: [...g.people].sort((a, b) =>
          nameOf(a === "open" ? null : a).localeCompare(nameOf(b === "open" ? null : b)),
        ),
      }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftsQ.data, extraGroups, extraRows, members, settings.sheet_team_hours]);

  const toggle = useMutation({
    mutationFn: async (v: {
      group: string;
      employeeId: string;
      day: DayString;
      start: string;
      end: string;
    }) => {
      const key = `${v.group}|${v.employeeId}|${v.day}`;
      const existing = byCell.get(key);
      if (existing) {
        const { error: e } = await supabase.from("shifts").delete().eq("id", existing.id);
        if (e) throw e;
        return;
      }
      const { starts, ends } = shiftTimes(v.day, v.start, v.end);
      const { error: e } = await supabase.from("shifts").insert({
        company_id: company!.id,
        employee_id: v.employeeId === "open" ? null : v.employeeId,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        position: v.group,
        color: "primary",
        published: false,
      });
      if (e) throw e;
    },
    onSettled: () => {
      setBusyCell(null);
      void qc.invalidateQueries({ queryKey: ["sheet-shifts"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const renameGroup = useMutation({
    mutationFn: async (v: { from: string; to: string }) => {
      const { error: e } = await supabase
        .from("shifts")
        .update({ position: v.to })
        .eq("company_id", company!.id)
        .eq("position", v.from)
        .gte("starts_at", fromDayString(rangeStart).toISOString());
      if (e) throw e;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sheet-shifts"] }),
    onError: (e: Error) => setError(e.message),
  });

  const clearRow = useMutation({
    mutationFn: async (v: { group: string; employeeId: string }) => {
      const ids = (shiftsQ.data ?? [])
        .filter((s) => s.position === v.group && (s.employee_id ?? "open") === v.employeeId)
        .map((s) => s.id);
      if (ids.length) {
        const { error: e } = await supabase.from("shifts").delete().in("id", ids);
        if (e) throw e;
      }
      setExtraRows((rows) =>
        rows.filter((r) => !(r.group === v.group && r.employeeId === v.employeeId)),
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sheet-shifts"] }),
    onError: (e: Error) => setError(e.message),
  });

  async function downloadSheet() {
    setSavingPdf(true);
    try {
      const { downloadScheduleSheetPdf } = await import("@/lib/pdf");
      await downloadScheduleSheetPdf({
        title: title || company?.name || "Schedule",
        subtitle: `${MONTHS[month - 1]} ${year} ${subtitle}`.trim(),
        revised,
        monthLabel: `${MONTHS[month - 1]} ${year}`,
        days: days.map((d) => ({
          day: Number(d.slice(-2)),
          weekday: WEEKDAY[fromDayString(d).getDay()],
        })),
        groups: groups.map((g) => ({
          name: g.name,
          hours: `${g.start.replace(":", "")}-${g.end.replace(":", "")}`,
          rows: g.rows.map((personId) => ({
            name: nameOf(personId === "open" ? null : personId),
            marks: days.map((d) => byCell.has(`${g.name}|${personId}|${d}`)),
          })),
        })),
      });
    } finally {
      setSavingPdf(false);
    }
  }

  if (!isAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        Only a company admin can edit the schedule sheet.
      </p>
    );
  }

  const step = (dir: -1 | 1) => {
    const d = new Date(year, month - 1 + dir, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">Monthly schedule sheet</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The posted roster, laid out a month at a time. Click any square to put someone on or
            take them off that day — it changes the real shift, not just this page.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => step(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium text-foreground">
            {MONTHS[month - 1]} {year}
          </span>
          <Button variant="outline" size="sm" onClick={() => step(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {!sel.active && (
            <Button variant="outline" size="sm" onClick={sel.enable} title="Pick days to erase">
              <CheckSquare className="mr-2 h-4 w-4" />
              Select
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link to="/schedule-templates">
              <CalendarRange className="mr-2 h-4 w-4" />
              Templates
            </Link>
          </Button>
          <ScheduleCopyPaste
            companyId={company!.id}
            rangeStart={rangeStart}
            rangeLabel={`${MONTHS[month - 1]} ${year}`}
            scope="month"
            shifts={shiftsQ.data ?? []}
            members={members}
          />
          <Button onClick={() => void downloadSheet()} disabled={savingPdf || groups.length === 0}>
            {savingPdf ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download PDF
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="sheet-title">Heading</Label>
          <Input
            id="sheet-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => saveSettings.mutate({ sheet_title: title })}
            placeholder={company?.name ?? "Department name"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sheet-sub">Sub-heading</Label>
          <Input
            id="sheet-sub"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            onBlur={() => saveSettings.mutate({ sheet_subtitle: subtitle })}
            placeholder="PATROL SCHEDULE"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sheet-rev">Revised</Label>
          <Input
            id="sheet-rev"
            value={revised}
            onChange={(e) => setRevised(e.target.value)}
            onBlur={() => saveSettings.mutate({ sheet_revised: revised })}
            placeholder="07/08/2026"
          />
        </div>
      </div>

      {(shiftsQ.isLoading || membersQ.isLoading) && (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      )}

      <EraseSelectionBar
        selection={sel}
        shifts={shiftsQ.data ?? []}
        scopeLabel={`${MONTHS[month - 1]} ${year}`}
      />

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[900px] border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-border bg-muted/40 px-2 py-2 text-left font-semibold text-foreground">
                {MONTHS[month - 1].toUpperCase()} {year}
              </th>
              {days.map((d) => (
                <th
                  key={d}
                  className={`border-b border-l border-border bg-muted/40 p-0 font-semibold text-foreground ${sel.days.has(d) ? "bg-primary/20 ring-1 ring-inset ring-primary" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => sel.toggleDay(d)}
                    title="Click to pick this whole day"
                    className="w-full px-1 py-2"
                  >
                    {Number(d.slice(-2))}
                    <div className="text-[10px] font-normal text-muted-foreground">
                      {WEEKDAY[fromDayString(d).getDay()]}
                    </div>
                  </button>
                </th>
              ))}
              <th className="border-b border-l border-border bg-muted/40 px-1 py-2" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupSection
                key={g.name}
                group={g}
                days={days}
                byCell={byCell}
                nameOf={nameOf}
                members={members}
                busyCell={busyCell}
                onToggle={(employeeId, day) => {
                  setBusyCell(`${g.name}|${employeeId}|${day}`);
                  toggle.mutate({ group: g.name, employeeId, day, start: g.start, end: g.end });
                }}
                onHours={(start, end) =>
                  saveSettings.mutate({
                    sheet_team_hours: {
                      ...(settings.sheet_team_hours ?? {}),
                      [g.name]: { start, end },
                    },
                  })
                }
                onRename={(to) => {
                  if (!to.trim() || to === g.name) return;
                  setExtraGroups((list) => list.map((x) => (x === g.name ? to : x)));
                  setExtraRows((rows) =>
                    rows.map((r) => (r.group === g.name ? { ...r, group: to } : r)),
                  );
                  renameGroup.mutate({ from: g.name, to });
                }}
                onAddPerson={(employeeId) =>
                  setExtraRows((rows) =>
                    rows.some((r) => r.group === g.name && r.employeeId === employeeId)
                      ? rows
                      : [...rows, { group: g.name, employeeId }],
                  )
                }
                onRemovePerson={(employeeId) => {
                  if (
                    confirm(
                      `Remove ${nameOf(employeeId === "open" ? null : employeeId)} from ${g.name} for ${MONTHS[month - 1]}?`,
                    )
                  )
                    clearRow.mutate({ group: g.name, employeeId });
                }}
              />
            ))}
            {groups.length === 0 && !shiftsQ.isLoading && (
              <tr>
                <td
                  colSpan={days.length + 2}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No shifts this month yet. Add a team below, or build the month from a template.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-group">Add a team or unit</Label>
          <Input
            id="new-group"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            placeholder="e.g. TEAM #1"
            className="w-56"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            const name = newGroup.trim();
            if (!name) return;
            setExtraGroups((list) => (list.includes(name) ? list : [...list, name]));
            setNewGroup("");
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> Add team
        </Button>
        <p className="text-xs text-muted-foreground">
          A team stays once someone on it has a day ticked.
        </p>
      </div>
    </div>
  );
}

function GroupSection({
  group,
  days,
  byCell,
  nameOf,
  members,
  busyCell,
  onToggle,
  onHours,
  onRename,
  onAddPerson,
  onRemovePerson,
}: {
  group: { name: string; start: string; end: string; rows: string[] };
  days: DayString[];
  byCell: Map<string, ShiftRow>;
  nameOf: (id: string | null) => string;
  members: { id: string; full_name: string }[];
  busyCell: string | null;
  onToggle: (employeeId: string, day: DayString) => void;
  onHours: (start: string, end: string) => void;
  onRename: (to: string) => void;
  onAddPerson: (employeeId: string) => void;
  onRemovePerson: (employeeId: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [start, setStart] = useState(group.start);
  const [end, setEnd] = useState(group.end);
  useEffect(() => {
    setName(group.name);
    setStart(group.start);
    setEnd(group.end);
  }, [group.name, group.start, group.end]);

  return (
    <>
      <tr className="bg-secondary/60">
        <td className="sticky left-0 z-10 border-b border-border bg-secondary/60 px-2 py-1.5">
          <div className="flex items-center gap-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => onRename(name)}
              className="w-28 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-foreground hover:border-border focus:border-border focus:outline-none"
            />
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              onBlur={() => onHours(start, end)}
              className="w-20 rounded border border-transparent bg-transparent px-0.5 text-[11px] text-muted-foreground hover:border-border focus:border-border focus:outline-none"
            />
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              onBlur={() => onHours(start, end)}
              className="w-20 rounded border border-transparent bg-transparent px-0.5 text-[11px] text-muted-foreground hover:border-border focus:border-border focus:outline-none"
            />
          </div>
        </td>
        <td colSpan={days.length + 1} className="border-b border-l border-border" />
      </tr>

      {group.rows.map((personId) => (
        <tr key={personId} className="hover:bg-accent/30">
          <td className="sticky left-0 z-10 border-b border-border bg-card px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-foreground">
                {nameOf(personId === "open" ? null : personId)}
              </span>
              <button
                type="button"
                onClick={() => onRemovePerson(personId)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="Remove from this team"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </td>
          {days.map((d) => {
            const key = `${group.name}|${personId}|${d}`;
            const on = byCell.has(key);
            const busy = busyCell === key;
            return (
              <td key={d} className="border-b border-l border-border p-0">
                <button
                  type="button"
                  onClick={() => onToggle(personId, d)}
                  disabled={busy}
                  className={`h-7 w-full text-center text-xs font-semibold transition-colors ${
                    on
                      ? "bg-primary-soft text-primary hover:bg-primary/20"
                      : "text-transparent hover:bg-accent hover:text-muted-foreground"
                  }`}
                  title={`${nameOf(personId === "open" ? null : personId)} · ${d}`}
                >
                  {busy ? "…" : on ? "X" : "·"}
                </button>
              </td>
            );
          })}
          <td className="border-b border-l border-border" />
        </tr>
      ))}

      <tr>
        <td className="sticky left-0 z-10 border-b border-border bg-card px-2 py-1.5">
          <select
            value=""
            onChange={(e) => e.target.value && onAddPerson(e.target.value)}
            className="h-7 w-full rounded border border-input bg-background px-1 text-xs text-muted-foreground"
          >
            <option value="">+ Add someone…</option>
            {members
              .filter((m) => !group.rows.includes(m.id))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name || "Unnamed"}
                </option>
              ))}
            {!group.rows.includes("open") && <option value="open">Open shift row</option>}
          </select>
        </td>
        <td colSpan={days.length + 1} className="border-b border-l border-border" />
      </tr>
    </>
  );
}
