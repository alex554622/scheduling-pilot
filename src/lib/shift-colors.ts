/**
 * The colours a shift can be given on the schedule.
 *
 * `shifts.color` is a plain text column, so adding a colour here is all it
 * takes — no migration, and a shift saved with a colour that later disappears
 * simply falls back to the first one rather than rendering unstyled.
 *
 * Each entry carries both the Tailwind classes for the screen and a hex value
 * for the printed PDF, so a schedule on paper matches the one on the wall.
 * The class strings are written out in full because Tailwind scans source text
 * and cannot see a class name that was assembled at runtime.
 */

export interface ShiftColor {
  key: string;
  label: string;
  /** Background + foreground for a shift chip. */
  chip: string;
  /** Small square used in the colour picker. */
  swatch: string;
  hex: string;
}

export const SHIFT_COLORS: ShiftColor[] = [
  {
    key: "primary",
    label: "Blue",
    chip: "bg-primary text-primary-foreground",
    swatch: "bg-primary",
    hex: "#2563eb",
  },
  {
    key: "success",
    label: "Green",
    chip: "bg-success text-success-foreground",
    swatch: "bg-success",
    hex: "#16a34a",
  },
  {
    key: "teal",
    label: "Teal",
    chip: "bg-teal-600 text-white",
    swatch: "bg-teal-600",
    hex: "#0d9488",
  },
  { key: "sky", label: "Sky", chip: "bg-sky-500 text-white", swatch: "bg-sky-500", hex: "#0ea5e9" },
  {
    key: "violet",
    label: "Violet",
    chip: "bg-violet-600 text-white",
    swatch: "bg-violet-600",
    hex: "#7c3aed",
  },
  {
    key: "rose",
    label: "Rose",
    chip: "bg-rose-500 text-white",
    swatch: "bg-rose-500",
    hex: "#f43f5e",
  },
  {
    key: "amber",
    label: "Amber",
    chip: "bg-amber-500 text-white",
    swatch: "bg-amber-500",
    hex: "#f59e0b",
  },
  {
    key: "slate",
    label: "Slate",
    chip: "bg-slate-600 text-white",
    swatch: "bg-slate-600",
    hex: "#475569",
  },
];

const FALLBACK = SHIFT_COLORS[0];

function find(key: string | null | undefined): ShiftColor {
  return SHIFT_COLORS.find((c) => c.key === key) ?? FALLBACK;
}

/** Classes for a shift chip on the schedule. */
export function shiftColorClass(key: string | null | undefined): string {
  return find(key).chip;
}

/** The same colour as a hex value, for the printed schedule. */
export function shiftColorHex(key: string | null | undefined): string {
  return find(key).hex;
}

export function shiftColorLabel(key: string | null | undefined): string {
  return find(key).label;
}
