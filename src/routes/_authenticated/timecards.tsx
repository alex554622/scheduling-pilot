import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { isNativeApp } from "@/lib/native/platform";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import { useScheduleMarks } from "@/lib/use-lateness";
import { usePayRulesByMember, usePayRulesFor } from "@/lib/use-pay-rules";
import { differentialMs } from "@/lib/pay-rules";
import { LateBadge } from "@/components/late-badge";
import { useStaffVisibility } from "@/lib/staff-visibility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CalendarOff,
  CalendarClock,
  CalendarX,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Loader2,
  MapPin,
  MessageSquarePlus,
  NotebookPen,
  Pencil,
  Printer,
  Trash2,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PrintableTimecard, type PrintableTimecardProps } from "@/components/printable-timecard";
import { TimecardDayEditor, type EditablePunch } from "@/components/timecard-day-editor";
import { splitPeriod, overtimeNote } from "@/lib/overtime";
import {
  groupByShiftDay,
  MAX_SHIFT_MS,
  punchesInPeriod,
  readBreak,
  roundPunches,
  roundToMinutes,
  totalsByPerson,
  type LocationHours,
  type LocationMove,
  type SimplePunch,
} from "@/lib/timecard-totals";
import { fromDayString, toDayString } from "@/lib/day-string";
import { localeTag, useT } from "@/lib/i18n";

/**
 * `?user=<id>&day=YYYY-MM-DD` opens that person's card on that day's editor —
 * how a manager gets here from a name on the dashboard roster.
 */
