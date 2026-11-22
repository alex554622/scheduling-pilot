import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Coffee, Delete, KeyRound, LogIn, LogOut, Loader2, CheckCircle2, ScanFace } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BrandLogo } from "@/components/brand";
import { KioskFaceScan } from "@/components/kiosk-face-scan";
import { cameraSupported } from "@/lib/face";
import {
  KioskSlideshow,
  playableSlides,
  usePreloadedSlideImages,
  type KioskSlide,
} from "@/components/kiosk-slideshow";
import { noindexSeo } from "@/lib/seo";
import { translate, useLocaleTag, useT } from "@/lib/i18n";
import { translateRuleMessage } from "@/lib/team-rules";

/**
 * The shared clock-in screen: a tablet by the door that belongs to nobody.
 *
 * It is deliberately outside `_authenticated` and holds no session. Staff are
 * identified by their face (the default, once an admin has enrolled faces) or
 * by a 4-digit PIN. A face match on the server gives a short-lived ticket that
 * stands in for the PIN, so both paths punch through the same kiosk_state /
 * kiosk_punch rules. Every action goes through a kiosk_* RPC
 * that authenticates the *device* by the token in this URL. There is nothing
 * to navigate to from here — no links, no sign-in — so the device cannot reach
 * anyone's account, and losing the tablet leaks nothing but the ability to
 * punch, which an admin can revoke from the app.
 */
export const Route = createFileRoute("/clock/$token")({
  ssr: false,
  head: () => noindexSeo("Shared clock-in | Scheduling Pilot"),
  component: SharedClockInPage,
});

type Device = { company: string | null; label: string | null };
type Person = {
  /** What kiosk_punch is called with: the typed PIN, or a "face:<uuid>" ticket. */
  credential: string;
  name: string;
  state: "in" | "out" | "on_break";
  breaks: Record<string, boolean>;
  /** Until when a running break can't be ended from here; null once it can. */
  breakEndsAt: number | null;
};

/** Every kiosk_* RPC answers in this shape; a refused code is `ok: false`, not an error. */
type KioskReply = {
  ok: boolean;
  message?: string;
  company?: string;
  label?: string;
  name?: string;
  state?: Person["state"];
  breaks?: Record<string, boolean>;
  break_ends_at?: string | null;
  kind?: string;
  at?: string;
  /** Set on a clock-in past the grace period, when the company reads punches against the schedule. */
  late_minutes?: number;
};

/** How long a confirmation stays up before the screen is ready for the next person. */
const CONFIRM_MS = 4000;
const BREAK_LENGTHS = [10, 30, 60] as const;
/** How often the device picks up slideshow changes an admin made. */
const DISPLAY_REFRESH_MS = 5 * 60_000;
/** How long the slideshow takes to fade out; it swallows taps until then. */
const WAKE_FADE_MS = 350;
const NO_SLIDES: KioskSlide[] = [];

type DisplayConfig = { mode: "simple" | "slideshow"; idleSeconds: number; slides: KioskSlide[] };

/**
 * The admin's display settings (kiosk_display). Loaded beside the keypad, never
 * in front of it: until it answers, or if it fails, the device is the plain
 * keypad, so a slow or broken slideshow can't keep anyone from clocking in.
 */
function useKioskDisplay(token: string): DisplayConfig | null {
  const [display, setDisplay] = useState<DisplayConfig | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      supabase.rpc("kiosk_display", { _token: token }).then(({ data, error }) => {
        if (stopped) return;
        if (error) {
          // Keep whatever was showing; the next refresh tries again.
          console.warn("[shared clock-in] display settings", error);
          return;
        }
        const r = data as unknown as {
          ok?: boolean;
          mode?: string;
          idle_seconds?: number;
          slides?: KioskSlide[];
        } | null;
        if (!r?.ok) {
          setDisplay(null);
          return;
        }
        setDisplay({
          mode: r.mode === "slideshow" ? "slideshow" : "simple",
          idleSeconds: Math.max(5, r.idle_seconds ?? 30),
          slides: Array.isArray(r.slides) ? r.slides : [],
        });
      });
    void load();
    const id = setInterval(() => void load(), DISPLAY_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [token]);
  return display;
}

/** A server message in the screen's language, or `fallback` when there is none. */
function kioskText(message: string | undefined, fallback: string) {
  return translate(translateRuleMessage(message) ?? fallback);
}

/**
 * Whether to offer face clock-in: someone in the company has a face enrolled
 * and this browser can open a camera. Until it answers, the PIN keypad shows.
 */
