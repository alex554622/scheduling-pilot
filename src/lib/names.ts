/**
 * People are listed by last name everywhere: schedule, dashboard, timecards,
 * pickers. A profile holds one `full_name`, so the last name is its last word,
 * skipping a suffix ("Jr.", "III"). Ties go to the rest of the name. Case and
 * accents don't matter ("ÁVILA" sorts with "avila").
 */

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const PARTICLES = new Set(["de", "del", "la", "las", "los", "da", "das", "do", "dos", "di", "du", "van", "von", "der", "den", "le", "st", "st."]);
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** "Ana María López Jr." → { last: "López", rest: "Ana María Jr." } */
export function splitName(fullName: string | null | undefined): { last: string; rest: string } {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  let i = words.length - 1;
  while (i > 0 && SUFFIXES.has(words[i].toLowerCase().replace(/[.,]/g, ""))) i--;
  if (i < 0) return { last: "", rest: "" };
  // "De la Torre", "Van Dyke": the particles belong to the last name, so the
  // person sorts under D or V. At least one word stays as the first name.
  let start = i;
  while (start > 1 && PARTICLES.has(words[start - 1].toLowerCase())) start--;
  return {
    last: words.slice(start, i + 1).join(" ").replace(/,$/, ""),
    rest: [...words.slice(0, start), ...words.slice(i + 1)].join(" "),
  };
}

/** Compare two full names by last name, then the rest. Blank names go last. */
export function compareByLastName(a: string | null | undefined, b: string | null | undefined): number {
  const x = splitName(a);
  const y = splitName(b);
  if (!x.last !== !y.last) return x.last ? -1 : 1;
  return collator.compare(x.last, y.last) || collator.compare(x.rest, y.rest);
}

/** A copy of `rows` in last-name order. */
export function sortByLastName<T>(rows: readonly T[], nameOf: (row: T) => string | null | undefined): T[] {
  return [...rows].sort((a, b) => compareByLastName(nameOf(a), nameOf(b)));
}
