/**
 * Spreadsheet export for the platform admin screens.
 *
 * CSV rather than a library: every spreadsheet opens it, and the one rule that
 * matters — quote a field holding a comma, a quote or a line break, doubling
 * any quote inside — is three lines.
 */

type Cell = string | number | boolean | null | undefined;

function field(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // A leading = + - @ makes Excel treat the cell as a formula. A business name
  // is typed by whoever registered it, so it is not trusted to be text. Numbers
  // are ours, and a negative one is just a number.
  const safe = typeof v === "string" && /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(field).join(",")).join("\r\n");
}

/** Hands the file to the browser. The BOM is what makes Excel read it as UTF-8. */
export function downloadCsv(filename: string, header: string[], rows: Cell[][]): void {
  const blob = new Blob(["﻿" + toCsv(header, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A filename-safe slug of a company name, for "acme-co-members.csv". */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export"
  );
}

/** "just now", "12 min ago", "5 h ago", "3 d ago", then the date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(iso).toLocaleDateString([], { dateStyle: "medium" });
}
