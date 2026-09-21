import { useMemo } from "react";
import { sheetLegend, sheetTime, shortName } from "@/lib/sheet-format";

/**
 * The weekly grid: the posted-sheet format a department prints and pins to
 * the wall — everyone down the side, Monday to Sunday across the top, each
 * shift in its day with its time and its post — drawn as frosted glass rather
 * than printed ink.
 *
 * It lists the people who work that week, not the whole company, the way the
 * sheet does: a row for somebody with nothing in it is a row to read past.
 * The person looking at it is pinned to the top and marked, because the first
 * thing anyone does with a posted schedule is find themselves on it.
 */

export interface GridShift {
  id: string;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string | null;
  color: string | null;
  published: boolean;
}

/**
 * Glass tints, one per shift colour. Written out in full because Tailwind reads
 * class names from source and cannot see one assembled at runtime. Each is a
 * translucent wash of the colour with a solid bar down its left edge, so shifts
 * stay tellable apart on a blurred background in either theme.
 */
const TINT: Record<string, string> = {
  primary:
    "bg-blue-500/15 border-blue-500 text-blue-950 ring-blue-500/25 dark:bg-blue-400/15 dark:text-blue-50",
  success:
    "bg-emerald-500/15 border-emerald-500 text-emerald-950 ring-emerald-500/25 dark:bg-emerald-400/15 dark:text-emerald-50",
  teal: "bg-teal-500/15 border-teal-500 text-teal-950 ring-teal-500/25 dark:bg-teal-400/15 dark:text-teal-50",
  sky: "bg-sky-500/15 border-sky-500 text-sky-950 ring-sky-500/25 dark:bg-sky-400/15 dark:text-sky-50",
  violet:
    "bg-violet-500/15 border-violet-500 text-violet-950 ring-violet-500/25 dark:bg-violet-400/15 dark:text-violet-50",
  rose: "bg-rose-500/15 border-rose-500 text-rose-950 ring-rose-500/25 dark:bg-rose-400/15 dark:text-rose-50",
  amber:
    "bg-amber-400/25 border-amber-500 text-amber-950 ring-amber-500/30 dark:bg-amber-400/15 dark:text-amber-50",
  slate:
    "bg-slate-500/15 border-slate-500 text-slate-900 ring-slate-500/25 dark:bg-slate-400/15 dark:text-slate-50",
};
const SWATCH: Record<string, string> = {
  primary: "bg-blue-500",
  success: "bg-emerald-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  slate: "bg-slate-500",
};
const tint = (c: string | null) => TINT[c ?? ""] ?? TINT.primary;
const swatch = (c: string | null) => SWATCH[c ?? ""] ?? SWATCH.primary;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function ScheduleGrid({
  days,
  shifts,
  nameOf,
  companyName,
  rangeLabel,
  selfId,
  showDrafts = false,
  emptyText = "Nobody is scheduled this week.",
  eyebrow = "Weekly schedule",
}: {
  /** The seven days of the week, Monday first. */
  days: Date[];
  shifts: GridShift[];
  nameOf: (id: string) => string;
  companyName: string;
  rangeLabel: string;
  /** Pinned to the top and marked, if they work this week. */
  selfId?: string;
  /** Show unpublished shifts, marked as drafts — a manager's view only. */
  showDrafts?: boolean;
  emptyText?: string;
  /** The small word above the dates — "This week" for the current one. */
  eyebrow?: string;
}) {
  const today = new Date();

  const { rows, legend } = useMemo(() => {
    const inWeek = shifts.filter(
      (s) => (showDrafts || s.published) && days.some((d) => sameDay(new Date(s.starts_at), d)),
    );
    const byPerson = new Map<string, GridShift[]>();
    for (const s of inWeek) {
      const key = s.employee_id ?? "open";
      const list = byPerson.get(key);
      if (list) list.push(s);
      else byPerson.set(key, [s]);
    }
    const rows = [...byPerson.entries()]
      .map(([id, list]) => ({
        id,
        name: id === "open" ? "Open shift" : nameOf(id),
        shifts: list.sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
      }))
      .sort((a, b) => {
        // You first, open shifts last, everyone else by name.
        const rank = (id: string) => (id === selfId ? 0 : id === "open" ? 2 : 1);
        return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
      });

    // A key only when the colours mean posts; see `sheetLegend`.
    const legend = sheetLegend(inWeek).map((l) => ({ position: l.label, color: l.color }));
    return { rows, legend };
  }, [shifts, days, nameOf, selfId, showDrafts]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/60 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.35)] dark:border-white/10">
      {/* What the glass is frosting: two soft pools of the brand colours. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70 dark:opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(ellipse at 0% 0%, oklch(0.78 0.12 255 / 0.55), transparent 55%), radial-gradient(ellipse at 100% 100%, oklch(0.82 0.11 190 / 0.5), transparent 55%)",
        }}
      />

      <div className="relative bg-white/55 backdrop-blur-xl dark:bg-slate-950/45">
        {/* The sheet's own heading: the week on the left, the company on the right. */}
        <div className="flex flex-wrap items-end justify-between gap-2 px-4 pb-3 pt-4 sm:px-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
              {eyebrow}
            </p>
            <p className="text-lg font-semibold text-slate-900 dark:text-white">{rangeLabel}</p>
          </div>
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{companyName}</p>
        </div>

        {rows.length === 0 ? (
          <p className="border-t border-white/50 px-5 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
            {emptyText}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 w-36 bg-slate-800/80 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-200 backdrop-blur-md">
                    Team
                  </th>
                  {days.map((d) => {
                    const isToday = sameDay(d, today);
                    return (
                      <th
                        key={d.toDateString()}
                        className={`px-2 py-2.5 text-center backdrop-blur-md ${
                          isToday ? "bg-primary/90 text-white" : "bg-slate-800/80 text-white"
                        }`}
                      >
                        <span className="block text-[13px] font-semibold">
                          {d.toLocaleDateString([], { weekday: "long" })}
                        </span>
                        <span
                          className={`block text-[11px] font-medium ${
                            isToday ? "text-white/85" : "text-slate-300"
                          }`}
                        >
                          {d.toLocaleDateString([], {
                            month: "2-digit",
                            day: "2-digit",
                            year: "numeric",
                          })}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const mine = row.id === selfId;
                  return (
                    <tr key={row.id} className="group">
                      <th
                        scope="row"
                        title={row.name}
                        className={`sticky left-0 z-10 border-b border-white/50 px-3 py-2 text-sm font-medium backdrop-blur-md dark:border-white/10 ${
                          mine
                            ? "bg-primary/15 text-primary dark:bg-primary/20"
                            : i % 2
                              ? "bg-white/70 text-slate-800 dark:bg-slate-900/60 dark:text-slate-100"
                              : "bg-white/85 text-slate-800 dark:bg-slate-900/75 dark:text-slate-100"
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {row.id === "open" ? row.name : shortName(row.name)}
                          {mine && (
                            <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                              You
                            </span>
                          )}
                        </span>
                      </th>
                      {days.map((d) => {
                        const cell = row.shifts.filter((s) => sameDay(new Date(s.starts_at), d));
                        return (
                          <td
                            key={d.toDateString()}
                            className={`border-b border-l border-white/50 p-1.5 align-top dark:border-white/10 ${
                              mine ? "bg-primary/5" : ""
                            } ${sameDay(d, today) ? "bg-primary/[0.04]" : ""}`}
                          >
                            <div className="space-y-1">
                              {cell.map((s) => (
                                <div
                                  key={s.id}
                                  className={`rounded-lg border-l-[3px] px-2 py-1.5 shadow-sm ring-1 ring-inset backdrop-blur-sm ${tint(
                                    s.color,
                                  )} ${!s.published ? "border-dashed opacity-75" : ""}`}
                                >
                                  <p className="whitespace-nowrap text-[12px] font-semibold leading-tight">
                                    {sheetTime(new Date(s.starts_at))}–
                                    {sheetTime(new Date(s.ends_at))}
                                  </p>
                                  {(s.position || !s.published) && (
                                    <p className="mt-0.5 truncate text-[11px] leading-tight opacity-75">
                                      {s.position}
                                      {!s.published && (
                                        <span className="ml-1 font-semibold uppercase tracking-wide">
                                          draft
                                        </span>
                                      )}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {legend.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:px-5">
            {legend.map((l) => (
              <span
                key={`${l.position}|${l.color}`}
                className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300"
              >
                <span className={`h-2.5 w-2.5 rounded-sm ${swatch(l.color)}`} />
                {l.position}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Classic or grid, for the top of any schedule screen. */
export function LayoutSwitch({
  layout,
  onChange,
  disabled,
}: {
  layout: "classic" | "grid";
  onChange: (l: "classic" | "grid") => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Schedule layout"
      className="inline-flex rounded-lg bg-secondary p-1"
    >
      {(
        [
          ["classic", "Classic"],
          ["grid", "Weekly grid"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={layout === value}
          disabled={disabled}
          onClick={() => onChange(value)}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
            layout === value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