function useFaceAvailable(token: string): boolean {
  const [enrolled, setEnrolled] = useState(false);
  useEffect(() => {
    if (!cameraSupported()) return;
    let stopped = false;
    const load = () =>
      supabase.rpc("kiosk_face_info", { _token: token }).then(({ data, error }) => {
        if (stopped) return;
        if (error) {
          console.warn("[shared clock-in] face info", error);
          return;
        }
        const r = data as { ok?: boolean; enrolled?: number } | null;
        setEnrolled(!!r?.ok && (r.enrolled ?? 0) > 0);
      });
    void load();
    const id = setInterval(() => void load(), DISPLAY_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [token]);
  return enrolled;
}

function callKiosk(
  fn: "kiosk_device_info" | "kiosk_state" | "kiosk_punch",
  args: Record<string, unknown>,
) {
  // The generated types carry these as Json; the shape is KioskReply.
  return supabase.rpc(fn, args as never).then(({ data, error }) => {
    if (error) {
      // A transport or setup failure, not a refused code. Say something the
      // person at the tablet can act on and leave the detail in the console
      // for whoever set the device up.
      console.error("[shared clock-in]", error);
      return {
        ok: false,
        message: translate("This clock-in screen can not reach the server. Ask an admin to check it."),
      } satisfies KioskReply;
    }
    return (data ?? { ok: false, message: translate("No answer from the server.") }) as unknown as KioskReply;
  });
}

function SharedClockInPage() {
  const t = useT("time");
  const tag = useLocaleTag();
  const { token } = Route.useParams();

  const [device, setDevice] = useState<Device | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [person, setPerson] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Ticks only while someone is looking at a break that can't be ended yet.
  const breakEndsAt = person?.breakEndsAt ?? null;
  useEffect(() => {
    if (breakEndsAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [breakEndsAt]);
  const breakLeftMs = breakEndsAt != null ? breakEndsAt - now : 0;

  // Slideshow mode: slides play while nobody is at the device.
  const display = useKioskDisplay(token);
  const readyImages = usePreloadedSlideImages(display?.slides ?? NO_SLIDES);
  const playable = useMemo(
    () => (display?.mode === "slideshow" ? playableSlides(display.slides, readyImages) : NO_SLIDES),
    [display, readyImages],
  );
  const slideshowOn = playable.length > 0;
  const idleMs = (display?.idleSeconds ?? 30) * 1000;
  const [idle, setIdle] = useState(true);
  const [fading, setFading] = useState(false);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    const mark = () => {
      lastActivity.current = Date.now();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, mark, { capture: true, passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, mark, { capture: true });
    };
  }, []);

  const wake = useCallback(() => {
    lastActivity.current = Date.now();
    setIdle(false);
    setFading(true);
  }, []);

  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFading(false), WAKE_FADE_MS);
    return () => clearTimeout(timer);
  }, [fading]);

  useEffect(() => {
    void callKiosk("kiosk_device_info", { _token: token }).then((reply) => {
      if (reply.ok) setDevice({ company: reply.company ?? null, label: reply.label ?? null });
      else setDeviceError(reply.message ?? t("This device link is no longer valid."));
    });
  }, [token, t]);

  // Face is the default way in; the PIN keypad is the second option.
  const faceAvailable = useFaceAvailable(token);
  const [faceBroken, setFaceBroken] = useState<string | null>(null);
  const [usePin, setUsePin] = useState(false);
  const faceMode = faceAvailable && !faceBroken && !usePin;
  // A new key restarts the face scan (camera stays off while it isn't shown).
  const [scanKey, setScanKey] = useState(0);

  const reset = useCallback(() => {
    setCode("");
    setPerson(null);
    setError(null);
    // The next person starts on the face scan again.
    setUsePin(false);
    setScanKey((k) => k + 1);
  }, []);

  /** Who is this (a typed PIN or a face ticket), and are they in or out? */
  const lookup = useCallback(
    (credential: string, fallback: string) => {
      setBusy(true);
      setError(null);
      void callKiosk("kiosk_state", { _token: token, _code: credential }).then((reply) => {
        setBusy(false);
        if (!reply.ok || !reply.name || !reply.state) {
          setError(kioskText(reply.message, fallback));
          setCode("");
          setScanKey((k) => k + 1);
          return;
        }
        setPerson({
          credential,
          name: reply.name,
          state: reply.state,
          breaks: reply.breaks ?? {},
          breakEndsAt: reply.break_ends_at ? new Date(reply.break_ends_at).getTime() : null,
        });
      });
    },
    [token],
  );

  // A confirmation clears itself, so the next person always walks up to a fresh
  // keypad rather than the last person's name.
  useEffect(() => {
    if (!confirmation) return;
    const timer = setTimeout(() => {
      setConfirmation(null);
      reset();
    }, CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmation, reset]);

  // Four digits is the whole code, so look the person up without an extra tap.
  useEffect(() => {
    if (code.length !== 4 || person || busy) return;
    lookup(code, "That code was not recognised.");
  }, [code, person, busy, lookup]);

  // Back to the slideshow after a quiet spell. Never while a request is in
  // flight, so a punch someone just made always gets its answer on screen.
  useEffect(() => {
    if (!slideshowOn || idle || busy || deviceError) return;
    const id = setInterval(() => {
      if (Date.now() - lastActivity.current < idleMs) return;
      setConfirmation(null);
      reset();
      setIdle(true);
    }, 1000);
    return () => clearInterval(id);
  }, [slideshowOn, idle, busy, deviceError, idleMs, reset]);

  async function punch(action: "clock" | "break", minutes?: number) {
    if (!person) return;
    setBusy(true);
    setError(null);
    const reply = await callKiosk("kiosk_punch", {
      _token: token,
      _code: person.credential,
      _action: action,
      _minutes: minutes ?? null,
    });
    setBusy(false);
    if (!reply.ok) {
      setError(kioskText(reply.message, "That didn't go through. Try again."));
      return;
    }
    const at = reply.at ? new Date(reply.at) : new Date();
    const time = at.toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" });
    const what: string =
      reply.kind === "in"
        ? t("Clocked in at {time}", { time })
        : reply.kind === "out"
          ? t("Clocked out at {time}", { time })
          : reply.kind === "break_start"
            ? t("Break started at {time}", { time })
            : t("Back from break at {time}", { time });
    setConfirmation(
      reply.late_minutes != null
        ? `${what} · ${t("{n} min late", { n: reply.late_minutes })}`
        : what,
    );
    setPerson((p) => (p ? { ...p, name: reply.name ?? p.name } : p));
  }

  if (deviceError) {
    return (
      <Screen>
        <p className="text-center text-lg text-destructive">{deviceError}</p>
      </Screen>
    );
  }

  if (!device) {
    return (
      <Screen>
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
      </Screen>
    );
  }

  return (
    <Screen>
      {slideshowOn && (idle || fading) && (
        <KioskSlideshow slides={playable} onWake={wake} fading={!idle} />
      )}
      <div className="text-center">
        <BrandLogo className="mx-auto h-14" />
        <h1 className="mt-4 text-2xl font-semibold text-foreground">
          {device.company ?? t("Clock in")}
        </h1>
        <p className="text-sm text-muted-foreground">{device.label}</p>
      </div>

      {confirmation && person ? (
        <div className="mt-10 text-center">
          <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" />
          <p className="mt-4 text-3xl font-semibold text-foreground">{person.name}</p>
          <p className="mt-2 text-xl text-muted-foreground">{confirmation}</p>
        </div>
      ) : person ? (
        <div className="mt-8 w-full">
          <p className="text-center text-3xl font-semibold text-foreground">{person.name}</p>
          <p className="mt-1 text-center text-base text-muted-foreground">
            {person.state === "out"
              ? t("Not clocked in")
              : person.state === "on_break"
                ? t("On break")
                : t("On the clock")}
          </p>

          <div className="mt-8 space-y-3">
            {person.state === "out" && (
              <BigButton onClick={() => void punch("clock")} disabled={busy} tone="go">
                <LogIn className="h-7 w-7" /> {t("Clock in")}
              </BigButton>
            )}

            {person.state === "in" && (
              <>
                <BigButton onClick={() => void punch("clock")} disabled={busy} tone="stop">
                  <LogOut className="h-7 w-7" /> {t("Clock out")}
                </BigButton>
                <div className="grid grid-cols-3 gap-3">
                  {BREAK_LENGTHS.filter((m) => person.breaks[String(m)] !== false).map((m) => (
                    <BigButton
                      key={m}
                      onClick={() => void punch("break", m)}
                      disabled={busy}
                      tone="quiet"
                    >
                      <Coffee className="h-6 w-6" /> {t("{n} min", { n: m })}
                    </BigButton>
                  ))}
                </div>
              </>
            )}

            {person.state === "on_break" && (
              <>
                <BigButton
                  onClick={() => void punch("break")}
                  disabled={busy || breakLeftMs > 0}
                  tone="go"
                >
                  <Coffee className="h-7 w-7" /> {t("End break")}
                </BigButton>
                {breakLeftMs > 0 && (
                  <p className="text-center text-base text-muted-foreground">
                    {t("Your break can end in {time}. Only an admin can end it sooner.", { time: fmtLeft(breakLeftMs) })}
                  </p>
                )}
              </>
            )}

            <button
              onClick={reset}
              className="mx-auto block px-4 py-3 text-base font-medium text-muted-foreground hover:text-foreground"
            >
              {t("Cancel")}
            </button>
          </div>
        </div>
      ) : faceMode ? (
        <div className="w-full">
          {/* Off while the slideshow covers the screen, so the camera isn't left running. */}
          {!(slideshowOn && idle) && (
            <KioskFaceScan
              key={scanKey}
              token={token}
              onTicket={(ticket) => lookup(ticket, "Face not recognised. Try again or use your PIN.")}
              onUnavailable={setFaceBroken}
              onActivity={() => {
                lastActivity.current = Date.now();
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setUsePin(true);
            }}
            disabled={busy}
            className="mx-auto mt-6 flex items-center gap-2 rounded-xl border border-border bg-card px-6 py-4 text-lg font-medium text-foreground shadow-sm hover:bg-accent disabled:opacity-50"
          >
            <KeyRound className="h-6 w-6" /> {t("Use PIN instead")}
          </button>
        </div>
      ) : (
        <div className="mt-8 w-full">
          {faceBroken && faceAvailable && (
            <p className="mb-4 rounded-lg bg-secondary px-4 py-3 text-center text-sm text-muted-foreground">
              {faceBroken}
            </p>
          )}
          <p className="text-center text-lg text-muted-foreground">{t("Enter your 4-digit code")}</p>

          <div
            className="mt-5 flex justify-center gap-3"
            aria-label={t("{n} of 4 digits entered", { n: code.length })}
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`h-14 w-12 rounded-xl border-2 text-center text-3xl leading-[3rem] ${
                  code[i]
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-border bg-card text-transparent"
                }`}
              >
                {code[i] ? "●" : "0"}
              </span>
            ))}
          </div>

          <div className="mx-auto mt-8 grid max-w-xs grid-cols-3 gap-3">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <KeypadKey
                key={d}
                onClick={() => setCode((c) => (c.length < 4 ? c + d : c))}
                disabled={busy}
              >
                {d}
              </KeypadKey>
            ))}
            <KeypadKey
              onClick={() => {
                setCode("");
                setError(null);
              }}
              disabled={busy}
              aria-label={t("Clear")}
            >
              <span className="text-lg">{t("Clear")}</span>
            </KeypadKey>
            <KeypadKey onClick={() => setCode((c) => (c.length < 4 ? c + "0" : c))} disabled={busy}>
              0
            </KeypadKey>
            <KeypadKey
              onClick={() => setCode((c) => c.slice(0, -1))}
              disabled={busy}
              aria-label={t("Backspace")}
            >
              <Delete className="h-7 w-7" />
            </KeypadKey>
          </div>
          {faceAvailable && !faceBroken && (
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="mx-auto mt-6 flex items-center gap-2 px-4 py-3 text-base font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <ScanFace className="h-5 w-5" /> {t("Use face instead")}
            </button>
          )}
        </div>
      )}

      {busy && <Loader2 className="mt-6 h-6 w-6 animate-spin text-muted-foreground" />}
      {error && (
        <p className="mt-6 rounded-lg bg-destructive/10 px-4 py-3 text-center text-base font-medium text-destructive">
          {error}
        </p>
      )}
    </Screen>
  );
}

/** m:ss until a break may end. */
function fmtLeft(ms: number) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Full-screen frame with nothing to navigate to. */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen select-none flex-col items-center justify-center bg-secondary/40 px-4 py-8">
      <div className="flex w-full max-w-md flex-col items-center">{children}</div>
    </div>
  );
}

function KeypadKey({
  children,
  onClick,
  disabled,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-20 items-center justify-center rounded-2xl border border-border bg-card text-3xl font-medium text-foreground shadow-sm transition-colors hover:bg-accent active:bg-accent disabled:opacity-50"
      {...rest}
    >
      {children}
    </button>
  );
}

function BigButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: "go" | "stop" | "quiet";
}) {
  const tones = {
    go: "bg-emerald-600 text-white hover:bg-emerald-700",
    stop: "bg-primary text-primary-foreground hover:bg-primary/90",
    quiet: "border border-border bg-card text-foreground hover:bg-accent",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-20 w-full items-center justify-center gap-3 rounded-2xl text-2xl font-semibold shadow-sm transition-colors disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
