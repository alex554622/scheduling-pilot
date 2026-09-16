/**
 * The paper version of a timecard — a signed payroll record, not a screenshot
 * of the app. It is hidden on screen (see `[data-print-only]` in styles.css)
 * and laid out for letter portrait in black and white: no brand colour, no
 * status chips, hairline rules, and a signature block at the foot.
 */

export interface PrintablePair {
  inAt: string;
  outAt: string | null;
  unpaidBreakMs: number;
  paidBreakMs: number;
  offSite: boolean;
}

export interface PrintableDay {
  date: Date;
  pairs: PrintablePair[];
  totalMs: number;
}

export interface PrintableTimecardProps {
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
  /** Plain-English summary of the rules in force, for the footer. */
  overtimeNote: string;
  /** Punch rounding, quoted on the page so the numbers can be audited. */
  roundMinutes: number;
  formatTime: (iso: string) => string;
  formatHours: (ms: number) => string;
}

const HOUR_MS = 3_600_000;

function fmtLongDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function fmtRowDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Payroll wants decimal hours; the h/m form is for reading. Both are shown. */
function decimalHours(ms: number): string {
  return (ms / HOUR_MS).toFixed(2);
}

export function PrintableTimecard({
  companyName,
  employeeName,
  position,
  periodLabel,
  rangeStart,
  rangeEnd,
  days,
  totals,
  split,
  overtimeNote,
  roundMinutes,
  formatTime,
  formatHours,
}: PrintableTimecardProps) {
  const lastDay = new Date(rangeEnd.getTime() - 86_400_000);
  // A day someone is still clocked into has no completed hours yet, but they
  // did work it — count any day with a punch.
  const daysWorked = days.filter((d) => d.pairs.length > 0).length;

  return (
    <div data-print-only className="mx-auto max-w-[7.5in] bg-white font-sans text-[11px] leading-snug text-black">
      <header className="flex items-start justify-between border-b-2 border-black pb-2">
        <div>
          <p className="text-[15px] font-bold uppercase tracking-wide">{companyName}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-neutral-600">Employee timecard</p>
        </div>
        <div className="text-right text-[10px] text-neutral-700">
          <p>
            <span className="font-semibold text-black">Pay period</span> · {periodLabel}
          </p>
          <p>
            {fmtLongDate(rangeStart)} – {fmtLongDate(lastDay)}
          </p>
        </div>
      </header>

      <section className="mt-3 grid grid-cols-4 gap-x-4 gap-y-1.5 border-b border-neutral-400 pb-3">
        <Field label="Employee" value={employeeName} />
        <Field label="Position" value={position || "—"} />
        <Field label="Days worked" value={String(daysWorked)} />
        <Field label="Prepared" value={fmtLongDate(new Date())} />
      </section>

      <table className="mt-3 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-neutral-100">
            <Th className="w-[19%] text-left">Date</Th>
            <Th className="w-[12%]">Clock in</Th>
            <Th className="w-[12%]">Clock out</Th>
            <Th className="w-[13%]">Unpaid break</Th>
            <Th className="w-[13%]">Paid break</Th>
            <Th className="w-[13%] text-right">Hours</Th>
            <Th className="text-left">Notes</Th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => {
            if (day.pairs.length === 0) {
              return (
                <tr key={day.date.toISOString()} className="border-b border-neutral-300">
                  <Td className="text-left font-medium">{fmtRowDate(day.date)}</Td>
                  <Td>—</Td>
                  <Td>—</Td>
                  <Td>—</Td>
                  <Td>—</Td>
                  <Td className="text-right">0h 00m</Td>
                  <Td className="text-left text-neutral-500">No punches</Td>
                </tr>
              );
            }
            return day.pairs.map((pair, i) => (
              <tr
                key={`${day.date.toISOString()}-${i}`}
                className={i === day.pairs.length - 1 ? "border-b border-neutral-300" : ""}
              >
                {/* The date labels the day once; extra shifts hang beneath it. */}
                <Td className="text-left font-medium">{i === 0 ? fmtRowDate(day.date) : ""}</Td>
                <Td>{formatTime(pair.inAt)}</Td>
                <Td>{pair.outAt ? formatTime(pair.outAt) : "—"}</Td>
                <Td>{pair.unpaidBreakMs > 0 ? formatHours(pair.unpaidBreakMs) : "—"}</Td>
                <Td>{pair.paidBreakMs > 0 ? formatHours(pair.paidBreakMs) : "—"}</Td>
                {/* The day's hours sit on the date's own line. On the second
                    shift of a split day it would read as that shift's length. */}
                <Td className="text-right">{i === 0 ? formatHours(day.totalMs) : ""}</Td>
                <Td className="text-left text-neutral-600">
                  {[!pair.outAt ? "Still clocked in" : null, pair.offSite ? "Off-site punch" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </Td>
              </tr>
            ));
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-black bg-neutral-100 font-semibold">
            <Td className="text-left">Period total</Td>
            <Td />
            <Td />
            <Td>{formatHours(totals.unpaidBreakMs)}</Td>
            <Td>{formatHours(totals.paidBreakMs)}</Td>
            <Td className="text-right">{formatHours(totals.workedMs)}</Td>
            <Td className="text-left font-normal">{decimalHours(totals.workedMs)} hrs</Td>
          </tr>
        </tfoot>
      </table>

      <section className="mt-3 flex justify-end" data-print-keep>
        <table className="border-collapse text-[11px]">
          <tbody>
            <SummaryRow label="Regular hours" value={`${formatHours(split.regularMs)}  (${decimalHours(split.regularMs)})`} />
            {split.overtimeMs > 0 && (
              <SummaryRow label="Overtime" value={`${formatHours(split.overtimeMs)}  (${decimalHours(split.overtimeMs)})`} />
            )}
            {split.doubleTimeMs > 0 && (
              <SummaryRow label="Double time" value={`${formatHours(split.doubleTimeMs)}  (${decimalHours(split.doubleTimeMs)})`} />
            )}
            <SummaryRow
              label="Total worked"
              value={`${formatHours(totals.workedMs)}  (${decimalHours(totals.workedMs)})`}
              emphasis
            />
          </tbody>
        </table>
      </section>

      <section className="mt-8 grid grid-cols-2 gap-10" data-print-keep>
        <SignatureLine role="Employee signature" />
        <SignatureLine role="Supervisor signature" />
      </section>

      <footer className="mt-6 border-t border-neutral-300 pt-2 text-[9px] text-neutral-500">
        <p>
          I certify that the hours recorded above are a true and complete record of the time I worked during this pay
          period.
        </p>
        <p className="mt-1">
          Punch times{" "}
          {roundMinutes > 0
            ? `and hours rounded to the nearest ${roundMinutes} minutes`
            : "shown as recorded"}
          . Unpaid
          break time is deducted from hours worked; paid break time is not. Generated by Scheduling Pilot on{" "}
          {new Date().toLocaleString()}.
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
  return <td className={`px-1.5 py-1 text-center align-top tabular-nums ${className}`}>{children}</td>;
}

function SummaryRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <tr className={emphasis ? "border-t border-black font-bold" : ""}>
      <td className="py-1 pr-6 text-right">{label}</td>
      <td className="py-1 text-right tabular-nums">{value}</td>
    </tr>
  );
}

function SignatureLine({ role }: { role: string }) {
  return (
    <div>
      <div className="h-8 border-b border-black" />
      <div className="mt-1 flex justify-between text-[9px] uppercase tracking-wider text-neutral-600">
        <span>{role}</span>
        <span>Date</span>
      </div>
    </div>
  );
}
