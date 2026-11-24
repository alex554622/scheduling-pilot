/**
 * The paper version of a timecard — a signed payroll record, not a screenshot
 * of the app. It is hidden on screen (see `[data-print-only]` in styles.css)
 * and laid out for letter portrait in black and white: no brand colour, no
 * status chips, hairline rules, and a signature block at the foot.
 */

import { fromDayString } from "@/lib/day-string";
import { localeTag, useT } from "@/lib/i18n";

export interface PrintablePair {
  inAt: string;
  outAt: string | null;
  unpaidBreakMs: number;
  paidBreakMs: number;
  offSite: boolean;
  /** "Late 12m" when the clock-in came after the scheduled start; otherwise null. */
  late?: string | null;
  /** "Night differential 6h 00m" for this shift, from the position's pay rules; otherwise null. */
  diff?: string | null;
  /** "Auto meal break 0h 30m" or a correction of it; otherwise null. */
  meal?: string | null;
  /** Where it was worked; null when the company keeps no locations. */
  location?: string | null;
}

export interface PrintableDay {
  date: Date;
  /** A day off on it — "Sick", "Vacation"… — or null. */
  absence?: string | null;
  /** A supervisor's comments on the day, ready to print. */
  comments?: string[];
  /** The published schedule for the day, "Scheduled 9:00 AM – 5:00 PM"; detailed card only. */
  scheduled?: string | null;
  pairs: PrintablePair[];
  totalMs: number;
}

/** A dated note on the card, printed in the detailed format's Notes section. */
export interface PrintableNote {
  /** The day it is about, "YYYY-MM-DD". */
  day: string;
  /** "Note" or "OT slip", as printed. */
  type?: string;
  /** An OT slip's hours, e.g. "2.50 hrs"; empty otherwise. */
  hours?: string;
  note: string;
  author: string;
  createdAt: string;
}

/** One week's subtotal on the detailed card, when it runs two weeks. */
export interface PrintableWeekTotal {
  workedMs: number;
  unpaidBreakMs: number;
  paidBreakMs: number;
}

export interface PrintableTimecardProps {
  /**
   * "simple" is the plain period list. "detailed" adds, on a bi-weekly card, a
   * subtotal under each week and a Notes section above the signatures.
   */
  format?: "simple" | "detailed";
  /** Detailed only: one subtotal per 7 days, in order. */
  weekTotals?: PrintableWeekTotal[];
  /** Detailed only: every note dated inside the period. */
  notes?: PrintableNote[];
  /**
   * Draw the page on screen too, for the Preview window. Left off, the card
   * exists only on paper (hidden until the browser prints).
   */
  onScreen?: boolean;
  /** Days off in the period by kind, e.g. { label: "Sick", days: "1 day" }. */
  absences?: { label: string; days: string }[];
  companyName: string;
  employeeName: string;
  position?: string | null;
  periodLabel: string;
  rangeStart: Date;
  /** Exclusive — the day after the last day of the period. */
  rangeEnd: Date;
  days: PrintableDay[];
  totals: { workedMs: number; unpaidBreakMs: number; paidBreakMs: number };
  /** Hours split by the company's daily and weekly overtime rules. */
  split: { regularMs: number; overtimeMs: number; doubleTimeMs: number };
  /** The period's differential hours under the position's differential label; null when none. */
  differential?: { label: string; ms: number } | null;
  /** Paid time per location, most first; empty when the company keeps none. */
  byLocation?: { name: string; ms: number }[];
  /** Plain-English summary of the rules in force, for the footer. */
  overtimeNote: string;
  /** Punch rounding, quoted on the page so the numbers can be audited. */
  roundMinutes: number;
  formatTime: (iso: string) => string;
  formatHours: (ms: number) => string;
}

const HOUR_MS = 3_600_000;

function fmtLongDate(d: Date): string {
  return d.toLocaleDateString(localeTag(), { month: "long", day: "numeric", year: "numeric" });
}

