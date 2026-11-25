/**
 * Which punches belong on today's dashboard.
 *
 * A shift can cross midnight (in at 10 PM, out at 6 AM). Counting only the
 * punches since midnight made that person vanish at 12:00 while still working.
 * So the dashboard reads back further and keeps, per person:
 *
 *  - a stretch that started today (clocked in after midnight), and
 *  - a stretch that started before midnight and is still open — they stay on
 *    the dashboard until they clock out.
 *
 * Once that overnight stretch is closed it is yesterday's work and drops off;
 * if they clock in again later today, that new stretch shows as usual.
 *
 * Punches must be oldest first.
 */
export function keepTodaysPunches<P extends { user_id: string; kind: string; at: string }>(
  punches: readonly P[],
  dayStartMs: number,
): P[] {
  const byUser = new Map<string, P[]>();
  for (const p of punches) {
    const list = byUser.get(p.user_id);
    if (list) list.push(p);
    else byUser.set(p.user_id, [p]);
  }
  const kept: P[] = [];
  for (const list of byUser.values()) {
    let stretch: P[] = [];
    const close = (open: boolean) => {
      if (!stretch.length) return;
      const startedToday = new Date(stretch[0].at).getTime() >= dayStartMs;
      if (startedToday || open) kept.push(...stretch);
      stretch = [];
    };
    for (const p of list) {
      if (p.kind === "in") close(false);
      stretch.push(p);
      if (p.kind === "out") close(false);
    }
    // Whatever is left has no clock-out yet. A stray break punch with no
    // clock-in before it only counts if it is from today.
    if (stretch.length && stretch[0].kind !== "in") close(false);
    else close(true);
  }
  return kept.sort((a, b) => a.at.localeCompare(b.at));
}
