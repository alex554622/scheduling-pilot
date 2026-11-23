import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2, ScanFace } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  loadFaceEngine,
  scanLiveFace,
  startCamera,
  type FaceEngine,
  type ScanDebug,
  type ScanStatus,
} from "@/lib/face";
import { translate, useT } from "@/lib/i18n";

/** How long one scan watches for a live face before it stops and waits for a tap. */
const SCAN_MS = 20_000;
/** Scans in a row before it stops and waits for a tap (each one is a server match). */
const AUTO_RETRIES = 3;

type Phase =
  | { kind: "loading" }
  | { kind: "scanning"; status: ScanStatus }
  | { kind: "matching" }
  | { kind: "paused"; message: string | null }
  | { kind: "done" };

/**
 * The face side of the shared clock-in: the front camera, a live-face scan,
 * and a server match (kiosk_face_match). On a match it hands the parent a
 * one-time ticket ("face:<uuid>"), which the parent uses exactly like a typed
 * code with kiosk_state / kiosk_punch, so every server rule still applies.
 *
 * Remount it (change its key) to scan again.
 */
export function KioskFaceScan({
  token,
  onTicket,
  onUnavailable,
  onActivity,
}: {
  token: string;
  onTicket: (ticket: string) => void;
  /** The camera or the models can't be used here; the parent falls back to the PIN. */
  onUnavailable: (message: string) => void;
  /** A face is in view: keeps the slideshow from coming back mid-scan. */
  onActivity: () => void;
}) {
  const t = useT("time");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [run, setRun] = useState(0);
  const apiRef = useRef<FaceEngine | null>(null);
  const failures = useRef(0);
  // ?debug=face on the device link shows live numbers over the camera.
  const [debugOn] = useState(
    () => typeof window !== "undefined" && /[?&]debug=face/.test(window.location.search),
  );
  const [debug, setDebug] = useState<ScanDebug | null>(null);

  // Keep the latest callbacks without restarting the camera when they change.
  const cb = useRef({ onTicket, onUnavailable, onActivity });
  useEffect(() => {
    cb.current = { onTicket, onUnavailable, onActivity };
  });

  // Camera and models, once per mount.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const video = videoRef.current;
        if (!video) return;
        const [api, stopCam] = await Promise.all([loadFaceEngine(), startCamera(video)]);
        stop = stopCam;
        if (cancelled) {
          stopCam();
          return;
        }
        apiRef.current = api;
        setReady(true);
      } catch (e) {
        console.warn("[shared clock-in] face scan unavailable", e);
        if (cancelled) return;
        const name = e instanceof DOMException ? e.name : "";
        cb.current.onUnavailable(
          name === "NotAllowedError" || name === "SecurityError"
            ? translate(
                "The camera is blocked on this device. Use your PIN, or ask an admin to allow the camera.",
              )
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? translate("This device has no camera. Use your PIN.")
              : translate("Face clock-in can't start on this device. Use your PIN."),
        );
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // One scan, then a server match.
  useEffect(() => {
    const api = apiRef.current;
    const video = videoRef.current;
    if (!ready || !api || !video) return;
    const ctrl = new AbortController();
    void (async () => {
      setPhase({ kind: "scanning", status: "look" });
      const outcome = await scanLiveFace(api, video, {
        timeoutMs: SCAN_MS,
        signal: ctrl.signal,
        onDebug: debugOn ? (d) => !ctrl.signal.aborted && setDebug(d) : undefined,
        onStatus: (status) => {
          if (ctrl.signal.aborted) return;
          if (status !== "look") cb.current.onActivity();
          setPhase((p) =>
            p.kind === "scanning" && p.status === status ? p : { kind: "scanning", status },
          );
        },
      });
      if (ctrl.signal.aborted) return;
      if (!outcome.ok) {
        setPhase({ kind: "paused", message: null });
        return;
      }
      setPhase({ kind: "matching" });
      const { data, error } = await supabase.rpc("kiosk_face_match", {
        _token: token,
        _descriptor: outcome.descriptor,
      });
      if (ctrl.signal.aborted) return;
      const reply = (data ?? null) as { ok?: boolean; ticket?: string; message?: string } | null;
      if (error || !reply) {
        console.error("[shared clock-in] face match", error);
        setPhase({
          kind: "paused",
          message: t("This clock-in screen can not reach the server. Ask an admin to check it."),
        });
        return;
      }
      if (reply.ok && reply.ticket) {
        failures.current = 0;
        setPhase({ kind: "done" });
        cb.current.onTicket(reply.ticket);
        return;
      }
      failures.current += 1;
      const message = translate(reply.message ?? "Face not recognised. Try again or use your PIN.");
      const locked = (reply.message ?? "").startsWith("Too many");
      if (!locked && failures.current < AUTO_RETRIES) {
        setPhase({ kind: "paused", message });
        // Show the message for a moment, then look again.
        setTimeout(() => {
          if (!ctrl.signal.aborted) setRun((n) => n + 1);
        }, 1500);
      } else {
        setPhase({ kind: "paused", message });
      }
    })();
    return () => ctrl.abort();
  }, [ready, run, token, t, debugOn]);

  const again = useCallback(() => {
    failures.current = 0;
    setRun((n) => n + 1);
  }, []);

  const statusText =
    phase.kind === "loading"
      ? t("Starting the camera…")
      : phase.kind === "matching"
        ? t("Checking…")
        : phase.kind === "scanning"
          ? phase.status === "closer"
            ? t("Come a little closer")
            : phase.status === "one"
              ? t("Only one person in front of the camera, please.")
              : phase.status === "straight"
                ? t("Look straight at the camera")
                : phase.status === "blink"
                  ? t("Look at the camera and blink")
                  : phase.status === "hold"
                    ? t("Great, hold still…")
                    : phase.status === "checking"
                      ? t("Checking…")
                      : t("Look at the camera and blink")
          : null;

  return (
    <div className="mt-8 flex w-full flex-col items-center">
      <div className="relative aspect-[4/3] w-full max-w-sm overflow-hidden rounded-3xl border-4 border-primary/40 bg-black shadow-sm">
        <video
          ref={videoRef}
          className="h-full w-full -scale-x-100 object-cover"
          muted
          playsInline
          autoPlay
        />
        {/* An oval to put your face in. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[78%] w-[52%] rounded-[50%] border-4 border-white/70" />
        </div>
        {phase.kind === "scanning" && phase.status === "blink" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-4 pb-5 pt-10 text-white">
            <Eye className="h-9 w-9 animate-pulse" />
            <span className="text-2xl font-bold">{t("Blink your eyes")}</span>
          </div>
        )}
        {debugOn && debug && (
          <pre className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-2 py-1 text-left text-[11px] leading-tight text-emerald-300">
            {`${debug.frame}  ${debug.ms}ms
size ${debug.share.toFixed(2)}  score ${debug.score.toFixed(2)}
eyes ${debug.eyes.toFixed(3)} / open ${debug.open.toFixed(3)}
samples ${debug.samples}  blinked ${debug.blinked ? "yes" : "no"}`}
          </pre>
        )}
        {(phase.kind === "loading" || phase.kind === "matching") && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-10 w-10 animate-spin text-white" />
          </div>
        )}
        {phase.kind === "paused" && (
          <button
            type="button"
            onClick={again}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white"
          >
            <ScanFace className="h-14 w-14" />
            <span className="text-xl font-semibold">{t("Tap to scan your face")}</span>
          </button>
        )}
      </div>
      {statusText && (
        <p className="mt-4 text-center text-xl font-medium text-foreground" aria-live="polite">
          {statusText}
        </p>
      )}
      {phase.kind === "paused" && phase.message && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-4 py-3 text-center text-base font-medium text-destructive">
          {phase.message}
        </p>
      )}
    </div>
  );
}
