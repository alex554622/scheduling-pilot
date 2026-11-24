import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { translateRuleMessage, useMyRules } from "@/lib/team-rules";
import { readBreak } from "@/lib/timecard-totals";
import { useLateness } from "@/lib/use-lateness";
import { usePayRulesFor } from "@/lib/use-pay-rules";
import { LateBadge } from "@/components/late-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LeafletMap } from "@/components/leaflet-map";
import { PaySettingsCard } from "@/components/pay-settings-card";
import { readPaySettings, type PaySettings } from "@/lib/pay-settings";
import { localeTag, translate, useLocaleTag, useT } from "@/lib/i18n";
import { openLocationSettings } from "@/lib/native/location-settings";

const GPS_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
const GPS_BLOCKED_MSG =
  "You will not be able to clock in until you authorize the proper location settings on your phone or tablet.";
import {
  Clock,
  MapPin,
  Loader2,
  LogIn,
  LogOut,
  AlertTriangle,
  FileClock,
  Settings as SettingsIcon,
  Coffee,
  Play,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/timeclock")({
  component: TimeclockPage,
});

type PunchKind = "in" | "out" | "break_start" | "break_end";

type Punch = {
  id: string;
  kind: PunchKind;
  at: string;
  latitude: number | null;
  longitude: number | null;
  distance_m: number | null;
  within_geofence: boolean;
  /** Length of the break a `break_start` opens. Null on every other kind. */
  break_minutes: number | null;
  /** Where the stretch is being worked; the clock-in's is the one that counts. */
  location_id: string | null;
};

const PUNCH_LABEL: Record<PunchKind, string> = {
  in: "IN",
  out: "OUT",
  break_start: "BREAK START",
  break_end: "BREAK END",
};

/**
 * What one break takes off this shift. The card has to agree with the timecard
 * to the minute, so it asks the same function payroll does — including the rule
 * that a break is recorded as the length that was picked, however long it ran.
 */
function breakDeduction(
  elapsedMs: number,
  minutes: number | null,
  cap: boolean,
  paidMeals = false,
): number {
  const read = readBreak(elapsedMs, minutes, cap, paidMeals);
  return read.paid ? 0 : read.countedMs;
}