function fmtRowDate(d: Date): string {
  return d.toLocaleDateString(localeTag(), { weekday: "short", month: "short", day: "numeric" });
}

/** Payroll wants decimal hours; the h/m form is for reading. Both are shown. */
function decimalHours(ms: number): string {
  return (ms / HOUR_MS).toFixed(2);
}

export function PrintableTimecard({
  format = "simple",
  weekTotals = [],
  notes = [],
  onScreen = false,
  absences = [],
  companyName,
  employeeName,
  position,
  periodLabel,
  rangeStart,
  rangeEnd,
  days,
  totals,
  split,
  byLocation = [],
  differential = null,
  overtimeNote,
  roundMinutes,
  formatTime,
  formatHours,
}: PrintableTimecardProps) {
  const t = useT("timecards");
  const lastDay = new Date(rangeEnd.getTime() - 86_400_000);
  // A day someone is still clocked into has no completed hours yet, but they
  // did work it — count any day with a punch.
  const daysWorked = days.filter((d) => d.pairs.length > 0).length;
  const detailed = format === "detailed";

  return (
    <div
      data-print-only={onScreen ? undefined : true}
      className="mx-auto max-w-[7.5in] bg-white font-sans text-[11px] leading-snug text-black"
    >
      <header className="flex items-start justify-between border-b-2 border-black pb-2">
        <div>
          <p className="text-[15px] font-bold uppercase tracking-wide">{companyName}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-neutral-600">
            {detailed ? t("Detailed time card") : t("Employee timecard")}
          </p>
        </div>
        <div className="text-right text-[10px] text-neutral-700">
          <p>
            <span className="font-semibold text-black">{t("Pay period")}</span> · {periodLabel}
          </p>
          <p>
            {fmtLongDate(rangeStart)} – {fmtLongDate(lastDay)}
          </p>
        </div>
      </header>

      <section className="mt-3 grid grid-cols-4 gap-x-4 gap-y-1.5 border-b border-neutral-400 pb-3">
        <Field label={t("Employee")} value={employeeName} />
        <Field label={t("Position")} value={position || "—"} />
        <Field label={t("Days worked")} value={String(daysWorked)} />
        <Field label={t("Prepared")} value={fmtLongDate(new Date())} />
      </section>

      <table className="mt-3 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-neutral-100">
            <Th className="w-[19%] text-left">{t("Date")}</Th>
            <Th className="w-[12%]">{t("Clock in")}</Th>
            <Th className="w-[12%]">{t("Clock out")}</Th>
            <Th className="w-[13%]">{t("Unpaid break")}</Th>
            <Th className="w-[13%]">{t("Paid break")}</Th>
            <Th className="w-[13%] text-right">{t("Hours")}</Th>
            <Th className="text-left">{t("Notes")}</Th>
          </tr>
        </thead>
        <tbody>
          {days.map((day, dayIndex) => {
            // The detailed card closes each week with its own subtotal, so a
            // week's overtime can be checked against the hours above it.
            const week =
              detailed && (dayIndex + 1) % 7 === 0
                ? weekTotals[Math.floor(dayIndex / 7)]
                : undefined;
            const subtotal = week ? (
              <tr
                key={`week-${dayIndex}`}
                className="border-b border-black bg-neutral-50 font-semibold"
              >
                <Td className="text-left">
                  {t("Week {n} total", { n: Math.floor(dayIndex / 7) + 1 })}
                </Td>
                <Td />
                <Td />
                <Td>{formatHours(week.unpaidBreakMs)}</Td>
                <Td>{formatHours(week.paidBreakMs)}</Td>
                <Td className="text-right">{formatHours(week.workedMs)}</Td>
                <Td className="text-left font-normal">
                  {decimalHours(week.workedMs)} {t("hrs")}
                </Td>
              </tr>
            ) : null;
            if (day.pairs.length === 0) {
              return [
                <tr key={day.date.toISOString()} className="border-b border-neutral-300">
                  <Td className="text-left font-medium">
                    {fmtRowDate(day.date)}
                    <ScheduledLine text={day.scheduled} />
                  </Td>
                  <Td>—</Td>
                  <Td>—</Td>
                  <Td>—</Td>
                  <Td>—</Td>
                  <Td className="text-right">0h 00m</Td>
                  <Td className="text-left text-neutral-500">
                    {[day.absence ?? t("No punches"), ...(day.comments ?? [])].join(" · ")}
                  </Td>
                </tr>,
                subtotal,
              ];
            }
            return [
              ...day.pairs.map((pair, i) => (
                <tr
                  key={`${day.date.toISOString()}-${i}`}
                  className={i === day.pairs.length - 1 ? "border-b border-neutral-300" : ""}
                >
                  {/* The date labels the day once; extra shifts hang beneath it. */}
                  <Td className="text-left font-medium">
                    {i === 0 ? fmtRowDate(day.date) : ""}
                    {i === 0 && <ScheduledLine text={day.scheduled} />}
                  </Td>
                  <Td>{formatTime(pair.inAt)}</Td>
                  <Td>{pair.outAt ? formatTime(pair.outAt) : "—"}</Td>
                  <Td>{pair.unpaidBreakMs > 0 ? formatHours(pair.unpaidBreakMs) : "—"}</Td>
                  <Td>{pair.paidBreakMs > 0 ? formatHours(pair.paidBreakMs) : "—"}</Td>
                  {/* The day's hours sit on the date's own line. On the second
                    shift of a split day it would read as that shift's length. */}
                  <Td className="text-right">{i === 0 ? formatHours(day.totalMs) : ""}</Td>
                  <Td className="text-left text-neutral-600">
                    {[
                      i === 0 ? (day.absence ?? null) : null,
                      ...(i === 0 ? (day.comments ?? []) : []),
                      pair.location ?? null,
                      pair.late ?? null,
                      pair.diff ?? null,
                      pair.meal ?? null,
                      !pair.outAt ? t("Still clocked in") : null,
                      pair.offSite ? t("Off-site punch") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Td>
                </tr>
              )),
              subtotal,
            ];
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-black bg-neutral-100 font-semibold">
            <Td className="text-left">{t("Period total")}</Td>
            <Td />
            <Td />
            <Td>{formatHours(totals.unpaidBreakMs)}</Td>
            <Td>{formatHours(totals.paidBreakMs)}</Td>
            <Td className="text-right">{formatHours(totals.workedMs)}</Td>
            <Td className="text-left font-normal">
              {decimalHours(totals.workedMs)} {t("hrs")}
            </Td>
          </tr>
        </tfoot>
      </table>

      <section className="mt-3 flex justify-end" data-print-keep>
        <table className="border-collapse text-[11px]">
          <tbody>
            {byLocation.map((l, i) => (
              <SummaryRow
                key={`${l.name}-${i}`}
                label={l.name}
                value={`${formatHours(l.ms)}  (${decimalHours(l.ms)})`}
                last={i === byLocation.length - 1}
              />
            ))}
            <SummaryRow
              label={t("Regular hours")}
              value={`${formatHours(split.regularMs)}  (${decimalHours(split.regularMs)})`}
            />
            {split.overtimeMs > 0 && (
              <SummaryRow
                label={t("Overtime")}
                value={`${formatHours(split.overtimeMs)}  (${decimalHours(split.overtimeMs)})`}
              />
            )}
            {split.doubleTimeMs > 0 && (
              <SummaryRow
                label={t("Double time")}
                value={`${formatHours(split.doubleTimeMs)}  (${decimalHours(split.doubleTimeMs)})`}
              />
            )}
            {differential && differential.ms > 0 && (
              <SummaryRow
                label={differential.label}
                value={`${formatHours(differential.ms)}  (${decimalHours(differential.ms)})`}
              />
            )}
            <SummaryRow
              label={t("Total worked")}
              value={`${formatHours(totals.workedMs)}  (${decimalHours(totals.workedMs)})`}
              emphasis
            />
          </tbody>
        </table>
      </section>

      {absences.length > 0 && (
        <p className="mt-2 text-right text-[11px]">
          <span className="font-semibold">{t("Days off")}:</span>{" "}
          {absences.map((a) => `${a.label} ${a.days}`).join("  ·  ")}
        </p>
      )}

      {detailed && (
        <section className="mt-5" data-print-keep>
          <p className="border-b border-black pb-1 text-[10px] font-bold uppercase tracking-wider">
            {t("Notes")}
          </p>
          {notes.length === 0 ? (
            <p className="py-2 text-neutral-500">{t("No notes for this period.")}</p>
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="bg-neutral-100">
                  <Th className="w-[15%] text-left">{t("Date")}</Th>
                  <Th className="w-[11%] text-left">{t("Type")}</Th>
                  <Th className="text-left">{t("Note")}</Th>
                  <Th className="w-[10%] text-right">{t("Hours")}</Th>
                  <Th className="w-[18%] text-left">{t("Created by")}</Th>
                  <Th className="w-[17%] text-left">{t("Created")}</Th>
                </tr>
              </thead>
              <tbody>
                {notes.map((n, i) => (
                  <tr key={i} className="border-b border-neutral-300">
                    <Td className="text-left font-medium">{fmtRowDate(fromDayString(n.day))}</Td>
                    <Td className="text-left">{n.type ?? ""}</Td>
                    <Td className="whitespace-pre-wrap text-left">{n.note}</Td>
                    <Td className="text-right">{n.hours ?? ""}</Td>
                    <Td className="text-left">{n.author || "—"}</Td>
                    <Td className="text-left text-neutral-600">
                      {new Date(n.createdAt).toLocaleString(localeTag(), {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="mt-8 grid grid-cols-2 gap-10" data-print-keep>
        <SignatureLine role={t("Employee signature")} />
        <SignatureLine role={t("Supervisor signature")} />
      </section>

      <footer className="mt-6 border-t border-neutral-300 pt-2 text-[9px] text-neutral-500">
        <p>
          {t(
            "I certify that the hours recorded above are a true and complete record of the time I worked during this pay period.",
          )}
        </p>
        <p className="mt-1">
          {roundMinutes > 0
            ? t("Punch times and hours rounded to the nearest {n} minutes.", { n: roundMinutes })
            : t("Punch times shown as recorded.")}{" "}
          {t("Unpaid break time is deducted from hours worked; paid break time is not.")}{" "}
          {t("Generated by Scheduling Pilot on {date}.", {
            date: new Date().toLocaleString(localeTag()),
          })}
        </p>
        <p className="mt-1">{overtimeNote}</p>
      </footer>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-black px-1.5 py-1 text-center text-[9px] font-semibold uppercase tracking-wider ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`px-1.5 py-1 text-center align-top tabular-nums ${className}`}>{children}</td>
  );
}

function SummaryRow({
  label,
  value,
  emphasis,
  last,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  /** The last of the per-location lines, ruled off from the pay split below. */
  last?: boolean;
}) {
  return (
    <tr
      className={
        emphasis ? "border-t border-black font-bold" : last ? "border-b border-neutral-300" : ""
      }
    >
      <td className="py-1 pr-6 text-right">{label}</td>
      <td className="py-1 text-right tabular-nums">{value}</td>
    </tr>
  );
}

function SignatureLine({ role }: { role: string }) {
  const t = useT("timecards");
  return (
    <div>
      <div className="h-8 border-b border-black" />
      <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-neutral-600">
        <span>{role}</span>
        <span>{t("Date")}</span>
      </div>
    </div>
  );
}

/** The day's published schedule, small and grey under the date. */
function ScheduledLine({ text }: { text?: string | null }) {
  if (!text) return null;
  return <div className="mt-0.5 text-[9px] font-normal text-neutral-500">{text}</div>;
}
