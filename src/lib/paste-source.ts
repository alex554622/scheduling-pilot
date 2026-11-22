/**
 * What the schedule builder is pasting: either a shift copied from its editor
 * or a saved shift template. Both reduce to a time of day, a length and the
 * labels a new shift carries, so one paste path serves both.
 */
export interface PasteSource {
  /** What the paste bar shows, e.g. "Morning · 8:00 AM–4:00 PM". */
  label: string;
  /** Local minutes past midnight the shift starts at. */
  startMinutes: number;
  durationMinutes: number;
  breakMinutes: number;
  position: string;
  position_id: string | null;
  color: string;
  /** Set when the paste came from a template, so the shift remembers it. */
  template_id: string | null;
}

export interface TemplateRow {
  id: string;
  name: string;
  /** "HH:MM" or "HH:MM:SS", as Postgres returns a `time`. */
  start_time: string;
  end_time: string;
  break_minutes: number;
  position_id: string | null;
  color: string;
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** End before start means the shift runs past midnight. */
export function templateDuration(t: Pick<TemplateRow, "start_time" | "end_time">): number {
  const d = (timeToMinutes(t.end_time) - timeToMinutes(t.start_time) + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

export function sourceFromShift(
  s: {
    starts_at: string;
    ends_at: string;
    position: string;
    position_id: string | null;
    color: string;
    break_minutes?: number;
  },
  label: string,
): PasteSource {
  const starts = new Date(s.starts_at);
  return {
    label,
    startMinutes: starts.getHours() * 60 + starts.getMinutes(),
    durationMinutes: Math.max(
      1,
      Math.round((new Date(s.ends_at).getTime() - starts.getTime()) / 60_000),
    ),
    breakMinutes: s.break_minutes ?? 0,
    position: s.position,
    position_id: s.position_id,
    color: s.color,
    template_id: null,
  };
}

export function sourceFromTemplate(
  t: TemplateRow,
  positionName: string,
  label: string,
): PasteSource {
  return {
    label,
    startMinutes: timeToMinutes(t.start_time),
    durationMinutes: templateDuration(t),
    breakMinutes: t.break_minutes,
    position: positionName,
    position_id: t.position_id,
    color: t.color,
    template_id: t.id,
  };
}

/** The draft shift a paste of `src` onto `memberId`'s `day` inserts. */
export function shiftFromSource(src: PasteSource, companyId: string, memberId: string, day: Date) {
  const starts = new Date(day);
  starts.setHours(0, 0, 0, 0);
  starts.setMinutes(src.startMinutes);
  const ends = new Date(starts.getTime() + src.durationMinutes * 60_000);
  return {
    company_id: companyId,
    employee_id: memberId,
    starts_at: starts.toISOString(),
    ends_at: ends.toISOString(),
    break_minutes: src.breakMinutes,
    position: src.position,
    position_id: src.position_id,
    color: src.color,
    template_id: src.template_id,
    // Like any shift made by hand, a pasted one is a draft until published.
    published: false,
  };
}
