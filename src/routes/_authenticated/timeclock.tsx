import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useAppRules } from "@/lib/app-rules";
import { Button } from "@/components/ui/button";
import { LeafletMap } from "@/components/leaflet-map";
import { PaySettingsCard } from "@/components/pay-settings-card";
import { readPaySettings, type PaySettings } from "@/lib/pay-settings";
import { Clock, MapPin, Loader2, LogIn, LogOut, AlertTriangle, FileClock, Settings as SettingsIcon, Coffee, Play, Users } from "lucide-react";

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
};

const PUNCH_LABEL: Record<PunchKind, string> = {
  in: "IN",
  out: "OUT",
  break_start: "BREAK START",
  break_end: "BREAK END",
};

/** A paid 10-minute break still counts as time worked; 30 and 60 do not. */
const PAID_BREAK_MINUTES = 10;

/** "3h 42m" — the shape used for worked time everywhere in the app. */
function fmtWorked(ms: number): string {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Money with no currency symbol — the rate is whatever the user typed. */
function fmtAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

type Company = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
};

function TimeclockPage() {
  const { user, company, primaryRole, loading } = useAuth();
  const rules = useAppRules();
  const qc = useQueryClient();
  const [coords, setCoords] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

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
        .select("id, kind, at, latitude, longitude, distance_m, within_geofence, break_minutes")
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

  const lastPunch = recentQ.data?.[0];
  // Derived status: off | working | on_break
  const status: "off" | "working" | "on_break" =
    !lastPunch || lastPunch.kind === "out" ? "off"
    : lastPunch.kind === "break_start" ? "on_break"
    : "working";
  const nextKind: "in" | "out" = status === "off" ? "in" : "out";

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
  const breakStartedAt = status === "on_break" && lastPunch ? new Date(lastPunch.at).getTime() : null;
  const breakMinutes = status === "on_break" ? lastPunch?.break_minutes ?? null : null;
  const breakEndsAt = breakStartedAt != null && breakMinutes != null ? breakStartedAt + breakMinutes * 60_000 : null;
  const breakRemainingMs = breakEndsAt != null ? breakEndsAt - now : null;

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
        if (openBreakMinutes !== PAID_BREAK_MINUTES) closedUnpaidMs += at - openBreakAt;
        openBreakAt = null;
        openBreakMinutes = null;
      }
    }
    return { startedAt, closedUnpaidMs, openBreakAt, openBreakMinutes };
  }, [recentQ.data]);

  const liveUnpaidMs =
    shift.openBreakAt != null && shift.openBreakMinutes !== PAID_BREAK_MINUTES
      ? Math.max(0, now - shift.openBreakAt)
      : 0;
  const workedMs =
    shift.startedAt == null ? 0 : Math.max(0, now - shift.startedAt - shift.closedUnpaidMs - liveUnpaidMs);

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

  // Watch position
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeoErr("Geolocation not supported on this device.");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy });
        setGeoErr(null);
      },
      (err) => setGeoErr(err.message || "Unable to read location"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const company_loc = companyQ.data?.latitude != null && companyQ.data?.longitude != null
    ? { lat: companyQ.data.latitude!, lng: companyQ.data.longitude! }
    : null;

  const distance = useMemo(() => {
    if (!coords || !company_loc) return null;
    return haversineM(coords.lat, coords.lng, company_loc.lat, company_loc.lng);
  }, [coords, company_loc?.lat, company_loc?.lng]);

  const radius = companyQ.data?.geofence_radius_m ?? 200;
  const withinFence = distance == null ? null : distance <= radius;
  const fenceBlocks = rules.require_geofence && withinFence === false;
  const allowedBreaks = ([10, 30, 60] as const).filter(
    (m) => (m === 10 && rules.allow_break_10) || (m === 30 && rules.allow_break_30) || (m === 60 && rules.allow_break_60),
  );

  const center: [number, number] = company_loc
    ? [company_loc.lat, company_loc.lng]
    : coords
      ? [coords.lat, coords.lng]
      : [0, 0];

  const pins = [];
  if (company_loc) pins.push({ lat: company_loc.lat, lng: company_loc.lng, label: "Worksite" });
  if (coords) pins.push({ lat: coords.lat, lng: coords.lng, label: "You" });

  const punchMut = useMutation({
    mutationFn: async () => {
      if (!coords) throw new Error("Waiting for GPS location…");
      const { data, error } = await supabase.rpc("clock_punch", {
        _lat: coords.lat,
        _lng: coords.lng,
        _accuracy: coords.acc,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      setFlash({ kind: "ok", msg: `Clocked ${nextKind === "in" ? "in" : "out"} successfully.` });
      qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
      qc.invalidateQueries({ queryKey: ["timecards"] });
    },
    onError: (e: any) => setFlash({ kind: "err", msg: e.message || "Failed to punch" }),
    onSettled: () => setSubmitting(false),
  });

  const breakMut = useMutation({
    mutationFn: async (minutes: 10 | 30 | 60 | null) => {
      if (!coords) throw new Error("Waiting for GPS location…");
      // Ending a break omits _minutes entirely (the SQL default is NULL);
      // break_punch only requires a length when starting one.
      const { data, error } = await supabase.rpc("break_punch", {
        _lat: coords.lat,
        _lng: coords.lng,
        _accuracy: coords.acc,
        ...(minutes !== null ? { _minutes: minutes } : {}),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      setFlash({ kind: "ok", msg: status === "on_break" ? "Break ended." : "Break started." });
      qc.invalidateQueries({ queryKey: ["my-punches-recent"] });
      qc.invalidateQueries({ queryKey: ["timecards"] });
    },
    onError: (e: any) => setFlash({ kind: "err", msg: e.message || "Failed" }),
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!company) return <div className="text-sm text-muted-foreground">Join a company to use the time clock.</div>;

  const locationMissing = !company_loc;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Time clock</h1>
          <p className="text-sm text-muted-foreground">Clock in and out — your location is recorded with each punch.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/timecards"><FileClock className="mr-2 h-4 w-4" />My timecard</Link>
          </Button>
          {(primaryRole === "company_admin" || primaryRole === "super_admin") && (
            <Button asChild variant="outline" size="sm">
              <Link to="/whos-in"><Users className="mr-2 h-4 w-4" />Who's clocked in</Link>
            </Button>
          )}
          {(primaryRole === "company_admin" || primaryRole === "super_admin") && (
            <Button asChild variant="outline" size="sm">
              <Link to="/worksite"><SettingsIcon className="mr-2 h-4 w-4" />Worksite settings</Link>
            </Button>
          )}
        </div>
      </div>

      {locationMissing && (primaryRole === "company_admin" || primaryRole === "super_admin") && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">No worksite location set</p>
            <p>Set your company's worksite location and geofence radius so employees can clock in. <Link to="/worksite" className="underline">Open worksite settings →</Link></p>
          </div>
        </div>
      )}
      {locationMissing && primaryRole === "employee" && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>Your company hasn't set a worksite yet. Ask a manager to configure it.</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          {center[0] === 0 && center[1] === 0 ? (
            <div className="grid h-[320px] place-items-center text-sm text-muted-foreground">
              <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Waiting for GPS…</div>
            </div>
          ) : (
            <LeafletMap
              center={center}
              zoom={16}
              pins={pins}
              circle={company_loc ? { lat: company_loc.lat, lng: company_loc.lng, radiusM: radius } : undefined}
              height={360}
            />
          )}
          <div className="border-t border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Map data © OpenStreetMap contributors
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
              <Clock className="h-4 w-4 text-primary" /> Current status
            </div>
            <div className="mb-4 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Last punch</span>
              <span className="font-medium text-foreground">
                {lastPunch
                  ? `${PUNCH_LABEL[lastPunch.kind]} · ${new Date(lastPunch.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : "—"}
              </span>
            </div>

            {status !== "off" && shift.startedAt != null && (
              <div className="mb-5 rounded-xl border border-border bg-secondary/40 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Worked this shift
                  </span>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                    {fmtWorked(workedMs)}
                  </span>
                </div>
                <p className="mt-0.5 text-right text-xs text-muted-foreground">
                  since {new Date(shift.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  {shift.closedUnpaidMs + liveUnpaidMs > 0 && ` · ${fmtWorked(shift.closedUnpaidMs + liveUnpaidMs)} unpaid break deducted`}
                </p>

                {earnings ? (
                  <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Gross</span>
                      <span className="font-mono tabular-nums text-foreground">{fmtAmount(earnings.gross)}</span>
                    </div>
                    {pay!.taxPercent > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Federal tax ({pay!.taxPercent}%)</span>
                        <span className="font-mono tabular-nums text-destructive">−{fmtAmount(earnings.federalTax)}</span>
                      </div>
                    )}
                    {pay!.statePercent > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">State tax ({pay!.statePercent}%)</span>
                        <span className="font-mono tabular-nums text-destructive">−{fmtAmount(earnings.stateTax)}</span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between pt-1">
                      <span className="font-medium text-foreground">Take-home</span>
                      <span className="font-mono text-xl font-semibold tabular-nums text-emerald-600">
                        {fmtAmount(earnings.net)}
                      </span>
                    </div>
                    <p className="pt-1 text-right text-[11px] text-muted-foreground">
                      Estimate at {fmtAmount(pay!.hourlyRate)}/hr · visible only to you
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                    Add your hourly pay below to see what you've earned so far.
                  </p>
                )}
              </div>
            )}

            {status === "on_break" && (
              <div
                className={`mb-5 rounded-xl border px-3 py-3 text-center ${
                  breakRemainingMs != null && breakRemainingMs <= 0
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-amber-300 bg-amber-50"
                }`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {breakRemainingMs == null
                    ? "On break for"
                    : breakRemainingMs > 0
                      ? "Break ends in"
                      : "Break over by"}
                </p>
                <p
                  className={`mt-0.5 font-mono text-3xl font-semibold tabular-nums ${
                    breakRemainingMs != null && breakRemainingMs <= 0 ? "text-destructive" : "text-amber-900"
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
                    {breakMinutes != null ? `${breakMinutes}-minute break · ` : ""}
                    started {new Date(breakStartedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </p>
                )}
              </div>
            )}

            {geoErr && (
              <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                {geoErr}
              </div>
            )}

            <Button
              size="lg"
              className="w-full"
              disabled={!coords || locationMissing || submitting || punchMut.isPending || fenceBlocks || status === "on_break"}
              onClick={() => { setSubmitting(true); setFlash(null); punchMut.mutate(); }}
              variant={nextKind === "in" ? "default" : "secondary"}
            >
              {punchMut.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Recording…</>
              ) : nextKind === "in" ? (
                <><LogIn className="mr-2 h-4 w-4" />Clock IN</>
              ) : (
                <><LogOut className="mr-2 h-4 w-4" />Clock OUT</>
              )}
            </Button>

            {status !== "off" && status !== "on_break" && allowedBreaks.length > 0 && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground">Start a break — choose length (10-min is paid; 30 & 60-min are unpaid):</p>
                <div className="grid grid-cols-3 gap-2">
                  {allowedBreaks.map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant="outline"
                      disabled={!coords || locationMissing || breakMut.isPending || fenceBlocks}
                      onClick={() => { setFlash(null); breakMut.mutate(m); }}
                    >
                      <Coffee className="mr-1 h-3.5 w-3.5" />
                      {m}m{m === 10 ? " · paid" : ""}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {status !== "off" && status !== "on_break" && allowedBreaks.length === 0 && (
              <p className="mt-3 text-center text-xs text-muted-foreground">Breaks are disabled by your company's App rules.</p>
            )}
            {status === "on_break" && (
              <Button
                size="lg"
                variant="outline"
                className="mt-2 w-full"
                disabled={!coords || locationMissing || breakMut.isPending || fenceBlocks}
                onClick={() => { setFlash(null); breakMut.mutate(null); }}
              >
                {breakMut.isPending ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Recording…</>
                ) : (
                  <><Play className="mr-2 h-4 w-4" />End break</>
                )}
              </Button>
            )}

            {status === "on_break" && (
              <p className="mt-3 text-center text-xs text-amber-700">
                You're on break. End your break before clocking out.
              </p>
            )}
            {fenceBlocks && (
              <p className="mt-3 text-center text-xs text-destructive">
                You're outside the allowed area. Move closer to the worksite to punch.
              </p>
            )}
            {!rules.require_geofence && withinFence === false && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Geofence is off — punches allowed from any location.
              </p>
            )}
            {flash && (
              <p className={`mt-3 text-center text-xs ${flash.kind === "ok" ? "text-emerald-600" : "text-destructive"}`}>
                {flash.msg}
              </p>
            )}
          </div>

          {user && <PaySettingsCard userId={user.id} settings={pay} onChange={setPay} />}

          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <MapPin className="h-4 w-4 text-primary" /> Recent punches
            </div>
            <ul className="divide-y divide-border text-sm">
              {(recentQ.data ?? []).length === 0 && (
                <li className="py-3 text-muted-foreground">No punches yet.</li>
              )}
              {(recentQ.data ?? []).slice(0, 10).map((p) => {
                const styles: Record<PunchKind, string> = {
                  in: "bg-emerald-100 text-emerald-700",
                  out: "bg-blue-100 text-blue-700",
                  break_start: "bg-amber-100 text-amber-700",
                  break_end: "bg-purple-100 text-purple-700",
                };
                return (
                  <li key={p.id} className="flex items-center justify-between py-2">
                    <div>
                      <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${styles[p.kind]}`}>
                        {PUNCH_LABEL[p.kind]}
                      </span>
                      <span className="ml-2 text-foreground">{new Date(p.at).toLocaleString()}</span>
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
    </div>
  );
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
