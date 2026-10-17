/** Formatting and status helpers for a company's billing period. */
import { translate, localeTag } from "@/lib/i18n";

/**
 * Whole days to the billing date, rounded away from zero.
 *
 * `ceil`, not `floor`: a date exactly six days out is 5.9999 days away by the
 * time this runs, and reading "in 5 days" on it is wrong in both directions —
 * the same truncation made a nine-day-old date say "10 days late".
 */
function daysUntil(periodEnd: string | null): number | null {
  if (!periodEnd) return null;
  return Math.ceil((new Date(periodEnd).getTime() - Date.now()) / 86_400_000);
}

export function fmtBillingDate(v: string | null): string {
  return v ? new Date(v).toLocaleDateString(localeTag(), { month: "short", day: "numeric", year: "numeric" }) : translate("Not set");
}

/** "in 6 days" / "Due today" / "9 days late" — the bit worth reading first. */
export function billingDueLabel(periodEnd: string | null): string {
  const d = daysUntil(periodEnd);
  if (d == null) return translate("No billing date yet");
  if (d < 0) return d === -1 ? translate("1 day late") : translate("{n} days late", { n: Math.abs(d) });
  if (d === 0) return translate("Due today");
  return d === 1 ? translate("in 1 day") : translate("in {n} days", { n: d });
}

/** A suspended company is already dealt with, so it isn't flagged again. */
export function isBillingOverdue(target: { periodEnd: string | null; companyStatus: string }): boolean {
  const d = daysUntil(target.periodEnd);
  return d != null && d < 0 && target.companyStatus !== "suspended";
}

/** `datetime-local` wants local wall-clock time, not the ISO instant. */
export function toLocalDateTimeInput(value: string | Date): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