/** "3h 42m" — the shape used for worked time everywhere in the app. */
function fmtWorked(ms: number): string {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Money with no currency symbol — the rate is whatever the user typed. */
function fmtAmount(n: number): string {
  return n.toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** mm:ss, or h:mm:ss once a break runs past the hour. */
function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

type Fix = { lat: number; lng: number; acc: number };

/**
 * The last position this page got, kept across visits. Coming back to the time
 * clock within a minute starts from it instead of from nothing, while the
 * watch below fetches a fresh one. Older than that, it isn't trusted for a
 * punch and the page waits for a new fix as before.
 */
const FIX_REUSE_MS = 60_000;
let lastFix: (Fix & { at: number }) | null = null;
function recentFix(): Fix | null {
  return lastFix && Date.now() - lastFix.at < FIX_REUSE_MS
    ? { lat: lastFix.lat, lng: lastFix.lng, acc: lastFix.acc }
    : null;
}

type Company = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
};

function TimeclockPage() {
  const t = useT("time");
  const tag = useLocaleTag();
  const { user, company, primaryRole, loading } = useAuth();
  // The company's App rules with this person's position rules over them.
  const rules = useMyRules();
  const capBreaks = rules.cap_break_to_length;
  // A position with paid lunch: a 30 or a 60 doesn't come off this shift.
  const paidMeals = usePayRulesFor(user?.id)?.paid_meal_breaks ?? false;
  const qc = useQueryClient();
  const [coords, setCoords] = useState<Fix | null>(recentFix);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "warn" | "err"; msg: string } | null>(null);
  const [confirmNoGps, setConfirmNoGps] = useState(false);

  const companyQ = useQuery<Company | null>({
    queryKey: ["timeclock-company", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name, latitude, longitude, geofence_radius_m")
        .eq("id", company!.id)
        .maybeSingle();
      if (error) throw error;
      return data as Company | null;
    },
  });

  const recentQ = useQuery<Punch[]>({
    queryKey: ["my-punches-recent", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select(
          "id, kind, at, latitude, longitude, distance_m, within_geofence, break_minutes, location_id",
        )
        .eq("user_id", user!.id)
        .order("at", { ascending: false })
        // Deep enough to always contain the open shift's clock-in, however many
        // breaks it has — the worked-time maths walks back to it. The list below
        // still only renders the newest few.
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Punch[];
    },
  });

  // The locations this person can clock in at: the ones they are assigned to,
  // or every company location when they have none. With two or more they get a
  // picker; with one or none the database files the shift on its own.
  const workLocationsQ = useQuery({
    queryKey: ["my-work-locations", user?.id, company?.id],
    enabled: !!user?.id && !!company?.id,
    queryFn: async () => {
      const [locs, mine] = await Promise.all([
        supabase.from("locations").select("id, name").eq("company_id", company!.id).order("name"),
        supabase.from("employee_locations").select("location_id").eq("employee_id", user!.id),
      ]);
      if (locs.error) throw locs.error;
      if (mine.error) throw mine.error;
      const assigned = new Set((mine.data ?? []).map((r) => r.location_id));
      const all = locs.data ?? [];
      return assigned.size > 0 ? all.filter((l) => assigned.has(l.id)) : all;
    },
  });
  const workLocations = workLocationsQ.data ?? [];
  // Before clocking in: "" leaves it to the schedule and the map.
  const [pickedLocation, setPickedLocation] = useState("");

  const punchesLoading = recentQ.isPending && recentQ.fetchStatus !== "idle";
  const lastPunch = recentQ.data?.[0];
  // Derived status: off | working | on_break
  const status: "off" | "working" | "on_break" =
    !lastPunch || lastPunch.kind === "out"
      ? "off"
      : lastPunch.kind === "break_start"
        ? "on_break"
        : "working";
  const nextKind: "in" | "out" = status === "off" ? "in" : "out";
  // The clock-in of the shift they are on now.
  const openIn = status === "off" ? undefined : recentQ.data?.find((p) => p.kind === "in");
  // Late marks, when the company reads clock-ins against the schedule. Empty otherwise.
  const lateness = useLateness(user?.id, recentQ.data);
  const openLate = openIn ? lateness.get(openIn.id) : undefined;

  // Where they have moved to since clocking in, newest first. Their time counts
  // at the latest one; before any move, at the clock-in's location.
  const movesQ = useQuery({
    queryKey: ["my-location-moves", user?.id, openIn?.id],
    enabled: !!user?.id && !!openIn,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("location_moves")
        .select("id, at, location_id")
        .eq("user_id", user!.id)
        .gte("at", openIn!.at)
        .order("at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const latestMove = openIn ? movesQ.data?.[0] : undefined;
  const currentLocation = latestMove?.location_id ?? openIn?.location_id ?? null;
  const currentSince = latestMove?.at ?? openIn?.at;

  // Second-by-second clock driving the break countdown, worked time and
  // earnings. Idle while clocked out — nothing on the card moves then.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status === "off") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status, lastPunch?.id]);

  // A break_start carries the length the employee picked; without one (an older
  // row, or a break opened before lengths existed) all we can show is elapsed time.
  const breakStartedAt =
    status === "on_break" && lastPunch ? new Date(lastPunch.at).getTime() : null;
  const breakMinutes = status === "on_break" ? (lastPunch?.break_minutes ?? null) : null;
  const breakEndsAt =
    breakStartedAt != null && breakMinutes != null ? breakStartedAt + breakMinutes * 60_000 : null;
  const breakRemainingMs = breakEndsAt != null ? breakEndsAt - now : null;
  // A break runs its full length; only an admin can end one early. The server
  // enforces this too (enforce_break_length) — this just keeps the button honest.
  const isAdmin = primaryRole === "company_admin" || primaryRole === "super_admin";
  const breakLocked = !isAdmin && breakRemainingMs != null && breakRemainingMs > 0;

  // Replay the punch history oldest-first to find where the open shift began and
  // how much unpaid break it has already used. Only closed breaks are counted
  // here; one still running is added live below, so the total moves every second.
  const shift = useMemo(() => {
    let startedAt: number | null = null;
    let closedUnpaidMs = 0;
    let openBreakAt: number | null = null;
    let openBreakMinutes: number | null = null;

    for (const p of [...(recentQ.data ?? [])].reverse()) {
      const at = new Date(p.at).getTime();
      if (p.kind === "in") {
        startedAt = at;
        closedUnpaidMs = 0;
        openBreakAt = null;
      } else if (p.kind === "out") {
        startedAt = null;
        closedUnpaidMs = 0;
        openBreakAt = null;
      } else if (p.kind === "break_start") {
        if (startedAt != null) {
          openBreakAt = at;
          openBreakMinutes = p.break_minutes;
        }
      } else if (p.kind === "break_end" && openBreakAt != null) {
        closedUnpaidMs += breakDeduction(at - openBreakAt, openBreakMinutes, capBreaks, paidMeals);
        openBreakAt = null;
        openBreakMinutes = null;
      }
    }
    return { startedAt, closedUnpaidMs, openBreakAt, openBreakMinutes };
  }, [recentQ.data, capBreaks, paidMeals]);

  // A break still running is capped too: once they pass the length they picked,
  // the worked total stops falling and the overrun shows on the countdown above.
  const liveUnpaidMs =
    shift.openBreakAt != null
      ? breakDeduction(now - shift.openBreakAt, shift.openBreakMinutes, capBreaks, paidMeals)
      : 0;
  const workedMs =
    shift.startedAt == null
      ? 0
      : Math.max(0, now - shift.startedAt - shift.closedUnpaidMs - liveUnpaidMs);

  // Only a manager sees the worksite map; everyone still gets the same
  // distance check when they punch.
  const showMap = primaryRole === "company_admin" || primaryRole === "super_admin";

  // Pay is read from this device only — see `@/lib/pay-settings` for why.
  const [pay, setPay] = useState<PaySettings | null>(null);
  useEffect(() => setPay(readPaySettings(user?.id)), [user?.id]);

  const earnings = pay
    ? (() => {
        const gross = (workedMs / 3_600_000) * pay.hourlyRate;
        const federalTax = gross * (pay.taxPercent / 100);
        const stateTax = gross * (pay.statePercent / 100);
        return { gross, federalTax, stateTax, net: gross - federalTax - stateTax };
      })()
    : null;

  // Watch position. Restarted when they come back to the page (e.g. from the
  // phone's Settings after turning location on), since a watch that already
  // failed with "permission denied" does not pick the new permission up.
  const [geoWatchKey, setGeoWatchKey] = useState(0);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setGeoWatchKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeoErr(translate("Geolocation not supported on this device."));
      return;
    }
    let cancelled = false;
    let precise = false;
    // Whether this run has a fix of its own, not just the one kept from last visit.
    let fresh = false;
    const take = (pos: GeolocationPosition) => {
      const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
      const fix = { lat, lng, acc };
      lastFix = { ...fix, at: Date.now() };
      fresh = true;
      setCoords(fix);
      setGeoErr(null);
    };
    // A high-accuracy fix needs the GPS chip, which from cold can take most of
    // the 15-second timeout, and until something arrives Clock IN stays
    // disabled. Ask for a quick coarse fix (network/Wi-Fi, or one the OS
    // already has from the last minute) alongside it, so the page is usable
    // in a second or two; the precise watch replaces it as soon as it lands.
    // The accuracy goes up with every punch either way.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!cancelled && !precise) take(pos);
      },
      () => {
        /* the watch below reports errors */
      },
      { enableHighAccuracy: false, maximumAge: FIX_REUSE_MS, timeout: 5_000 },
    );
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        if (cancelled) return;
        precise = true;
        take(pos);
      },
      (err) => {
        if (cancelled) return;
        // A slow GPS timing out while a coarse fix is in hand isn't "GPS off".
        if (err.code === err.TIMEOUT && fresh) return;
        // Nothing new this visit: the position kept from last time may be from
        // before location was switched off, so it must not stand in for GPS.
        if (!fresh) {
          lastFix = null;
          setCoords(null);
        }
        setGeoErr(err.message || translate("Unable to read location"));
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(id);
    };
  }, [geoWatchKey]);

  const company_loc =
    companyQ.data?.latitude != null && companyQ.data?.longitude != null
      ? { lat: companyQ.data.latitude!, lng: companyQ.data.longitude! }
      : null;

  const distance = useMemo(() => {
    if (!coords || !company_loc) return null;
    return haversineM(coords.lat, coords.lng, company_loc.lat, company_loc.lng);
  }, [coords, company_loc?.lat, company_loc?.lng]);

  const radius = companyQ.data?.geofence_radius_m ?? 200;
  const withinFence = distance == null ? null : distance <= radius;
  const fenceBlocks = rules.require_geofence && withinFence === false;
  // GPS is off, denied or unavailable. They can still punch — the server
  // records it without a location and tells the admins. Until GPS has either
  // given a fix or failed, keep waiting so a slow fix doesn't count as "off".
  const noGps = !coords && !!geoErr;
  const waitingForGps = !coords && !geoErr;
  // Only worth warning about when the company actually checks location.
  const gpsOffUnderFence = noGps && rules.require_geofence && !!company_loc;

  // Clocking in without GPS is a 7-day grace period, counted from the first
  // clock-in without it; after that the server refuses Clock IN until location
  // is on (see 20261121120000_gps_grace_period.sql). Any punch with GPS ends it.
  const graceQ = useQuery({
    queryKey: ["my-gps-grace", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gps_off_grace")
        .select("since")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data?.since ?? null;
    },
  });
  const graceDeadline = graceQ.data
    ? new Date(graceQ.data).getTime() + GPS_GRACE_DAYS * DAY_MS
    : null;
  const graceDaysLeft =
    graceDeadline == null
      ? GPS_GRACE_DAYS
      : Math.max(0, Math.ceil((graceDeadline - Date.now()) / DAY_MS));
  const graceExpired = gpsOffUnderFence && graceDeadline != null && Date.now() >= graceDeadline;
  const clockInBlockedNoGps = graceExpired && nextKind === "in";
  // A team that requires GPS gets no grace period: Clock IN waits for location.
  // Clock OUT is never held up, so nobody is left on the clock.
  const gpsBlocks = noGps && rules.require_gps && nextKind === "in";

  const [settingsHelp, setSettingsHelp] = useState(false);
  const goToLocationSettings = async () => {
    setSettingsHelp(false);
    try {
      const r = await openLocationSettings();
      if (r === "blocked") setSettingsHelp(true);
    } catch {
      setSettingsHelp(true);
    }
    setGeoWatchKey((k) => k + 1);
  };
  const allowedBreaks = ([10, 30, 60] as const).filter(
    (m) =>
      (m === 10 && rules.allow_break_10) ||
      (m === 30 && rules.allow_break_30) ||
      (m === 60 && rules.allow_break_60),
  );

  const center: [number, number] = company_loc
    ? [company_loc.lat, company_loc.lng]
    : coords
      ? [coords.lat, coords.lng]
      : [0, 0];

  const pins = [];
  if (company_loc) pins.push({ lat: company_loc.lat, lng: company_loc.lng, label: t("Worksite") });
  if (coords) pins.push({ lat: coords.lat, lng: coords.lng, label: t("You") });

  const punchMut = useMutation({
    mutationFn: async () => {
      if (waitingForGps) throw new Error(translate("Waiting for GPS location…"));
      const { data, error } = await supabase.rpc("clock_punch", {
        _lat: coords?.lat ?? null,
        _lng: coords?.lng ?? null,
        _accuracy: coords?.acc,
      });
      if (error) throw error;
      // Clocked in at a location they picked: file the shift there, over
      // whatever the database guessed.
      if (data?.kind === "in" && pickedLocation) {
        const { error: locErr } = await supabase.rpc("set_punch_location", {
          _punch: data.id,
          _location: pickedLocation,
        });
        if (locErr) throw locErr;
      }
      return data;
    },
    onSuccess: () => {
      setPickedLocation("");
      if (gpsOffUnderFence) {
        setFlash({
          kind: "warn",
          msg:
            nextKind === "in"
              ? t(
                  "Clocked in without GPS. Your admin was notified and will review this clock-in. Turn on your location so your punches count as valid.",
                )
              : t(
                  "Clocked out without GPS. Your admin was notified and will review this punch. Turn on your location so your punches count as valid.",
                ),
        });
      } else {
        setFlash({
          kind: "ok",
          msg: nextKind === "in" ? t("Clocked in successfully.") : t("Clocked out successfully."),
        });
      }
      qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
      qc.invalidateQueries({ queryKey: ["timecards"] });
      qc.invalidateQueries({ queryKey: ["my-gps-grace"] });
    },
    onError: (e: Error) => {
      const msg = e?.message ?? "";
      if (msg.includes("GPS_GRACE_EXPIRED")) {
        qc.invalidateQueries({ queryKey: ["my-gps-grace"] });
        setFlash({ kind: "err", msg: t(GPS_BLOCKED_MSG) });
      } else {
        setFlash({ kind: "err", msg: translateRuleMessage(msg) || t("Failed to punch") });
      }
    },
    onSettled: () => setSubmitting(false),
  });

  // Moved to another location mid-shift: the time so far stays where it was
  // worked, and from now on it counts at the new one.
  const moveMut = useMutation({
    mutationFn: async (locationId: string) => {
      if (!coords) throw new Error(translate("Waiting for GPS location…"));
      const { error } = await supabase.rpc("switch_location", {
        _location: locationId,
        _lat: coords.lat,
        _lng: coords.lng,
        _accuracy: coords.acc,
      });
      if (error) throw error;
      return workLocations.find((l) => l.id === locationId)?.name ?? "";
    },
    onSuccess: (name) => {
      setFlash({ kind: "ok", msg: t("Now counting your time at {place}.", { place: name }) });
      qc.invalidateQueries({ queryKey: ["my-location-moves"] });
      qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
      qc.invalidateQueries({ queryKey: ["timecards"] });
    },
    onError: (e: any) => setFlash({ kind: "err", msg: e.message || t("Failed") }),
  });

  const breakMut = useMutation({
    mutationFn: async (minutes: 10 | 30 | 60 | null) => {
      if (waitingForGps) throw new Error(translate("Waiting for GPS location…"));
      // Ending a break omits _minutes entirely (the SQL default is NULL);
      // break_punch only requires a length when starting one.
      const { data, error } = await supabase.rpc("break_punch", {
        _lat: coords?.lat ?? null,
        _lng: coords?.lng ?? null,
        _accuracy: coords?.acc,
        ...(minutes !== null ? { _minutes: minutes } : {}),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      setFlash({
        kind: "ok",
        msg: status === "on_break" ? t("Break ended.") : t("Break started."),
      });
      qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
      qc.invalidateQueries({ queryKey: ["timecards"] });
    },
    onError: (e: any) => setFlash({ kind: "err", msg: e.message || t("Failed") }),
  });

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  if (!company)
    return (
      <div className="text-sm text-muted-foreground">
        {t("Join a company to use the time clock.")}
      </div>
    );

  const locationMissing = !company_loc;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("Time clock")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Clock in and out — your location is recorded with each punch.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/timecards">
              <FileClock className="mr-2 h-4 w-4" />
              {t("My timecard")}
            </Link>
          </Button>
          {(primaryRole === "company_admin" || primaryRole === "super_admin") && (
            <Button asChild variant="outline" size="sm">
              <Link to="/worksite">
                <SettingsIcon className="mr-2 h-4 w-4" />
                {t("Worksite settings")}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {locationMissing && (primaryRole === "company_admin" || primaryRole === "super_admin") && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">{t("No worksite location set")}</p>
            <p>
              {t(
                "Set your company's worksite location and geofence radius so employees can clock in.",
              )}{" "}
              <Link to="/worksite" className="underline">
                {t("Open worksite settings →")}
              </Link>
            </p>
          </div>
        </div>
      )}
      {locationMissing && primaryRole === "employee" && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{t("Your company hasn't set a worksite yet. Ask a manager to configure it.")}</p>
        </div>
      )}

      {/* The map is for managers checking where punches came from. An employee
          clocking in does not need to watch themselves on a map, and their own
          position is not something to put on screen for whoever walks past. */}
      <div className={`grid gap-6 ${showMap ? "lg:grid-cols-[1.2fr_1fr]" : ""}`}>
        {showMap && (
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            {center[0] === 0 && center[1] === 0 ? (
              <div className="grid h-[320px] place-items-center text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("Waiting for GPS…")}
                </div>
              </div>
            ) : (
              <LeafletMap
                center={center}
                zoom={16}
                pins={pins}
                circle={
                  company_loc
                    ? { lat: company_loc.lat, lng: company_loc.lng, radiusM: radius }
                    : undefined
                }
                height={360}
              />
            )}
            <div className="border-t border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              {t("Map data © OpenStreetMap contributors")}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
              <Clock className="h-4 w-4 text-primary" /> {t("Current status")}
            </div>
            <div className="mb-4 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("Last punch")}</span>
              {punchesLoading ? (
                <Skeleton className="h-4 w-28" />
              ) : (
                <span className="font-medium text-foreground">
                  {lastPunch
                    ? `${t(PUNCH_LABEL[lastPunch.kind])} · ${new Date(lastPunch.at).toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" })}`
                    : "—"}
                </span>
              )}
            </div>

            {status !== "off" && shift.startedAt != null && (
              <div className="mb-5 rounded-xl border border-border bg-secondary/40 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("Worked this shift")}
                  </span>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {fmtWorked(workedMs)}
                  </span>
                </div>
                <p className="mt-0.5 text-right text-xs text-muted-foreground">
                  {t("since")}{" "}
                  {new Date(shift.startedAt).toLocaleTimeString(tag, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {shift.closedUnpaidMs + liveUnpaidMs > 0 &&
                    ` · ${t("{time} unpaid break deducted", { time: fmtWorked(shift.closedUnpaidMs + liveUnpaidMs) })}`}
                </p>
                {openLate?.late && (
                  <p className="mt-1 text-right text-xs font-medium text-red-700 dark:text-red-300">
                    {t("You clocked in {n} min late for your {time} shift.", {
                      n: openLate.minutesLate,
                      time: new Date(openLate.shiftStart).toLocaleTimeString(tag, {
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })}
                  </p>
                )}

                {earnings ? (
                  <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">{t("Gross")}</span>
                      <span className="font-mono tabular-nums text-foreground">
                        {fmtAmount(earnings.gross)}
                      </span>
                    </div>
                    {pay!.taxPercent > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {t("Federal tax ({pct}%)", { pct: pay!.taxPercent })}
                        </span>
                        <span className="font-mono tabular-nums text-destructive">
                          −{fmtAmount(earnings.federalTax)}
                        </span>
                      </div>
                    )}
                    {pay!.statePercent > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {t("State tax ({pct}%)", { pct: pay!.statePercent })}
                        </span>
                        <span className="font-mono tabular-nums text-destructive">
                          −{fmtAmount(earnings.stateTax)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between pt-1">
                      <span className="font-medium text-foreground">{t("Take-home")}</span>
                      <span className="font-mono text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {fmtAmount(earnings.net)}
                      </span>
                    </div>
                    <p className="pt-1 text-right text-[11px] text-muted-foreground">
                      {t("Estimate at {rate}/hr · visible only to you", {
                        rate: fmtAmount(pay!.hourlyRate),
                      })}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                    {t("Add your hourly pay below to see what you've earned so far.")}
                  </p>
                )}
              </div>
            )}

            {status === "on_break" && (
              <div
                className={`mb-5 rounded-xl border px-3 py-3 text-center ${
                  breakRemainingMs != null && breakRemainingMs <= 0
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
                }`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {breakRemainingMs == null
                    ? t("On break for")
                    : breakRemainingMs > 0
                      ? t("Break ends in")
                      : t("Break over by")}
                </p>
                <p
                  className={`mt-0.5 font-mono text-3xl font-semibold tabular-nums ${
                    breakRemainingMs != null && breakRemainingMs <= 0
                      ? "text-destructive"
                      : "text-amber-900 dark:text-amber-200"
                  }`}
                >
                  {fmtCountdown(
                    breakRemainingMs == null
                      ? now - (breakStartedAt ?? now)
                      : Math.abs(breakRemainingMs),
                  )}
                </p>
                {breakStartedAt != null && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {breakMinutes != null ? `${t("{n}-minute break", { n: breakMinutes })} · ` : ""}
                    {t("started")}{" "}
                    {new Date(breakStartedAt).toLocaleTimeString(tag, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                )}
              </div>
            )}

            {geoErr && (
              <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {geoErr}
                {gpsBlocks && (
                  <p className="mt-2 font-medium">
                    {t("Your team needs your GPS location to clock in. Turn on location and try again.")}
                  </p>
                )}
                {gpsOffUnderFence && !gpsBlocks && (
                  <div className="mt-2 space-y-2">
                    <p className="font-medium">
                      {graceExpired
                        ? t(GPS_BLOCKED_MSG)
                        : t(
                            "Your GPS is off. You can still clock in for {n} more day(s), but your admin will be notified. After that you will not be able to clock in until location is turned on.",
                            {
                              n: graceDaysLeft,
                            },
                          )}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant={graceExpired ? "destructive" : "outline"}
                      className="w-full"
                      onClick={goToLocationSettings}
                    >
                      <MapPin className="mr-1.5 h-3.5 w-3.5" />
                      {t("Allow location for this app")}
                    </Button>
                    {settingsHelp && (
                      <p className="text-foreground/80">
                        {t(
                          "Your browser is blocking location for this site. Tap the lock or settings icon next to the address bar, set Location to Allow, then reload the page.",
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {workLocations.length >= 2 && (
              <div className="mb-4">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5" />
                  {status === "off"
                    ? t("Where are you clocking in?")
                    : t("Where are you working now?")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {workLocations.map((l) => {
                    const current =
                      status === "off" ? pickedLocation === l.id : currentLocation === l.id;
                    return (
                      <Button
                        key={l.id}
                        type="button"
                        size="sm"
                        variant={current ? "default" : "outline"}
                        className="h-auto min-h-9 whitespace-normal py-1.5"
                        aria-pressed={current}
                        disabled={
                          moveMut.isPending ||
                          (status === "on_break" && !current) ||
                          (status !== "off" && (!coords || fenceBlocks))
                        }
                        onClick={() => {
                          setFlash(null);
                          if (status === "off") setPickedLocation(current ? "" : l.id);
                          else if (!current) moveMut.mutate(l.id);
                        }}
                      >
                        {moveMut.isPending && moveMut.variables === l.id && (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        )}
                        {l.name}
                      </Button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {status === "off"
                    ? pickedLocation
                      ? t("Your time will count at the one you picked.")
                      : t("Pick one, or leave it and we'll go by your schedule.")
                    : status === "on_break"
                      ? t("End your break before changing location.")
                      : currentLocation && currentSince
                        ? t("Counting at {place} since {time}. Tap another when you move.", {
                            place: workLocations.find((l) => l.id === currentLocation)?.name ?? "",
                            time: new Date(currentSince).toLocaleTimeString(tag, {
                              hour: "numeric",
                              minute: "2-digit",
                            }),
                          })
                        : t("Tap where you are so your time counts there.")}
                </p>
              </div>
            )}

            <Button
              size="lg"
              className="w-full"
              disabled={
                punchesLoading ||
                waitingForGps ||
                locationMissing ||
                submitting ||
                punchMut.isPending ||
                fenceBlocks ||
                clockInBlockedNoGps ||
                gpsBlocks ||
                status === "on_break"
              }
              onClick={() => {
                setFlash(null);
                if (gpsOffUnderFence && nextKind === "in") {
                  setConfirmNoGps(true);
                  return;
                }
                setSubmitting(true);
                punchMut.mutate();
              }}
              variant={nextKind === "in" ? "default" : "secondary"}
            >
              {punchMut.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("Recording…")}
                </>
              ) : punchesLoading ? (
                // Until the punches arrive we don't know whether this is IN or OUT.
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("Loading…")}
                </>
              ) : waitingForGps && !locationMissing ? (
                // Was a plain disabled button for as long as GPS took — the
                // part of this page that looked frozen.
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("Waiting for GPS location…")}
                </>
              ) : nextKind === "in" ? (
                <>
                  <LogIn className="mr-2 h-4 w-4" />
                  {t("Clock IN")}
                </>
              ) : (
                <>
                  <LogOut className="mr-2 h-4 w-4" />
                  {t("Clock OUT")}
                </>
              )}
            </Button>

            {status === "off" && rules.early_clock_in_minutes != null && (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {t("Your team can clock in up to {n} minutes before a scheduled shift.", {
                  n: rules.early_clock_in_minutes,
                })}
              </p>
            )}

            {status !== "off" && status !== "on_break" && allowedBreaks.length > 0 && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("Start a break — choose length (10-min is paid; 30 & 60-min are unpaid):")}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {allowedBreaks.map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant="outline"
                      disabled={
                        waitingForGps || locationMissing || breakMut.isPending || fenceBlocks
                      }
                      onClick={() => {
                        setFlash(null);
                        breakMut.mutate(m);
                      }}
                    >
                      <Coffee className="mr-1 h-3.5 w-3.5" />
                      {m === 10 ? t("{n}m · paid", { n: m }) : t("{n}m", { n: m })}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {status !== "off" && status !== "on_break" && allowedBreaks.length === 0 && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {t("Breaks are turned off for your position.")}
              </p>
            )}
            {status !== "off" && rules.auto_meal_minutes > 0 && (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {t(
                  "Your meal break is automatic: {n} min comes off shifts of {h}h or more, so you don't need to clock out for it. If you punch a 30- or 60-minute break instead, nothing extra comes off. Missed it? Report it on your timecard.",
                  { n: rules.auto_meal_minutes, h: rules.auto_meal_after_hours },
                )}
              </p>
            )}
            {status === "on_break" && (
              <Button
                size="lg"
                variant="outline"
                className="mt-2 w-full"
                disabled={
                  waitingForGps ||
                  locationMissing ||
                  breakMut.isPending ||
                  fenceBlocks ||
                  breakLocked
                }
                onClick={() => {
                  setFlash(null);
                  breakMut.mutate(null);
                }}
              >
                {breakMut.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("Recording…")}
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    {t("End break")}
                  </>
                )}
              </Button>
            )}

            {status === "on_break" && (
              <p className="mt-3 text-center text-xs text-amber-700 dark:text-amber-300">
                {breakLocked
                  ? t(
                      "Your {n}-minute break has to run its full time. You can end it in {time} — only an admin can end it sooner.",
                      {
                        n: breakMinutes ?? 0,
                        time: fmtCountdown(breakRemainingMs!),
                      },
                    )
                  : t("You're on break. End your break before clocking out.")}
              </p>
            )}
            {fenceBlocks && (
              <p className="mt-3 text-center text-xs text-destructive">
                {t("You're outside the allowed area. Move closer to the worksite to punch.")}
              </p>
            )}
            {!rules.require_geofence && withinFence === false && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                {t("Geofence is off — punches allowed from any location.")}
              </p>
            )}
            {flash && (
              <p
                className={`mt-3 text-center text-xs ${
                  flash.kind === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : flash.kind === "warn"
                      ? "rounded-md border border-amber-300 bg-amber-50 p-3 font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                      : "text-destructive"
                }`}
              >
                {flash.msg}
              </p>
            )}
          </div>

          {user && <PaySettingsCard userId={user.id} settings={pay} onChange={setPay} />}

          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <MapPin className="h-4 w-4 text-primary" /> {t("Recent punches")}
            </div>
            <ul className="divide-y divide-border text-sm">
              {punchesLoading &&
                [0, 1, 2].map((i) => (
                  <li key={i} className="py-2.5">
                    <Skeleton className="h-4 w-2/3" />
                  </li>
                ))}
              {!punchesLoading && (recentQ.data ?? []).length === 0 && (
                <li className="py-3 text-muted-foreground">{t("No punches yet.")}</li>
              )}
              {[
                ...(recentQ.data ?? []),
                ...(movesQ.data ?? []).map((m) => ({ ...m, kind: "move" as const })),
              ]
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 10)
                .map((p) => {
                  if (p.kind === "move") {
                    return (
                      <li key={p.id} className="flex items-center justify-between py-2">
                        <div>
                          <span className="inline-block rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                            {t("MOVED")}
                          </span>
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {workLocations.find((l) => l.id === p.location_id)?.name}
                          </span>
                          <span className="ml-2 text-foreground">
                            {new Date(p.at).toLocaleString(tag)}
                          </span>
                        </div>
                      </li>
                    );
                  }
                  const styles: Record<PunchKind, string> = {
                    in: "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                    out: "bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300",
                    break_start:
                      "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
                    break_end:
                      "bg-purple-100 dark:bg-purple-500/15 text-purple-700 dark:text-purple-300",
                  };
                  return (
                    <li key={p.id} className="flex items-center justify-between py-2">
                      <div>
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${styles[p.kind]}`}
                        >
                          {t(PUNCH_LABEL[p.kind])}
                        </span>
                        <span className="ml-2 text-foreground">
                          {new Date(p.at).toLocaleString(tag)}
                        </span>
                        <LateBadge lateness={lateness.get(p.id)} className="ml-2" />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {p.distance_m != null ? `${Math.round(p.distance_m)} m` : "—"}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      </div>

      <AlertDialog open={confirmNoGps} onOpenChange={setConfirmNoGps}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Your GPS is not on")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Your company needs your location to confirm a valid clock-in. Turn on location for this app and try again.",
              )}{" "}
              {t(
                "If you clock in anyway, it will be marked as unverified and your admin will be notified.",
              )}{" "}
              {t(
                "You have {n} day(s) left to turn on location. After that you will not be able to clock in without it.",
                {
                  n: graceDaysLeft,
                },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmNoGps(false);
                void goToLocationSettings();
              }}
            >
              {t("Allow location for this app")}
            </Button>
            <AlertDialogAction
              onClick={() => {
                setSubmitting(true);
                punchMut.mutate();
              }}
            >
              {t("Clock in anyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