const searchSchema = z.object({
  user: z.string().uuid().optional(),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const Route = createFileRoute("/_authenticated/timecards")({
  validateSearch: (s) => searchSchema.parse(s),
  component: TimecardsPage,
});

type Punch = {
  id: string;
  user_id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
  distance_m: number | null;
  within_geofence: boolean;
  break_minutes: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Where the stretch was worked; the clock-in's is the one that counts. */
  location_id: string | null;
};

/** Punch kinds as a manager reads them in the location log. */
const KIND_LABEL: Record<Punch["kind"], string> = {
  in: "Clocked in",
  out: "Clocked out",
  break_start: "Break started",
  break_end: "Break ended",
};

type Period = "week" | "biweek";

/**
 * Which card is on screen and on paper. "simple" is the plain weekly or
 * bi-weekly list; "detailed" carries the manager's dated notes for the
 * period and, when it runs two weeks, closes each week with a subtotal.
 */
type CardFormat = "simple" | "detailed";

/**
 * An approved day off on the card: sick, family leave, vacation… These are
 * time_off_requests rows, the same ones the Time off page shows.
 */
type Absence = {
  id: string;
  kind: string;
  start_date: string;
  end_date: string;
  note: string | null;
};

/** The kinds an admin can mark from the time card, in the order offered. */
const ABSENCE_KINDS = ["sick", "family_leave", "vacation", "personal", "other"] as const;
/** Stored kinds stay English; these are the words shown for them. */
const ABSENCE_LABEL: Record<string, string> = {
  sick: "Sick",
  family_leave: "Family leave",
  vacation: "Vacation",
  personal: "Personal",
  other: "Day off",
};

/** Where the last-picked card format and pay period are remembered. */
const CARD_FORMAT_KEY = "timecards.format";
const CARD_PERIOD_KEY = "timecards.period";

type TimecardNote = {
  id: string;
  note_date: string;
  note: string;
  author_name: string;
  created_at: string;
  /** "day" a comment on that day's line; "note" / "ot_slip" the Notes section. */
  kind: string;
  /** An OT slip's hours; empty for the rest. */
  hours: number | null;
};

/** What goes in the Notes section at the foot of the card (not a day comment). */
type PeriodNoteKind = "note" | "ot_slip";
const NOTE_KIND_LABEL: Record<string, string> = { note: "Note", ot_slip: "OT slip" };

function startOfWeek(d: Date, weekStartDay = 1) {
  const x = new Date(d);
  const day = (x.getDay() - weekStartDay + 7) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDate(d: Date) {
  return d.toLocaleDateString(localeTag(), { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(s: string, roundMin = 0) {
  return roundToMinutes(new Date(s), roundMin).toLocaleTimeString(localeTag() ?? [], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
/** 6.00, 29.90 — decimal hours, the unit payroll actually takes. */
function fmtDecimal(ms: number) {
  return (ms / 3600000).toFixed(2);
}

/** `Sat Sep 5`, for the day rows under a person. */
function fmtDayShort(d: Date) {
  return d.toLocaleDateString(localeTag() ?? [], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** AP, DG — the initials shown in the avatar circle. */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function fmtHours(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function TimecardsPage() {
  const t = useT("timecards");
  const qc = useQueryClient();
  const { user, profile, company, primaryRole, loading } = useAuth();
  const rules = useAppRules();
  const staff = useStaffVisibility();
  const isSuperAdmin = primaryRole === "super_admin";
  const isManager = primaryRole === "company_admin" || isSuperAdmin;
  const [period, setPeriod] = useState<Period>("week");
  const [format, setFormat] = useState<CardFormat>("simple");
  // The card someone last picked opens again next time, until they pick
  // another. Kept in this browser only. Read after mount, not in the state
  // initialiser: the server render has no localStorage, and the two renders
  // must agree. `prefsLoaded` stops the save below from writing the defaults
  // over the saved choice before it has been read.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    try {
      const f = localStorage.getItem(CARD_FORMAT_KEY);
      const p = localStorage.getItem(CARD_PERIOD_KEY);
      if (f === "simple" || f === "detailed") setFormat(f);
      if (p === "week" || p === "biweek") setPeriod(p);
    } catch {
      // Private window or blocked storage: the defaults stand.
    }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(CARD_FORMAT_KEY, format);
      localStorage.setItem(CARD_PERIOD_KEY, period);
    } catch {
      // Not remembered this time; nothing else depends on it.
    }
  }, [prefsLoaded, format, period]);
  const detailed = format === "detailed";
  // Either card runs one week or two. One week needs no subtotal: it would
  // only repeat the period total right beneath it.
  const showWeekTotals = detailed && period === "biweek";
  /** The paper card, drawn on screen in a window — Print without the printer. */
  const [previewOpen, setPreviewOpen] = useState(false);
  const [noteDay, setNoteDay] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteKind, setNoteKind] = useState<PeriodNoteKind>("note");
  const [noteHours, setNoteHours] = useState("");
  // The day-comment window keeps its own text, apart from the Notes form.
  const [commentText, setCommentText] = useState("");
  const [noteErr, setNoteErr] = useState<string | null>(null);
  // The day the card is built around; the period starts on the week-start day
  // on or before it. Kept as a day, not a week start, so the company's week
  // start arriving after the first render (it loads with the App rules) puts
  // today's week on screen. Re-aligning a Sunday anchor to a Monday rule used
  // to step back to the Monday before it — the week before this one.
  const [focusDay, setFocusDay] = useState<Date>(() => new Date());
  const anchor = useMemo(
    () => startOfWeek(focusDay, rules.week_start_day),
    [focusDay, rules.week_start_day],
  );
  const [selectedUser, setSelectedUser] = useState<string | "me">("me");
  const [editingDay, setEditingDay] = useState<Date | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  // Clearing a whole period is easy to regret, so it takes a tick and a click.
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeUnderstood, setWipeUnderstood] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [wipeWho, setWipeWho] = useState<"one" | "all">("one");
  const [wipeScope, setWipeScope] = useState<"day" | "period" | "month">("period");
  const [wipeDay, setWipeDay] = useState(() => toDayString(new Date()));
  const [wipeReason, setWipeReason] = useState("");
  const [wipeDone, setWipeDone] = useState<number | null>(null);

  // Arriving from a name on the dashboard: show that person's card for the week
  // holding the day, then open the day's editor once its punches are in.
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [openDayOnLoad, setOpenDayOnLoad] = useState<Date | null>(null);
  useEffect(() => {
    if (!isManager || !search.user || !search.day) return;
    const day = fromDayString(search.day);
    setSelectedUser(search.user);
    setFocusDay(day);
    setOpenDayOnLoad(day);
    // Spent once read, so a refresh or the back button doesn't reopen it.
    void navigate({ to: "/timecards", search: {}, replace: true });
  }, [isManager, search.user, search.day, navigate]);

  // Live refresh: any insert/update/delete on time_punches for this company refetches the timecard.
  useEffect(() => {
    if (!company?.id) return;
    const ch = supabase
      .channel(`timecards:${company.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "time_punches",
          filter: `company_id=eq.${company.id}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["timecards"] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [company?.id, qc]);

  const days = period === "week" ? 7 : 14;
  const rangeStart = anchor;
  const rangeEnd = addDays(anchor, days);
  // A shift counts on the day it was clocked in, so the fetch reaches past both
  // ends of the period: after it for the clock-out of a shift started on its
  // last night, before it to recognise the tail of one from the period before.
  // punchesInPeriod then keeps exactly this period's shifts.
  const fetchFrom = new Date(rangeStart.getTime() - MAX_SHIFT_MS).toISOString();
  const fetchTo = new Date(rangeEnd.getTime() + MAX_SHIFT_MS).toISOString();

  // Roster (managers only). A super admin belongs to no company but RLS lets
  // them read every profile and punch, so they get the whole platform rather
  // than an empty list — this page used to refuse them outright.
  const rosterQ = useQuery({
    queryKey: ["timecard-roster", isSuperAdmin ? "all" : company?.id],
    enabled: isManager && (isSuperAdmin || !!company?.id),
    queryFn: async () => {
      let q = supabase.from("company_members").select("id, full_name, position, company_id");
      q = isSuperAdmin ? q.not("company_id", "is", null) : q.eq("company_id", company!.id);
      const { data, error } = await q.order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  /**
   * The roster this screen works from, with the company's "keep the office off
   * the rosters" rule applied. Everything below reads this rather than the
   * query: the person picker, the roster-wide table, and which card opens by
   * default. A name hidden from the list but still reachable from the picker is
   * not hidden, it is just harder to find.
   */
  const roster = useMemo(
    () => staff.visible(rosterQ.data ?? [], (m) => m.id, "timecards"),
    [rosterQ.data, staff],
  );
  /** Each roster member's position pay rules, for the roster-wide totals. */
  const rulesOf = usePayRulesByMember();

  // Company names for the roster and the printed header. A company admin only
  // ever sees their own; a super admin spans several.
  const companiesQ = useQuery({
    queryKey: ["timecard-companies"],
    enabled: isSuperAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.from("companies").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Location names, for splitting hours by where they were worked. A company
  // with no locations gets no split at all: every hour would read "No location".
  const locationsQ = useQuery({
    queryKey: ["locations", isSuperAdmin ? "all" : company?.id, "names"],
    enabled: isSuperAdmin || !!company?.id,
    queryFn: async () => {
      let q = supabase.from("locations").select("id, name, company_id");
      if (!isSuperAdmin) q = q.eq("company_id", company!.id);
      const { data, error } = await q.order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const locations = locationsQ.data ?? [];
  const hasLocations = locations.length > 0;
  const locationName = (id: string | null) =>
    (id && locations.find((l) => l.id === id)?.name) || t("No location");
  const byLocationText = (lines: LocationHours[]) =>
    lines.map((l) => `${locationName(l.locationId)} ${fmtDecimal(l.workedMs)}`).join(" · ");
  /** Where one shift was worked: its place, or each place and its hours if it moved. */
  const shiftPlaces = (split: LocationHours[] | undefined, startLocation: string | null) =>
    split && split.length > 1 ? byLocationText(split) : locationName(startLocation);

  // A manager moving one stretch to another location. The database moves its
  // breaks and clock-out with it.
  const [locationErr, setLocationErr] = useState<string | null>(null);
  const moveLocation = useMutation({
    mutationFn: async ({ punchId, locationId }: { punchId: string; locationId: string | null }) => {
      const { error } = await supabase.rpc("set_punch_location", {
        _punch: punchId,
        _location: locationId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setLocationErr(null);
      void qc.invalidateQueries({ queryKey: ["timecards"] });
      void qc.invalidateQueries({ queryKey: ["timecards-all"] });
    },
    onError: (e: Error) => setLocationErr(e.message),
  });

  // "Me" is meaningless for a super admin — they have no punches of their own —
  // so fall back to the first person on the roster.
  /** The whole roster at once, rather than one card at a time. */
  const viewingAll = isManager && selectedUser === "all";
  // Which people are expanded to show their individual time cards.
  const [expanded, setExpanded] = useState<string[]>([]);

  const targetUserId = viewingAll
    ? undefined
    : !isManager || (selectedUser === "me" && !isSuperAdmin)
      ? user?.id
      : selectedUser === "me"
        ? roster[0]?.id
        : selectedUser;

  const punchesQ = useQuery<Punch[]>({
    queryKey: ["timecards", targetUserId, rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select(
          "id, user_id, kind, at, distance_m, within_geofence, break_minutes, latitude, longitude, location_id",
        )
        .eq("user_id", targetUserId!)
        .gte("at", fetchFrom)
        .lt("at", fetchTo)
        .order("at", { ascending: true });
      if (error) throw error;
      return punchesInPeriod((data ?? []) as Punch[], rangeStart, rangeEnd);
    },
  });

  // Late clock-ins, and clock-ins on no shift, read against the published
  // schedule. Both empty unless the company has connected the schedule to
  // time cards.
  // The pay rules on this person's position (paid lunch, a shift
  // differential), or null for the company's App rules — see `@/lib/pay-rules`.
  const payRules = usePayRulesFor(targetUserId);
  const paidMeals = payRules?.paid_meal_breaks ?? false;
  const diffRule = payRules?.diff_enabled ? payRules : null;
  const {
    late: lateness,
    unscheduled,
    shifts: scheduledShifts,
  } = useScheduleMarks(targetUserId, punchesQ.data, { from: rangeStart, to: rangeEnd });
  /**
   * The detailed card puts each day's published schedule beside its punches,
   * "Scheduled 9:00 AM – 5:00 PM", by the day each shift starts. Empty on the
   * simple card, and whenever the company has the schedule link off.
   */
  const scheduledByDay = useMemo(() => {
    const m = new Map<string, string>();
    if (!detailed) return m;
    const sorted = [...scheduledShifts].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    for (const s of sorted) {
      const key = toDayString(new Date(s.starts_at));
      const span = `${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}`;
      m.set(key, m.has(key) ? `${m.get(key)}, ${span}` : span);
    }
    for (const [k, v] of m) m.set(k, t("Scheduled {times}", { times: v }));
    return m;
  }, [detailed, scheduledShifts, t]);
  /** "Late 12m" or "Not scheduled" for a printed or exported line; null otherwise. */
  const lateText = (punchId: string) => {
    if (unscheduled.has(punchId)) return t("Not scheduled");
    const l = lateness.get(punchId);
    return l?.late ? t("Late {n}m", { n: l.minutesLate }) : null;
  };

  // Mid-shift location moves over the same stretch, so hours split by place.
  // Under the "timecards" key, so whatever refreshes the punches refreshes these.
  const movesQ = useQuery<LocationMove[]>({
    queryKey: [
      "timecards",
      "moves",
      targetUserId,
      rangeStart.toISOString(),
      rangeEnd.toISOString(),
    ],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("location_moves")
        .select("user_id, at, location_id")
        .eq("user_id", targetUserId!)
        .gte("at", fetchFrom)
        .lt("at", fetchTo)
        .order("at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  // The detailed card's notes for this person and period. Asked for only when
  // that card is on screen; a database without the table yet reads as an
  // error in the Notes panel, not a broken page.
  const periodFirstDay = toDayString(rangeStart);
  const periodLastDay = toDayString(addDays(rangeEnd, -1));
  const notesQ = useQuery<TimecardNote[]>({
    queryKey: ["timecard-notes", targetUserId, periodFirstDay, periodLastDay],
    enabled: !!targetUserId,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("timecard_notes")
        .select("id, note_date, note, author_name, created_at, kind, hours")
        .eq("user_id", targetUserId!)
        .gte("note_date", periodFirstDay)
        .lte("note_date", periodLastDay)
        .order("note_date", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
  const allNotes = notesQ.data;
  /** The Notes section at the foot of the card: period notes and OT slips. */
  const notes = useMemo(() => (allNotes ?? []).filter((n) => n.kind !== "day"), [allNotes]);
  /**
   * A supervisor's comments on each day, by "YYYY-MM-DD". They print on their
   * own day's line, on either card, and never in the Notes section.
   */
  const commentsByDay = useMemo(() => {
    const m = new Map<string, TimecardNote[]>();
    for (const n of allNotes ?? [])
      if (n.kind === "day") m.set(n.note_date, [...(m.get(n.note_date) ?? []), n]);
    return m;
  }, [allNotes]);
  const noteKindLabel = (n: TimecardNote) => t(NOTE_KIND_LABEL[n.kind] ?? "Note");
  /** "8.00 hrs" for an OT slip; empty otherwise. */
  const noteHoursText = (n: TimecardNote) =>
    n.hours != null ? `${Number(n.hours).toFixed(2)} ${t("hrs")}` : "";
  /** Comment text as it reads on the card's Notes column. */
  const quoted = (n: TimecardNote) => `“${n.note}”`;
  // The day whose comments window is open.
  const [commentDay, setCommentDay] = useState<string | null>(null);
  function openComments(day: Date) {
    const key = toDayString(day);
    setCommentDay(key);
    setCommentText("");
    setNoteErr(null);
  }

  // Approved days off in the period, whichever way they were entered: asked
  // for on the Time off page and approved, or marked here by an admin.
  const absencesQ = useQuery<Absence[]>({
    queryKey: ["timecard-absences", targetUserId, periodFirstDay, periodLastDay],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, kind, start_date, end_date, note")
        .eq("employee_id", targetUserId!)
        .eq("status", "approved")
        .lte("start_date", periodLastDay)
        .gte("end_date", periodFirstDay)
        .order("start_date", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
  /** Each day of the period that falls in an absence, by its "YYYY-MM-DD". */
  const absenceByDay = useMemo(() => {
    const m = new Map<string, Absence>();
    for (const a of absencesQ.data ?? []) {
      for (let d = fromDayString(a.start_date); toDayString(d) <= a.end_date; d = addDays(d, 1)) {
        const key = toDayString(d);
        if (key >= periodFirstDay && key <= periodLastDay && !m.has(key)) m.set(key, a);
      }
    }
    return m;
  }, [absencesQ.data, periodFirstDay, periodLastDay]);
  const absenceLabel = (a: Absence) => t(ABSENCE_LABEL[a.kind] ?? "Day off");
  /** "Sick 1 day · Vacation 2 days" — the period's days off, by kind. */
  const absenceSummary = useMemo(() => {
    const count = new Map<string, number>();
    for (const a of absenceByDay.values()) count.set(a.kind, (count.get(a.kind) ?? 0) + 1);
    // The usual kinds in their usual order, then anything else on file.
    const order: string[] = [...ABSENCE_KINDS, ...count.keys()];
    return [...new Set(order)]
      .filter((k) => count.has(k))
      .map((k) => ({ label: t(ABSENCE_LABEL[k] ?? "Day off"), days: count.get(k)! }));
  }, [absenceByDay, t]);
  const daysText = (n: number) => (n === 1 ? t("1 day") : t("{n} days", { n }));

  // The "Mark absence" window, opened from a day's row.
  const [absenceDay, setAbsenceDay] = useState<string | null>(null);
  const [absenceKind, setAbsenceKind] = useState<string>("sick");
  const [absenceEnd, setAbsenceEnd] = useState("");
  const [absenceNote, setAbsenceNote] = useState("");
  const [absenceErr, setAbsenceErr] = useState<string | null>(null);
  function openAbsence(day: Date) {
    const key = toDayString(day);
    setAbsenceDay(key);
    setAbsenceKind("sick");
    setAbsenceEnd(key);
    setAbsenceNote("");
    setAbsenceErr(null);
  }
  const recordAbsence = useMutation({
    mutationFn: async () => {
      if (!targetUserId || !absenceDay) throw new Error(t("Pick an employee first."));
      const { error } = await supabase.rpc("manager_record_absence", {
        _employee: targetUserId,
        _kind: absenceKind,
        _start: absenceDay,
        _end: absenceEnd && absenceEnd >= absenceDay ? absenceEnd : absenceDay,
        _note: absenceNote.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setAbsenceDay(null);
      void qc.invalidateQueries({ queryKey: ["timecard-absences"] });
    },
    onError: (e: Error) => setAbsenceErr(e.message),
  });
  const removeAbsence = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("manager_remove_absence", { _request: id });
      if (error) throw error;
    },
    onSuccess: () => {
      setAbsenceDay(null);
      void qc.invalidateQueries({ queryKey: ["timecard-absences"] });
    },
    onError: (e: Error) => setAbsenceErr(e.message),
  });

  const addNote = useMutation({
    mutationFn: async (v: {
      kind: "day" | PeriodNoteKind;
      day: string;
      text: string;
      hours?: string;
    }) => {
      const noteCompany =
        roster.find((m) => m.id === targetUserId)?.company_id ?? company?.id ?? null;
      if (!targetUserId || !noteCompany) throw new Error(t("Pick an employee first."));
      const { error } = await supabase.from("timecard_notes").insert({
        company_id: noteCompany,
        user_id: targetUserId,
        note_date:
          v.day && v.day >= periodFirstDay && v.day <= periodLastDay ? v.day : periodFirstDay,
        note: v.text.trim(),
        kind: v.kind,
        hours: v.kind === "ot_slip" && v.hours ? Number(v.hours) : null,
        author_name: profile?.full_name || user?.email || "",
      });
      if (error) throw error;
    },
    onSuccess: (_, v) => {
      if (v.kind === "day") setCommentText("");
      else {
        setNoteText("");
        setNoteHours("");
      }
      setNoteErr(null);
      void qc.invalidateQueries({ queryKey: ["timecard-notes"] });
    },
    onError: (e: Error) => setNoteErr(e.message),
  });

  const deleteNote = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("timecard_notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setNoteErr(null);
      void qc.invalidateQueries({ queryKey: ["timecard-notes"] });
    },
    onError: (e: Error) => setNoteErr(e.message),
  });

  // Everyone's punches for the period, for the roster-wide view. Only a
  // manager can read another person's punches, so this stays off for employees
  // rather than returning their own rows and reading as "nobody worked".
  const allQ = useQuery({
    queryKey: ["timecards-all", rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: viewingAll,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select("user_id, kind, at, break_minutes, location_id")
        .gte("at", fetchFrom)
        .lt("at", fetchTo)
        .order("at", { ascending: true });
      if (error) throw error;
      return punchesInPeriod((data ?? []) as SimplePunch[], rangeStart, rangeEnd);
    },
  });

  const allMovesQ = useQuery<LocationMove[]>({
    queryKey: ["timecards-all", "moves", rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: viewingAll,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("location_moves")
        .select("user_id, at, location_id")
        .gte("at", fetchFrom)
        .lt("at", fetchTo)
        .order("at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  /** One line per person: their days, breaks, hours and overtime split. */
  const everyone = useMemo(() => {
    if (!viewingAll) return [];
    const totals = totalsByPerson(
      allQ.data ?? [],
      rules.punch_round_minutes,
      rules.cap_break_to_length,
      allMovesQ.data ?? [],
      (id) => rulesOf(id)?.paid_meal_breaks ?? false,
    );
    return roster
      .map((m) => {
        const tot = totals.get(m.id) ?? {
          grossMs: 0,
          workedMs: 0,
          unpaidMs: 0,
          paidMs: 0,
          dayTotals: [],
          days: [],
          incompleteBreaks: 0,
          overBreakMs: 0,
          byLocation: [],
        };
        const split = splitPeriod(tot.dayTotals, rules, period === "week");
        return {
          id: m.id,
          name: m.full_name || t("Unnamed"),
          position: m.position ?? null,
          daysWorked: tot.dayTotals.filter((ms) => ms > 0).length,
          // One time card per clock-in, which is what the count column means.
          cardCount: tot.days.reduce((n, d) => n + d.spans.length, 0),
          ...tot,
          ...split,
        };
      })
      .sort((a, b) => b.workedMs - a.workedMs || a.name.localeCompare(b.name));
  }, [viewingAll, allQ.data, allMovesQ.data, roster, rules, period, t, rulesOf]);

  /** Everyone's paid time per location, for the foot of the roster-wide table. */
  const everyoneByLocation = useMemo(() => {
    const sum = new Map<string | null, number>();
    for (const r of everyone)
      for (const l of r.byLocation)
        sum.set(l.locationId, (sum.get(l.locationId) ?? 0) + l.workedMs);
    return [...sum]
      .map(([locationId, workedMs]) => ({ locationId, workedMs }))
      .sort((a, b) => b.workedMs - a.workedMs);
  }, [everyone]);

  /** Every punch on screen for this person, deleted in one go. */
  /** Whose punches are being cleared — a super admin has no company of their own. */
  const wipeCompanyId =
    company?.id ?? roster.find((m) => m.id === targetUserId)?.company_id ?? null;

  /** Start and end of whatever the delete dialog is pointed at. */
  const wipeRange = useMemo(() => {
    if (wipeScope === "day") {
      const from = fromDayString(wipeDay);
      return { from, to: addDays(from, 1) };
    }
    if (wipeScope === "month") {
      const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      return { from, to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) };
    }
    return { from: rangeStart, to: rangeEnd };
  }, [wipeScope, wipeDay, anchor, rangeStart, rangeEnd]);

  // How many punches that range holds, so nobody deletes blind.
  const wipeCountQ = useQuery({
    queryKey: [
      "timecards-wipe-count",
      wipeCompanyId,
      wipeWho === "one" ? targetUserId : "all",
      wipeRange.from.toISOString(),
      wipeRange.to.toISOString(),
    ],
    enabled: wipeOpen && !!wipeCompanyId,
    queryFn: async () => {
      let q = supabase
        .from("time_punches")
        .select("id", { count: "exact", head: true })
        .eq("company_id", wipeCompanyId!)
        .gte("at", wipeRange.from.toISOString())
        .lt("at", wipeRange.to.toISOString());
      if (wipeWho === "one" && targetUserId) q = q.eq("user_id", targetUserId);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });

  /**
   * Deleting goes through manager_delete_punch_range: `authenticated` may only
   * read and insert punches, and every removal is recorded with a reason.
   */
  const wipePeriod = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("manager_delete_punch_range", {
        _company: wipeCompanyId!,
        _user: wipeWho === "one" ? (targetUserId ?? null) : null,
        _from: wipeRange.from.toISOString(),
        _to: wipeRange.to.toISOString(),
        _reason: wipeReason.trim(),
      });
      if (error) throw error;
      return (data as unknown as number) ?? 0;
    },
    onSuccess: (n) => {
      setWipeDone(n);
      setWipeUnderstood(false);
      void qc.invalidateQueries({ queryKey: ["timecards"] });
      void qc.invalidateQueries({ queryKey: ["timecards-all"] });
      void qc.invalidateQueries({ queryKey: ["timecards-wipe-count"] });
    },
    onError: (e: Error) => setWipeError(e.message),
  });

  const grouped = useMemo(() => {
    // By the day each shift was clocked in on: one that runs past midnight is
    // counted whole on its first day, clock-out and all.
    const byDay = groupByShiftDay(punchesQ.data ?? []);
    type Pair = {
      in: Punch;
      out?: Punch;
      unpaidBreakMs: number;
      paidBreakMs: number;
      /** Breaks they came back from early — the shift is flagged, not docked. */
      incompleteBreaks: number;
      /** Break time run past the picked length, which the shift was not charged. */
      overBreakMs: number;
      /** Hours worked inside the position's differential window. */
      diffMs: number;
    };
    const rows: {
      date: Date;
      punches: Punch[];
      pairs: Pair[];
      totalMs: number;
      unpaidBreakMs: number;
      paidBreakMs: number;
      incompleteBreaks: number;
      overBreakMs: number;
      diffMs: number;
    }[] = [];
    let weekTotal = 0;
    let periodDiff = 0;
    let weekUnpaid = 0;
    let weekPaid = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(rangeStart, i);
      const list = byDay.get(d.toDateString()) ?? [];
      // The hours are counted from the rounded reading of the day, so the
      // times printed on the card are the times that were paid. `list` stays
      // raw: it is what the day editor opens, and a manager correcting a punch
      // must see what the clock recorded.
      const counted = roundPunches(list, rules.punch_round_minutes);
      const pairs: Pair[] = [];
      let totalMs = 0;
      let dayUnpaidMs = 0;
      let dayPaidMs = 0;
      let openIn: Punch | null = null;
      let openBreak: Punch | null = null;
      let currentUnpaid = 0;
      let currentPaid = 0;
      let currentShort = 0;
      let currentOver = 0;
      let dayShort = 0;
      let dayOver = 0;
      let dayDiff = 0;
      // Unpaid breaks as charged, for taking them out of the differential.
      let currentBreaks: { startMs: number; ms: number }[] = [];
      const openPair = (i: Punch, o?: Punch, diffMs = 0): Pair => ({
        in: i,
        out: o,
        unpaidBreakMs: currentUnpaid,
        paidBreakMs: currentPaid,
        incompleteBreaks: currentShort,
        overBreakMs: currentOver,
        diffMs,
      });
      for (const p of counted) {
        if (p.kind === "in") {
          if (openIn) pairs.push(openPair(openIn));
          openIn = p;
          currentUnpaid = 0;
          currentPaid = 0;
          currentShort = 0;
          currentOver = 0;
          currentBreaks = [];
          openBreak = null;
        } else if (p.kind === "out") {
          if (openIn) {
            const gross = new Date(p.at).getTime() - new Date(openIn.at).getTime();
            const net = Math.max(0, gross - currentUnpaid);
            const diff = diffRule
              ? differentialMs(
                  {
                    inMs: new Date(openIn.at).getTime(),
                    outMs: new Date(p.at).getTime(),
                    unpaidBreaks: currentBreaks,
                  },
                  diffRule.diff_start,
                  diffRule.diff_end,
                )
              : 0;
            pairs.push(openPair(openIn, p, diff));
            totalMs += net;
            dayDiff += diff;
            currentBreaks = [];
            dayUnpaidMs += currentUnpaid;
            dayPaidMs += currentPaid;
            dayShort += currentShort;
            dayOver += currentOver;
            openIn = null;
            currentUnpaid = 0;
            currentPaid = 0;
            currentShort = 0;
            currentOver = 0;
            openBreak = null;
          }
        } else if (p.kind === "break_start") {
          if (openIn && !openBreak) openBreak = p;
        } else if (p.kind === "break_end") {
          if (openBreak) {
            // One rule, one place: the same reading the roster-wide totals use.
            const read = readBreak(
              new Date(p.at).getTime() - new Date(openBreak.at).getTime(),
              openBreak.break_minutes,
              rules.cap_break_to_length,
              paidMeals,
            );
            if (read.paid) currentPaid += read.countedMs;
            else {
              currentUnpaid += read.countedMs;
              currentBreaks.push({ startMs: new Date(openBreak.at).getTime(), ms: read.countedMs });
            }
            if (read.incomplete) currentShort += 1;
            currentOver += read.overMs;
            openBreak = null;
          }
        }
      }
      if (openIn) {
        pairs.push(openPair(openIn));
        dayShort += currentShort;
        dayOver += currentOver;
      }
      rows.push({
        date: d,
        punches: list,
        pairs,
        incompleteBreaks: dayShort,
        overBreakMs: dayOver,
        totalMs,
        unpaidBreakMs: dayUnpaidMs,
        paidBreakMs: dayPaidMs,
        diffMs: dayDiff,
      });
      weekTotal += totalMs;
      periodDiff += dayDiff;
      weekUnpaid += dayUnpaidMs;
      weekPaid += dayPaidMs;
    }
    // Paid time per location, by the same rules as the roster-wide view: each
    // shift split at the moves made during it. `splits` is each shift's own
    // split, keyed by its (rounded) clock-in, which is how the pairs read it.
    const person = targetUserId
      ? totalsByPerson(
          punchesQ.data ?? [],
          rules.punch_round_minutes,
          rules.cap_break_to_length,
          movesQ.data ?? [],
          () => paidMeals,
        ).get(targetUserId)
      : undefined;
    const byLocation = person?.byLocation ?? [];
    const splits = new Map(
      (person?.days ?? []).flatMap((d) => d.spans).map((sp) => [sp.inAt, sp.byLocation] as const),
    );
    // Seven days at a time, for the detailed card's per-week subtotals.
    const weeks: {
      workedMs: number;
      unpaidBreakMs: number;
      paidBreakMs: number;
      diffMs: number;
    }[] = [];
    for (let w = 0; w * 7 < rows.length; w++) {
      const slice = rows.slice(w * 7, w * 7 + 7);
      weeks.push({
        workedMs: slice.reduce((n, r) => n + r.totalMs, 0),
        unpaidBreakMs: slice.reduce((n, r) => n + r.unpaidBreakMs, 0),
        paidBreakMs: slice.reduce((n, r) => n + r.paidBreakMs, 0),
        diffMs: slice.reduce((n, r) => n + r.diffMs, 0),
      });
    }
    return { rows, weekTotal, weekUnpaid, weekPaid, periodDiff, byLocation, splits, weeks };
  }, [
    punchesQ.data,
    movesQ.data,
    targetUserId,
    rangeStart,
    days,
    rules.punch_round_minutes,
    rules.cap_break_to_length,
    paidMeals,
    diffRule,
  ]);

  // The day asked for from the dashboard, opened once that card has loaded —
  // before then the editor would show the day as having no punches.
  useEffect(() => {
    if (!openDayOnLoad || targetUserId !== selectedUser) return;
    if (!punchesQ.isSuccess || punchesQ.isFetching) return;
    setEditingDay(openDayOnLoad);
    setOpenDayOnLoad(null);
  }, [openDayOnLoad, targetUserId, selectedUser, punchesQ.isSuccess, punchesQ.isFetching]);

  // Managers only: every punch in view that carries coordinates, newest first.
  const locationRows = useMemo(
    () =>
      (punchesQ.data ?? [])
        .filter((p) => p.latitude != null && p.longitude != null)
        .slice()
        .reverse(),
    [punchesQ.data],
  );

  function nav(dir: -1 | 1) {
    setFocusDay((d) => addDays(d, dir * days));
  }

  /**
   * Flattens the same day/shift structure the printed document renders: the
   * date and the day's total sit on the day's first row, extra shifts hang
   * beneath. Kept next to the PDF call so the two can't drift.
   */
  function buildTimecardPdfData() {
    const HOUR = 3_600_000;
    const dec = (ms: number) => (ms / HOUR).toFixed(2);
    /** The detailed card closes each week with a subtotal line. */
    const weekRow = (dayIndex: number) => {
      if (!showWeekTotals || (dayIndex + 1) % 7 !== 0) return [];
      const w = grouped.weeks[Math.floor(dayIndex / 7)];
      if (!w) return [];
      return [
        {
          date: t("Week {n} total", { n: Math.floor(dayIndex / 7) + 1 }),
          clockIn: "",
          clockOut: "",
          unpaid: fmtHours(w.unpaidBreakMs),
          paid: fmtHours(w.paidBreakMs),
          hours: fmtHours(w.workedMs),
          notes: `${dec(w.workedMs)} ${t("hrs")}`,
          subtotal: true,
        },
      ];
    };
    const dayRows = (r: (typeof grouped.rows)[number]) => {
      if (r.pairs.length === 0) {
        return [
          {
            date: fmtDate(r.date),
            clockIn: "—",
            clockOut: "—",
            unpaid: "—",
            paid: "—",
            hours: "0h 00m",
            scheduled: scheduledByDay.get(toDayString(r.date)) ?? undefined,
            notes: [
              absenceByDay.has(toDayString(r.date))
                ? absenceLabel(absenceByDay.get(toDayString(r.date))!)
                : t("No punches"),
              ...(commentsByDay.get(toDayString(r.date)) ?? []).map(quoted),
            ]
              .filter(Boolean)
              .join(" · "),
          },
        ];
      }
      const off = absenceByDay.get(toDayString(r.date));
      return r.pairs.map((p, i) => ({
        date: i === 0 ? fmtDate(r.date) : "",
        scheduled: i === 0 ? (scheduledByDay.get(toDayString(r.date)) ?? undefined) : undefined,
        clockIn: fmtTime(p.in.at, rules.punch_round_minutes),
        clockOut: p.out ? fmtTime(p.out.at, rules.punch_round_minutes) : "—",
        unpaid: p.unpaidBreakMs > 0 ? fmtHours(p.unpaidBreakMs) : "—",
        paid: p.paidBreakMs > 0 ? fmtHours(p.paidBreakMs) : "—",
        hours: i === 0 ? fmtHours(r.totalMs) : "",
        notes: [
          i === 0 && off ? absenceLabel(off) : null,
          ...(i === 0 ? (commentsByDay.get(toDayString(r.date)) ?? []).map(quoted) : []),
          hasLocations ? shiftPlaces(grouped.splits.get(p.in.at), p.in.location_id) : null,
          lateText(p.in.id),
          diffRule && p.diffMs > 0 ? `${diffRule.diff_label} ${fmtHours(p.diffMs)}` : null,
          !p.out ? t("Still clocked in") : null,
          // Where someone punched from is a manager's business; an employee's
          // own timecard is about their hours.
          isManager && (!p.in.within_geofence || (p.out && !p.out.within_geofence))
            ? t("Off-site punch")
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
      }));
    };
    const rows = grouped.rows.flatMap((r, dayIndex) => [...dayRows(r), ...weekRow(dayIndex)]);

    const { regularMs, overtimeMs, doubleTimeMs } = splitPeriod(
      grouped.rows.map((r) => r.totalMs),
      rules,
      period === "week",
    );
    const lastDay = addDays(rangeEnd, -1);

    return {
      companyName: employeeCompanyName,
      employeeName,
      position: employeePosition,
      periodLabel: period === "week" ? t("Weekly") : t("Bi-weekly"),
      title: detailed ? t("Detailed time card") : t("Employee timecard"),
      notes: detailed
        ? notes.map((n) => ({
            date: fmtDate(fromDayString(n.note_date)),
            type: noteKindLabel(n),
            hours: noteHoursText(n),
            note: n.note,
            author: n.author_name || "—",
            created: new Date(n.created_at).toLocaleString(localeTag(), {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
          }))
        : null,
      rangeLabel: `${rangeStart.toLocaleDateString(localeTag(), { month: "long", day: "numeric", year: "numeric" })} – ${lastDay.toLocaleDateString(localeTag(), { month: "long", day: "numeric", year: "numeric" })}`,
      daysWorked: grouped.rows.filter((r) => r.pairs.length > 0).length,
      rows,
      totals: {
        unpaid: fmtHours(grouped.weekUnpaid),
        paid: fmtHours(grouped.weekPaid),
        worked: fmtHours(grouped.weekTotal),
        workedDecimal: dec(grouped.weekTotal),
      },
      regular: fmtHours(regularMs),
      regularDecimal: dec(regularMs),
      overtime: overtimeMs > 0 ? fmtHours(overtimeMs) : null,
      overtimeDecimal: overtimeMs > 0 ? dec(overtimeMs) : null,
      doubleTime: doubleTimeMs > 0 ? fmtHours(doubleTimeMs) : null,
      doubleTimeDecimal: doubleTimeMs > 0 ? dec(doubleTimeMs) : null,
      differential:
        diffRule && grouped.periodDiff > 0
          ? {
              label: diffRule.diff_label,
              hours: fmtHours(grouped.periodDiff),
              decimal: dec(grouped.periodDiff),
            }
          : null,
      byLocation: hasLocations
        ? grouped.byLocation.map((l) => ({
            name: locationName(l.locationId),
            hours: fmtHours(l.workedMs),
            decimal: dec(l.workedMs),
          }))
        : [],
      overtimeNote: overtimeNote(rules, period === "week"),
      absences: absenceSummary.map((a) => ({ label: a.label, days: daysText(a.days) })),
      roundNote: `${rules.punch_round_minutes > 0 ? t("Punch times and hours rounded to the nearest {n} minutes.", { n: rules.punch_round_minutes }) : t("Punch times shown as recorded.")} ${t("Unpaid break time is deducted from hours worked; paid break time is not.")}`,
      filename: `${detailed ? "detailed-timecard" : "timecard"}-${employeeName.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "")}-${rangeStart.toISOString().slice(0, 10)}.pdf`,
    };
  }

  async function downloadTimecard() {
    setSavingPdf(true);
    try {
      const { downloadTimecardPdf } = await import("@/lib/pdf");
      await downloadTimecardPdf(buildTimecardPdfData());
    } finally {
      setSavingPdf(false);
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  // A super admin has no company of their own but can read every timecard.
  if (!company && !isSuperAdmin)
    return (
      <div className="text-sm text-muted-foreground">{t("Join a company to view timecards.")}</div>
    );

  // Whose card is on screen — the roster row when a manager has picked someone,
  // otherwise the signed-in user's own profile.
  const viewing = roster.find((m) => m.id === targetUserId);
  const isSelf = targetUserId === user?.id;
  const employeeName =
    (isSelf ? profile?.full_name : viewing?.full_name) ||
    viewing?.full_name ||
    user?.email ||
    t("Employee");
  const employeePosition = isSelf ? profile?.position : viewing?.position;
  // The printed header names the employee's company, which for a super admin is
  // whichever company the person they picked belongs to — not their own.
  const employeeCompanyName =
    (isSelf
      ? company?.name
      : (companiesQ.data ?? []).find((c) => c.id === viewing?.company_id)?.name) ??
    company?.name ??
    "Scheduling Pilot";

  /** The paper card, once: what the printer gets and what Preview shows. */
  const printableProps: PrintableTimecardProps = {
    format,
    weekTotals: showWeekTotals ? grouped.weeks : [],
    notes: notes.map((n) => ({
      day: n.note_date,
      type: noteKindLabel(n),
      hours: noteHoursText(n),
      note: n.note,
      author: n.author_name,
      createdAt: n.created_at,
    })),
    companyName: employeeCompanyName,
    employeeName,
    position: employeePosition,
    periodLabel: period === "week" ? t("Weekly") : t("Bi-weekly"),
    rangeStart,
    rangeEnd,
    absences: absenceSummary.map((a) => ({ label: a.label, days: daysText(a.days) })),
    days: grouped.rows.map((r) => ({
      date: r.date,
      totalMs: r.totalMs,
      absence: absenceByDay.has(toDayString(r.date))
        ? absenceLabel(absenceByDay.get(toDayString(r.date))!)
        : null,
      comments: (commentsByDay.get(toDayString(r.date)) ?? []).map(quoted),
      scheduled: scheduledByDay.get(toDayString(r.date)) ?? null,
      pairs: r.pairs.map((p) => ({
        inAt: p.in.at,
        outAt: p.out?.at ?? null,
        unpaidBreakMs: p.unpaidBreakMs,
        paidBreakMs: p.paidBreakMs,
        offSite: isManager && (!p.in.within_geofence || (!!p.out && !p.out.within_geofence)),
        late: lateText(p.in.id),
        diff: diffRule && p.diffMs > 0 ? `${diffRule.diff_label} ${fmtHours(p.diffMs)}` : null,
        location: hasLocations ? shiftPlaces(grouped.splits.get(p.in.at), p.in.location_id) : null,
      })),
    })),
    totals: {
      workedMs: grouped.weekTotal,
      unpaidBreakMs: grouped.weekUnpaid,
      paidBreakMs: grouped.weekPaid,
    },
    split: splitPeriod(
      grouped.rows.map((r) => r.totalMs),
      rules,
      period === "week",
    ),
    differential:
      diffRule && grouped.periodDiff > 0
        ? { label: diffRule.diff_label, ms: grouped.periodDiff }
        : null,
    byLocation: hasLocations
      ? grouped.byLocation.map((l) => ({ name: locationName(l.locationId), ms: l.workedMs }))
      : [],
    overtimeNote: overtimeNote(rules, period === "week"),
    roundMinutes: rules.punch_round_minutes,
    formatTime: (iso) => fmtTime(iso, rules.punch_round_minutes),
    formatHours: fmtHours,
  };

  return (
    <>
      <PrintableTimecard {...printableProps} />

      {/* The same page the printer gets, on screen. Hidden from print itself so
          printing with it open still yields one copy. */}
      <Dialog open={!!commentDay} onOpenChange={(o) => !o && setCommentDay(null)}>
        <DialogContent data-print-hide className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Comments")}</DialogTitle>
            <DialogDescription>
              {employeeName}
              {commentDay ? ` · ${fmtDate(fromDayString(commentDay))}` : ""}
            </DialogDescription>
          </DialogHeader>
          {commentDay && (commentsByDay.get(commentDay) ?? []).length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border text-sm">
              {(commentsByDay.get(commentDay) ?? []).map((n) => (
                <li key={n.id} className="flex items-start gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-foreground">{n.note}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {n.author_name || "—"} ·{" "}
                      {new Date(n.created_at).toLocaleString(localeTag(), {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground hover:text-destructive"
                    disabled={deleteNote.isPending}
                    onClick={() => deleteNote.mutate(n.id)}
                    aria-label={t("Delete note")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (commentText.trim() && commentDay)
                addNote.mutate({ kind: "day", day: commentDay, text: commentText });
            }}
          >
            <Label htmlFor="day-comment" className="text-xs">
              {t("Add a comment")}
            </Label>
            <Textarea
              id="day-comment"
              rows={3}
              maxLength={1000}
              placeholder={t("e.g. Covered the downtown route; left early with approval")}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "Comments show on this day of the time card, on screen and printed. The employee can read them.",
              )}
            </p>
            {noteErr && <p className="text-xs text-destructive">{noteErr}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCommentDay(null)}>
                {t("Close")}
              </Button>
              <Button type="submit" disabled={!commentText.trim() || addNote.isPending}>
                {addNote.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Add comment")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!absenceDay} onOpenChange={(o) => !o && setAbsenceDay(null)}>
        <DialogContent data-print-hide className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Mark an absence")}</DialogTitle>
            <DialogDescription>
              {employeeName}
              {absenceDay ? ` · ${fmtDate(fromDayString(absenceDay))}` : ""}
            </DialogDescription>
          </DialogHeader>
          {absenceDay && absenceByDay.has(absenceDay) ? (
            (() => {
              const a = absenceByDay.get(absenceDay)!;
              return (
                <div className="space-y-3 text-sm">
                  <p>
                    <span className="font-medium">{absenceLabel(a)}</span>{" "}
                    <span className="text-muted-foreground">
                      {a.start_date === a.end_date
                        ? fmtDate(fromDayString(a.start_date))
                        : `${fmtDate(fromDayString(a.start_date))} – ${fmtDate(fromDayString(a.end_date))}`}
                    </span>
                  </p>
                  {a.note && <p className="text-muted-foreground">{a.note}</p>}
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Removing it takes every day of it off the time card. Shifts it opened stay open.",
                    )}
                  </p>
                  {absenceErr && <p className="text-xs text-destructive">{absenceErr}</p>}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setAbsenceDay(null)}>
                      {t("Close")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={removeAbsence.isPending}
                      onClick={() => removeAbsence.mutate(a.id)}
                    >
                      {removeAbsence.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t("Remove absence")}
                    </Button>
                  </DialogFooter>
                </div>
              );
            })()
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                recordAbsence.mutate();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="absence-kind">{t("Type")}</Label>
                <select
                  id="absence-kind"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                  value={absenceKind}
                  onChange={(e) => setAbsenceKind(e.target.value)}
                >
                  {ABSENCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(ABSENCE_LABEL[k])}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="absence-end">{t("Through")}</Label>
                <Input
                  id="absence-end"
                  type="date"
                  min={absenceDay ?? undefined}
                  value={absenceEnd}
                  onChange={(e) => setAbsenceEnd(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Leave it on the same day for a single day off.")}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="absence-note">{t("Note (optional)")}</Label>
                <Textarea
                  id="absence-note"
                  rows={2}
                  maxLength={500}
                  placeholder={t("e.g. Called in sick at 7am")}
                  value={absenceNote}
                  onChange={(e) => setAbsenceNote(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "It is approved right away and shows on the Time off page too. Any upcoming shifts on these days become open shifts.",
                )}
              </p>
              {absenceErr && <p className="text-xs text-destructive">{absenceErr}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAbsenceDay(null)}>
                  {t("Cancel")}
                </Button>
                <Button type="submit" disabled={recordAbsence.isPending}>
                  {recordAbsence.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("Save")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        {/* The header stays put and only the page scrolls, so the window's
            close button (drawn over the header) never scrolls away. */}
        <DialogContent
          data-print-hide
          className="flex max-h-[92vh] max-w-[8.5in] flex-col gap-0 overflow-hidden p-0"
        >
          <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 space-y-0 border-b border-border bg-background px-4 py-3 pr-12">
            <div>
              <DialogTitle>{t("Preview")}</DialogTitle>
              <DialogDescription>
                {detailed ? t("Detailed time card") : t("Simple time card")} ·{" "}
                {period === "week" ? t("Weekly") : t("Bi-weekly")}
              </DialogDescription>
            </div>
            {!isNativeApp() && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  // Close first: the browser prints what is on the page, and
                  // the window would otherwise sit over the card.
                  setPreviewOpen(false);
                  setTimeout(() => window.print(), 150);
                }}
              >
                <Printer className="mr-2 h-4 w-4" />
                {t("Print")}
              </Button>
            )}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto bg-neutral-200 p-3 sm:p-6">
            <div className="mx-auto bg-white p-4 shadow-md sm:p-[0.5in]">
              <PrintableTimecard {...printableProps} onScreen />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div data-print-hide className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t("Timecards")}</h1>
            <p className="text-sm text-muted-foreground">
              {period === "week" ? t("Weekly totals") : t("Bi-weekly totals")} ·{" "}
              {fmtDate(rangeStart)} – {fmtDate(addDays(rangeEnd, -1))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/timeclock">
                <Clock className="mr-2 h-4 w-4" />
                {t("Time clock")}
              </Link>
            </Button>
            {/* Both produce the same document — see PrintableTimecard. Print goes
              through the browser dialog (where Save as PDF lives); Download
              saves the same page as a self-contained file. */}
            {/* The apps' web view cannot print; their Download PDF opens the share
              sheet, which has Print in it. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewOpen(true)}
              title={t("See the time card as it will print")}
            >
              <Eye className="mr-2 h-4 w-4" />
              {t("Preview")}
            </Button>
            {!isNativeApp() && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.print()}
                title={t("Send to a printer, or choose “Save as PDF”")}
              >
                <Printer className="mr-2 h-4 w-4" />
                {t("Print")}
              </Button>
            )}
            {isManager && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => {
                  setWipeError(null);
                  setWipeUnderstood(false);
                  setWipeDone(null);
                  setWipeReason("");
                  setWipeWho(viewingAll ? "all" : "one");
                  setWipeScope("period");
                  setWipeOpen(true);
                }}
                title={t("Delete timecards for a day, this period, or the whole month")}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("Delete timecards")}
              </Button>
            )}
            <Button
              size="sm"
              onClick={downloadTimecard}
              disabled={savingPdf}
              title={t("Saves a PDF straight to your downloads")}
            >
              {savingPdf ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t("Download PDF")}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
          <div
            className="inline-flex rounded-md border border-border p-0.5"
            role="group"
            aria-label={t("Time card format")}
          >
            <button
              className={`px-3 py-1 text-xs font-medium rounded ${!detailed ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => setFormat("simple")}
              aria-pressed={!detailed}
              title={t("Weekly or bi-weekly hours, as a plain list")}
            >
              {t("Simple time card")}
            </button>
            <button
              className={`px-3 py-1 text-xs font-medium rounded ${detailed ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => setFormat("detailed")}
              aria-pressed={detailed}
              title={t("Adds a notes section, and a total for each week on a bi-weekly card")}
            >
              {t("Detailed time card")}
            </button>
          </div>
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              className={`px-3 py-1 text-xs font-medium rounded ${period === "week" ? "bg-primary text-primary-foreground" : "text-muted-foreground"} disabled:opacity-40`}
              onClick={() => setPeriod("week")}
            >
              {t("Weekly")}
            </button>
            <button
              className={`px-3 py-1 text-xs font-medium rounded ${period === "biweek" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              onClick={() => setPeriod("biweek")}
            >
              {t("Bi-weekly")}
            </button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => nav(-1)}
              aria-label={t("Previous")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setFocusDay(new Date())}>
              {period === "week" ? t("This week") : t("This 2-week")}
            </Button>
            <Button variant="outline" size="icon" onClick={() => nav(1)} aria-label={t("Next")}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {isManager && (
            <div className="flex w-full items-center gap-2 border-t border-border pt-3 sm:w-auto sm:border-0 sm:pt-0">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <label
                htmlFor="timecard-employee"
                className="shrink-0 text-sm font-medium text-foreground"
              >
                {t("Employee")}
              </label>
              <select
                id="timecard-employee"
                className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
              >
                <option value="all">{t("All employees")}</option>
                {!isSuperAdmin && (
                  <option value="me">
                    {t("Me ({name})", { name: profile?.full_name || user?.email || "" })}
                  </option>
                )}
                {roster
                  .filter((m) => m.id !== user?.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name || t("Unnamed")}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>

        {/* A failed query used to render as an ordinary empty timecard, which is
          indistinguishable from an employee who simply didn't work. Say so. */}
        {(rosterQ.error || punchesQ.error) && (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">{t("Couldn't load this timecard")}</p>
              <p className="mt-0.5">{((rosterQ.error ?? punchesQ.error) as Error).message}</p>
            </div>
          </div>
        )}

        {isManager && !rosterQ.isLoading && !rosterQ.error && roster.length <= 1 && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              {t(
                "You're the only person on this company's roster, so there are no other timecards to open. Add employees from the",
              )}{" "}
              <Link to="/employees" className="underline">
                {t("Employees")}
              </Link>
              {t(" page.")}
            </p>
          </div>
        )}

        {/* Everyone at once: one line per person for the period on screen. */}
        {viewingAll && (
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="font-semibold text-foreground">
                {t("All employees")} · {fmtDate(rangeStart)} – {fmtDate(addDays(rangeEnd, -1))}
              </h2>
              <div className="flex items-center gap-3">
                {everyone.some((r) => r.cardCount > 0) && (
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() =>
                      setExpanded((e) =>
                        e.length > 0
                          ? []
                          : everyone.filter((r) => r.cardCount > 0).map((r) => r.id),
                      )
                    }
                  >
                    {expanded.length > 0 ? t("Collapse all") : t("Expand all")}
                  </button>
                )}
                {allQ.isLoading && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">{t("Date")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("Time card")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Actual hours")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Total paid hours")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Regular hours")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("OT hours")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("Double time")}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {everyone.map((r, rowIndex) => {
                    const open = expanded.includes(r.id);
                    // Every other person is banded, and their expanded time
                    // cards carry the same band, so one person's days never
                    // read as belonging to the name above them. A shadow under
                    // the row cannot do this job: the next row paints its own
                    // background straight over it.
                    const banded = rowIndex % 2 === 1;
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={`border-t border-border ${banded ? "bg-muted/40" : "bg-card"}`}
                        >
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={r.cardCount === 0}
                                onClick={() =>
                                  setExpanded((e) =>
                                    e.includes(r.id) ? e.filter((x) => x !== r.id) : [...e, r.id],
                                  )
                                }
                                aria-expanded={open}
                                aria-label={
                                  open
                                    ? t("Hide {name}'s time cards", { name: r.name })
                                    : t("Show {name}'s time cards", { name: r.name })
                                }
                                className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                              >
                                <ChevronDown
                                  className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`}
                                />
                              </button>
                              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary">
                                {initials(r.name)}
                              </span>
                              <div>
                                <div className="font-medium text-foreground">{r.name}</div>
                                {r.position && (
                                  <div className="text-xs text-muted-foreground">{r.position}</div>
                                )}
                                {hasLocations && r.byLocation.length > 0 && (
                                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <MapPin className="h-3 w-3 shrink-0" />
                                    {byLocationText(r.byLocation)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 font-medium text-foreground">
                            {r.cardCount === 0
                              ? "—"
                              : r.cardCount === 1
                                ? t("1 time card")
                                : t("{n} time cards", { n: r.cardCount })}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-foreground">
                            {fmtDecimal(r.grossMs)}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-foreground">
                            {fmtDecimal(r.workedMs)}
                          </td>
                          <td className="px-3 py-2 text-right text-foreground">
                            {fmtDecimal(r.regularMs)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right ${r.overtimeMs > 0 ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                          >
                            {fmtDecimal(r.overtimeMs)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right ${r.doubleTimeMs > 0 ? "font-medium text-destructive" : "text-muted-foreground"}`}
                          >
                            {fmtDecimal(r.doubleTimeMs)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedUser(r.id)}
                            >
                              {t("Open")}
                            </Button>
                          </td>
                        </tr>

                        {open &&
                          r.days.map((d) =>
                            d.spans.map((span, i) => (
                              <tr
                                key={`${d.key}-${span.inAt}`}
                                className={`border-t border-border/50 ${banded ? "bg-muted/60" : "bg-muted/25"}`}
                              >
                                <td className="py-1.5 pl-14 pr-4 text-muted-foreground">
                                  {i === 0 ? fmtDayShort(d.date) : ""}
                                </td>
                                <td className="px-3 py-1.5 text-foreground">
                                  {fmtTime(span.inAt, rules.punch_round_minutes)}
                                  {" – "}
                                  {span.outAt ? (
                                    fmtTime(span.outAt, rules.punch_round_minutes)
                                  ) : (
                                    <span className="text-warning-foreground">
                                      {t("still clocked in")}
                                    </span>
                                  )}
                                  {hasLocations && (
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      · {shiftPlaces(span.byLocation, span.locationId)}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground">
                                  {fmtDecimal(span.grossMs)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground">
                                  {fmtDecimal(span.workedMs)}
                                </td>
                                <td className="px-3 py-1.5" colSpan={4} />
                              </tr>
                            )),
                          )}
                      </Fragment>
                    );
                  })}
                  {everyone.length === 0 && !allQ.isLoading && (
                    <tr>
                      <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                        {t("No punches for this period.")}
                      </td>
                    </tr>
                  )}
                </tbody>
                {everyone.length > 0 && (
                  <tfoot>
                    <tr className="border-t border-border bg-muted/30 font-medium text-foreground">
                      <td className="px-4 py-2">{t("Totals")}</td>
                      <td className="px-3 py-2">
                        {t("{n} time cards", { n: everyone.reduce((n, r) => n + r.cardCount, 0) })}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.grossMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.workedMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.regularMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.overtimeMs, 0))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {fmtDecimal(everyone.reduce((n, r) => n + r.doubleTimeMs, 0))}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {hasLocations && everyoneByLocation.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-sm">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  {t("Paid hours by location")}
                </span>
                {everyoneByLocation.map((l) => (
                  <span key={l.locationId ?? "none"} className="text-muted-foreground">
                    {locationName(l.locationId)}{" "}
                    <span className="font-medium text-foreground">{fmtDecimal(l.workedMs)}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              {t(
                "Actual hours is time on the clock. Total paid hours is the same less unpaid breaks, and splits into regular, overtime and double time.",
              )}
            </p>
          </div>
        )}

        {!viewingAll && (
          <>
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div
                className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground`}
              >
                <div>{t("Date")}</div>
                <div>{t("Punches")}</div>
                <div className="text-right">{t("Hours")}</div>
                {isManager && <div className="w-28 text-right">{t("Edit")}</div>}
              </div>
              {!punchesQ.isLoading && !punchesQ.error && (punchesQ.data ?? []).length === 0 && (
                <div className="border-b border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  {t("No punches for")}{" "}
                  <span className="font-medium text-foreground">{employeeName}</span>{" "}
                  {t("between {from} and {to}.", {
                    from: fmtDate(rangeStart),
                    to: fmtDate(addDays(rangeEnd, -1)),
                  })}
                  {isManager && " " + t("Use Edit on a day to add one.")}
                </div>
              )}
              {grouped.rows.map((r, dayIndex) => (
                <Fragment key={r.date.toISOString()}>
                  <div
                    className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} items-start gap-2 border-b border-border px-4 py-3 text-sm last:border-0`}
                  >
                    <div>
                      <div className="font-medium text-foreground">{fmtDate(r.date)}</div>
                      {scheduledByDay.has(toDayString(r.date)) && (
                        <div className="mt-0.5 flex items-start gap-1 text-[11px] text-muted-foreground">
                          <CalendarClock className="mt-px h-3 w-3 shrink-0" />
                          <span>{scheduledByDay.get(toDayString(r.date))}</span>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      {absenceByDay.has(toDayString(r.date)) && (
                        <AbsenceBadge
                          absence={absenceByDay.get(toDayString(r.date))!}
                          label={absenceLabel(absenceByDay.get(toDayString(r.date))!)}
                        />
                      )}
                      {r.pairs.length === 0 && !absenceByDay.has(toDayString(r.date)) && (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.pairs.map((p, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="rounded bg-emerald-100 dark:bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                            {t("IN")} {fmtTime(p.in.at, rules.punch_round_minutes)}
                          </span>
                          {p.out ? (
                            <span className="rounded bg-blue-100 dark:bg-blue-500/15 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                              {t("OUT")} {fmtTime(p.out.at, rules.punch_round_minutes)}
                            </span>
                          ) : (
                            <span className="rounded bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                              {t("Still clocked in")}
                            </span>
                          )}
                          <LateBadge lateness={lateness.get(p.in.id)} />
                          {unscheduled.has(p.in.id) && (
                            <span
                              className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-500/15 dark:text-slate-300"
                              title={t("Clocked in with no published shift on the schedule")}
                            >
                              <CalendarX className="h-3 w-3" />
                              {t("Not scheduled")}
                            </span>
                          )}
                          {(!p.in.within_geofence || (p.out && !p.out.within_geofence)) && (
                            <span className="text-xs text-destructive">{t("⚠ off-site")}</span>
                          )}
                          {hasLocations &&
                            (isManager ? (
                              <select
                                className="max-w-[10rem] truncate rounded border border-border bg-background px-1 py-0.5 text-xs text-muted-foreground"
                                value={p.in.location_id ?? ""}
                                disabled={moveLocation.isPending}
                                onChange={(e) =>
                                  moveLocation.mutate({
                                    punchId: p.in.id,
                                    locationId: e.target.value || null,
                                  })
                                }
                                aria-label={t("Location for the shift starting {time}", {
                                  time: fmtTime(p.in.at, rules.punch_round_minutes),
                                })}
                              >
                                <option value="">{t("No location")}</option>
                                {locations
                                  .filter(
                                    (l) =>
                                      l.company_id === (viewing?.company_id ?? company?.id) ||
                                      l.id === p.in.location_id,
                                  )
                                  .map((l) => (
                                    <option key={l.id} value={l.id}>
                                      {l.name}
                                    </option>
                                  ))}
                              </select>
                            ) : (
                              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                                <MapPin className="h-3 w-3" />
                                {shiftPlaces(grouped.splits.get(p.in.at), p.in.location_id)}
                              </span>
                            ))}
                          {hasLocations &&
                            isManager &&
                            (grouped.splits.get(p.in.at)?.length ?? 0) > 1 && (
                              <span className="text-xs text-muted-foreground">
                                {byLocationText(grouped.splits.get(p.in.at)!)}
                              </span>
                            )}
                        </div>
                      ))}
                      {(commentsByDay.get(toDayString(r.date)) ?? []).map((n) => (
                        <p
                          key={n.id}
                          className="flex items-start gap-1.5 text-xs text-muted-foreground"
                        >
                          <MessageSquarePlus className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="min-w-0 whitespace-pre-wrap break-words">
                            <span className="text-foreground">{n.note}</span>
                            {n.author_name && <> · {n.author_name}</>}
                          </span>
                        </p>
                      ))}
                    </div>
                    <div className="text-right font-medium text-foreground">
                      {fmtHours(r.totalMs)}
                      {(r.unpaidBreakMs > 0 || r.paidBreakMs > 0) && (
                        <div className="text-[10px] font-normal text-muted-foreground">
                          {r.unpaidBreakMs > 0 && (
                            <>
                              {t("unpaid")} {fmtHours(r.unpaidBreakMs)}
                            </>
                          )}
                          {r.unpaidBreakMs > 0 && r.paidBreakMs > 0 && " · "}
                          {r.paidBreakMs > 0 && (
                            <>
                              {t("paid")} {fmtHours(r.paidBreakMs)}
                            </>
                          )}
                        </div>
                      )}
                      {/* Back on the clock before the break was up. The day is
                        flagged rather than docked — what they took is what
                        came off the shift. */}
                      {r.incompleteBreaks > 0 && (
                        <div className="text-[10px] font-normal text-destructive">
                          ⚠{" "}
                          {r.incompleteBreaks === 1
                            ? t("incomplete break")
                            : t("{n} incomplete breaks", { n: r.incompleteBreaks })}
                        </div>
                      )}
                      {/* Time they ran over and were not charged for. */}
                      {r.overBreakMs > 0 && (
                        <div className="text-[10px] font-normal text-muted-foreground">
                          {t("{time} over, not counted", { time: fmtHours(r.overBreakMs) })}
                        </div>
                      )}
                      {/* The position's differential: hours worked in its window. */}
                      {diffRule && r.diffMs > 0 && (
                        <div className="text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                          {diffRule.diff_label} {fmtHours(r.diffMs)}
                        </div>
                      )}
                    </div>
                    {isManager && (
                      <div className="flex w-28 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => openComments(r.date)}
                          title={t("Comment on this day")}
                          aria-label={t("Comment on {date}", { date: fmtDate(r.date) })}
                        >
                          <MessageSquarePlus className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => openAbsence(r.date)}
                          title={t("Mark sick, family leave or vacation")}
                          aria-label={t("Mark an absence on {date}", { date: fmtDate(r.date) })}
                        >
                          <CalendarOff className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => setEditingDay(r.date)}
                          aria-label={t("Edit punches for {date}", { date: fmtDate(r.date) })}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {showWeekTotals &&
                    (dayIndex + 1) % 7 === 0 &&
                    grouped.weeks[Math.floor(dayIndex / 7)] && (
                      <WeekSubtotal
                        n={Math.floor(dayIndex / 7) + 1}
                        week={grouped.weeks[Math.floor(dayIndex / 7)]}
                        isManager={isManager}
                      />
                    )}
                </Fragment>
              ))}
              {(() => {
                const split = splitPeriod(
                  grouped.rows.map((r) => r.totalMs),
                  rules,
                  period === "week",
                );
                const isOT = split.overtimeMs > 0 || split.doubleTimeMs > 0;
                return (
                  <div className="grid grid-cols-[1fr_2fr_1fr] bg-muted/30 px-4 py-3 text-sm">
                    <div className="font-semibold text-foreground">{t("Total")}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("Unpaid break:")} {fmtHours(grouped.weekUnpaid)} · {t("Paid break:")}{" "}
                      {fmtHours(grouped.weekPaid)}
                      {split.overtimeMs > 0 && (
                        <span className="ml-2 rounded bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-200">
                          {t("OT")} {fmtHours(split.overtimeMs)}
                        </span>
                      )}
                      {split.doubleTimeMs > 0 && (
                        <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
                          2× {fmtHours(split.doubleTimeMs)}
                        </span>
                      )}
                      {diffRule && grouped.periodDiff > 0 && (
                        <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 font-medium text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200">
                          {diffRule.diff_label} {fmtHours(grouped.periodDiff)}
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-right font-semibold ${isOT ? "text-amber-700 dark:text-amber-300" : "text-foreground"}`}
                    >
                      {fmtHours(grouped.weekTotal)}
                    </div>
                  </div>
                );
              })()}
              {/* The total again, split by where it was worked. The lines add
                  up to it: a shift still on the clock is in neither. */}
              {absenceSummary.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-3 text-sm">
                  <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <CalendarOff className="h-3.5 w-3.5" />
                    {t("Days off")}
                  </span>
                  {absenceSummary.map((a) => (
                    <span key={a.label} className="text-foreground">
                      {a.label} <span className="text-muted-foreground">{daysText(a.days)}</span>
                    </span>
                  ))}
                </div>
              )}
              {hasLocations && grouped.byLocation.length > 0 && (
                <div className="border-t border-border px-4 py-3 text-sm">
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5" />
                    {t("Hours by location")}
                  </div>
                  {grouped.byLocation.map((l) => (
                    <div
                      key={l.locationId ?? "none"}
                      className="grid grid-cols-[1fr_auto] gap-2 py-0.5"
                    >
                      <span className={l.locationId ? "text-foreground" : "text-muted-foreground"}>
                        {locationName(l.locationId)}
                      </span>
                      <span className="text-right font-medium tabular-nums text-foreground">
                        {fmtHours(l.workedMs)}{" "}
                        <span className="font-normal text-muted-foreground">
                          ({fmtDecimal(l.workedMs)})
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {locationErr && (
                <p className="border-t border-border px-4 py-2 text-xs text-destructive">
                  {locationErr}
                </p>
              )}
            </div>

            {detailed && (
              <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <NotebookPen className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">{t("Notes")}</h2>
                  <span className="text-xs text-muted-foreground">
                    {employeeName} · {fmtDate(rangeStart)} – {fmtDate(addDays(rangeEnd, -1))}
                  </span>
                  {notesQ.isFetching && (
                    <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>
                {notesQ.error ? (
                  <p className="px-4 py-4 text-sm text-destructive">
                    {/* The table arrives by a migration applied by hand; until
                        then PostgREST says so in its own words. */}
                    {/timecard_notes|schema cache/i.test((notesQ.error as Error).message)
                      ? t(
                          "Notes aren't set up on the server yet. Ask your administrator to apply the timecard notes update.",
                        )
                      : `${t("Couldn't load the notes:")} ${(notesQ.error as Error).message}`}
                  </p>
                ) : notes.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-muted-foreground">
                    {t("No notes for this period.")}
                    {isManager &&
                      " " +
                        t(
                          "Add a note or an OT slip below — it prints at the foot of the detailed time card. Comments on a single day go on that day's line instead.",
                        )}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {notes.map((n) => (
                      <li key={n.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                        <div className="w-28 shrink-0 font-medium text-foreground">
                          {fmtDate(fromDayString(n.note_date))}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="whitespace-pre-wrap break-words text-foreground">
                            <span
                              className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${n.kind === "ot_slip" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200" : "bg-muted text-muted-foreground"}`}
                            >
                              {noteKindLabel(n)}
                              {n.hours != null && ` · ${noteHoursText(n)}`}
                            </span>
                            {n.note}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {n.author_name || "—"} ·{" "}
                            {new Date(n.created_at).toLocaleString(localeTag(), {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </p>
                        </div>
                        {isManager && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-muted-foreground hover:text-destructive"
                            disabled={deleteNote.isPending}
                            onClick={() => deleteNote.mutate(n.id)}
                            aria-label={t("Delete note")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {isManager && !notesQ.error && (
                  <form
                    className="space-y-2 border-t border-border bg-muted/20 px-4 py-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (noteText.trim())
                        addNote.mutate({
                          kind: noteKind,
                          day: noteDay,
                          text: noteText,
                          hours: noteHours,
                        });
                    }}
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="timecard-note-kind" className="text-xs">
                          {t("Type")}
                        </Label>
                        <select
                          id="timecard-note-kind"
                          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                          value={noteKind}
                          onChange={(e) => setNoteKind(e.target.value as PeriodNoteKind)}
                        >
                          <option value="note">{t("Note")}</option>
                          <option value="ot_slip">{t("OT slip")}</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="timecard-note-day" className="text-xs">
                          {t("Date")}
                        </Label>
                        <Input
                          id="timecard-note-day"
                          type="date"
                          className="h-9 w-44"
                          min={periodFirstDay}
                          max={periodLastDay}
                          value={
                            noteDay && noteDay >= periodFirstDay && noteDay <= periodLastDay
                              ? noteDay
                              : periodFirstDay
                          }
                          onChange={(e) => setNoteDay(e.target.value)}
                        />
                      </div>
                      {noteKind === "ot_slip" && (
                        <div className="space-y-1">
                          <Label htmlFor="timecard-note-hours" className="text-xs">
                            {t("OT hours")}
                          </Label>
                          <Input
                            id="timecard-note-hours"
                            type="number"
                            inputMode="decimal"
                            min="0.25"
                            max="24"
                            step="0.25"
                            className="h-9 w-24"
                            placeholder="2.5"
                            value={noteHours}
                            onChange={(e) => setNoteHours(e.target.value)}
                          />
                        </div>
                      )}
                      <div className="min-w-[14rem] flex-1 space-y-1">
                        <Label htmlFor="timecard-note-text" className="text-xs">
                          {t("Note")}
                        </Label>
                        <Textarea
                          id="timecard-note-text"
                          rows={2}
                          maxLength={1000}
                          placeholder={
                            noteKind === "ot_slip"
                              ? t("e.g. Approved by Sgt. Lopez — special event coverage")
                              : t("e.g. Training: annual conference, Nov 2–5")
                          }
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                        />
                      </div>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!noteText.trim() || addNote.isPending}
                      >
                        {addNote.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {noteKind === "ot_slip" ? t("Add OT slip") : t("Add note")}
                      </Button>
                    </div>
                    {noteErr && <p className="text-xs text-destructive">{noteErr}</p>}
                  </form>
                )}
              </div>
            )}

            {/* Where each punch was made. Managers only: an employee's own timecard
          is about their hours, not a map of their movements. */}
            {isManager && (
              <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">{t("Clock-in locations")}</h2>
                  <span className="text-xs text-muted-foreground">
                    {employeeName} · {period === "week" ? t("this week") : t("this fortnight")}
                  </span>
                </div>
                {locationRows.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t("No locations recorded for this period.")}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {locationRows.map((p) => (
                      <div
                        key={p.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-foreground">
                            {t(KIND_LABEL[p.kind])}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            {new Date(p.at).toLocaleString(localeTag(), {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {p.distance_m != null && (
                            <span
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                p.within_geofence
                                  ? "bg-secondary text-muted-foreground"
                                  : "bg-destructive/10 text-destructive"
                              }`}
                            >
                              {t("{n} m from worksite", { n: Math.round(p.distance_m) })}
                            </span>
                          )}
                          <a
                            href={`https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=17/${p.latitude}/${p.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                          >
                            {t("Map")} <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {wipeOpen && (
          <Dialog open onOpenChange={(o) => !o && setWipeOpen(false)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("Delete timecards")}</DialogTitle>
                <DialogDescription>
                  {t(
                    "Each deleted punch is recorded in the audit log under your name, but the hours themselves are gone. Anything already paid from these timecards will no longer add up.",
                  )}
                </DialogDescription>
              </DialogHeader>

              {wipeDone !== null ? (
                <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">
                  {wipeDone === 1
                    ? t("Deleted 1 punch.")
                    : t("Deleted {n} punches.", { n: wipeDone })}
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="wipe-who">{t("Whose timecards")}</Label>
                    <select
                      id="wipe-who"
                      value={wipeWho}
                      onChange={(e) => setWipeWho(e.target.value as "one" | "all")}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="one" disabled={!targetUserId}>
                        {t("Just {name}", { name: employeeName })}
                      </option>
                      <option value="all">{t("Everyone in the company")}</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="wipe-scope">{t("Which dates")}</Label>
                    <select
                      id="wipe-scope"
                      value={wipeScope}
                      onChange={(e) => setWipeScope(e.target.value as "day" | "period" | "month")}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="day">{t("One day")}</option>
                      <option value="period">
                        {period === "week" ? t("This week") : t("These two weeks")} (
                        {fmtDate(rangeStart)}
                        {" – "}
                        {fmtDate(addDays(rangeEnd, -1))})
                      </option>
                      <option value="month">
                        {t("The whole of {month}", {
                          month: anchor.toLocaleDateString(localeTag(), {
                            month: "long",
                            year: "numeric",
                          }),
                        })}
                      </option>
                    </select>
                    {wipeScope === "day" && (
                      <Input
                        type="date"
                        value={wipeDay}
                        onChange={(e) => setWipeDay(e.target.value)}
                      />
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="wipe-reason">{t("Note (optional)")}</Label>
                    <Input
                      id="wipe-reason"
                      value={wipeReason}
                      onChange={(e) => setWipeReason(e.target.value)}
                      placeholder={t("e.g. punches imported twice by mistake")}
                    />
                  </div>

                  <p className="text-sm text-muted-foreground">
                    {wipeCountQ.isLoading
                      ? t("Counting…")
                      : (wipeCountQ.data ?? 0) === 1
                        ? t("1 punch will be deleted.")
                        : t("{n} punches will be deleted.", { n: wipeCountQ.data ?? 0 })}
                  </p>

                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-border accent-destructive"
                      checked={wipeUnderstood}
                      onChange={(e) => setWipeUnderstood(e.target.checked)}
                    />
                    <span>
                      {t(
                        "I have checked the people and the dates, and I understand these punches cannot be brought back.",
                      )}
                    </span>
                  </label>

                  {wipeError && (
                    <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {wipeError}
                    </p>
                  )}
                </div>
              )}

              <DialogFooter>
                {wipeDone !== null ? (
                  <Button onClick={() => setWipeOpen(false)}>{t("Done")}</Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setWipeOpen(false)}>
                      {t("Keep them")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={
                        !wipeUnderstood || (wipeCountQ.data ?? 0) === 0 || wipePeriod.isPending
                      }
                      onClick={() => wipePeriod.mutate()}
                    >
                      {wipePeriod.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t("Delete {n}", { n: wipeCountQ.data ?? 0 })}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {isManager && editingDay && targetUserId && (
          <TimecardDayEditor
            open
            onOpenChange={(next) => !next && setEditingDay(null)}
            day={editingDay}
            employeeId={targetUserId}
            employeeName={employeeName}
            punches={
              (grouped.rows.find((r) => r.date.toDateString() === editingDay.toDateString())
                ?.punches ?? []) as EditablePunch[]
            }
          />
        )}
      </div>
    </>
  );
}

/** One week's line on the detailed (bi-weekly) card, under its seventh day. */
function WeekSubtotal({
  n,
  week,
  isManager,
}: {
  n: number;
  week: { workedMs: number; unpaidBreakMs: number; paidBreakMs: number };
  isManager: boolean;
}) {
  const t = useT("timecards");
  return (
    <div
      className={`grid ${isManager ? "grid-cols-[1fr_2fr_1fr_auto]" : "grid-cols-[1fr_2fr_1fr]"} gap-2 border-b border-border bg-muted/30 px-4 py-2 text-sm`}
    >
      <div className="font-semibold text-foreground">{t("Week {n} total", { n })}</div>
      <div className="text-xs text-muted-foreground">
        {t("Unpaid break:")} {fmtHours(week.unpaidBreakMs)} · {t("Paid break:")}{" "}
        {fmtHours(week.paidBreakMs)}
      </div>
      <div className="text-right font-semibold text-foreground">{fmtHours(week.workedMs)}</div>
      {isManager && <div className="w-28" />}
    </div>
  );
}

/** A day off on the card's day row, coloured by kind so a fortnight reads at a glance. */
function AbsenceBadge({ absence, label }: { absence: Absence; label: string }) {
  const tone =
    absence.kind === "sick"
      ? "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
      : absence.kind === "vacation"
        ? "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
        : absence.kind === "family_leave"
          ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}
      title={absence.note ?? undefined}
    >
      <CalendarOff className="h-3 w-3" />
      {label}
    </span>
  );
}
