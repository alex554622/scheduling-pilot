/**
 * How the posted sheet writes things — shared by the on-screen weekly grid and
 * its printed PDF, so the two cannot drift apart.
 */

/** "Alan P." — the sheet's own way of naming people: first name, last initial. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Unnamed";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** "2:30pm" — the sheet's time style, compact enough for seven columns. */
export function sheetTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

/**
 * The colour key, when there is one to give.
 *
 * The sheet this format comes from keyed its colours to posts — yellow for
 * Traffic/Parking, green for Meters Clerk — so a key explained them. Here a
 * colour is whatever the manager picked for that shift, and a company that
 * colours by hand ends up with the same post in three colours; a key for that
 * would list "Traffic controller" three times and explain nothing. So it is
 * only offered when the colours really do mean posts: every colour used for
 * exactly one post, and every post in exactly one colour. Otherwise, none.
 */
export function sheetLegend<C extends string | null>(
  shifts: { position: string | null; color: C }[],
): { label: string; color: C }[] {
  const postsByColor = new Map<string, Set<string>>();
  const colorsByPost = new Map<string, Set<string>>();
  const colorOf = new Map<string, C>();
  for (const s of shifts) {
    const post = s.position?.trim();
    if (!post) continue;
    const key = s.color ?? "";
    colorOf.set(key, s.color);
    (postsByColor.get(key) ?? postsByColor.set(key, new Set()).get(key)!).add(post);
    (colorsByPost.get(post) ?? colorsByPost.set(post, new Set()).get(post)!).add(key);
  }
  const oneToOne =
    postsByColor.size > 0 &&
    [...postsByColor.values()].every((p) => p.size === 1) &&
    [...colorsByPost.values()].every((c) => c.size === 1);
  if (!oneToOne) return [];
  return [...postsByColor.entries()].map(([key, posts]) => ({
    label: [...posts][0],
    color: colorOf.get(key) as C,
  }));
}
