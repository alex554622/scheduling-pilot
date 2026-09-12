/**
 * Worked time per person, for the roster-wide timecard view.
 *
 * The rules match a single timecard exactly, because the two are read side by
 * side and any difference between them reads as a bug: an unpaid break comes
 * off the shift, a 10-minute break is paid and does not, and a shift with no
 * clock-out contributes nothing until someone closes it.
 */

export type PunchKind = "in" | "out" | "break_start" | "break_end";

export interface SimplePunch {
  user_id: string;
  kind: PunchKind;
  at: string;
  break_minutes: number | null;
}

export interface PersonTotals {
  workedMs: number;
  unpaidMs: number;
  paidMs: number;
  /** One entry per day with punches — what the overtime split reads. */
  dayTotals: number[];
}

export function totalsByPerson(punches: SimplePunch[]): Map<string, PersonTotals> {
  const byUser = new Map<string, Map<string, SimplePunch[]>>();
  for (const p of punches) {
    const day = new Date(p.at).toDateString();
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, new Map());
    const days = byUser.get(p.user_id)!;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(p);
  }

  const out = new Map<string, PersonTotals>();
  for (const [userId, days] of byUser) {
    const totals: PersonTotals = { workedMs: 0, unpaidMs: 0, paidMs: 0, dayTotals: [] };
    for (const list of days.values()) {
      const ordered = [...list].sort((a, b) => a.at.localeCompare(b.at));
      let dayMs = 0;
      let openIn: SimplePunch | null = null;
      let openBreak: SimplePunch | null = null;
      let unpaid = 0;
      let paid = 0;
      for (const p of ordered) {
        if (p.kind === "in") {
          openIn = p;
          unpaid = 0;
          paid = 0;
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            dayMs += Math.max(0, gross - unpaid);
            totals.unpaidMs += unpaid;
            totals.paidMs += paid;
            openIn = null;
            unpaid = 0;
            paid = 0;
            openBreak = null;
          }
        } else if (p.kind === "break_start") {
          if (openIn && !openBreak) openBreak = p;
        } else if (p.kind === "break_end") {
          if (openBreak) {
            const elapsed = new Date(p.at).getTime() - new Date(openBreak.at).getTime();
            if (openBreak.break_minutes === 10) paid += elapsed;
            else unpaid += elapsed;
            openBreak = null;
          }
        }
      }
      totals.workedMs += dayMs;
      totals.dayTotals.push(dayMs);
    }
    out.set(userId, totals);
  }
  return out;
}
