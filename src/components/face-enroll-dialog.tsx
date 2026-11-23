import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, ScanFace } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  captureSamples,
  loadFaceEngine,
  startCamera,
  type FaceEngine,
  type ScanStatus,
} from "@/lib/face";
import { useT } from "@/lib/i18n";

/** Descriptors saved per person. More cover more angles; the server takes 3 to 10. */
const SAMPLES = 5;
/** How long it keeps trying before it asks to try again. */
const CAPTURE_MS = 45_000;

type Phase =
  | { kind: "consent" }
  | { kind: "loading" }
  | { kind: "capturing"; status: ScanStatus; got: number }
  | { kind: "saving" }
  | { kind: "done" }
  | { kind: "error"; message: string; camera: boolean };

/**
 * Enrolls one person's face from this device's camera. Only descriptors are
 * sent; no photo leaves the device or is kept.
 *
 * Made to be easy: once the camera is on it scans by itself, tells the person
 * what to do (closer, look straight, one person only), drops blurry frames
 * instead of failing, and doesn't ask for a blink.
 *
 * An admin enrolling someone (enroll_employee_face) is approved at once. With
 * `self`, the signed-in person enrolls their own face (submit_my_face), and it
 * waits for an admin to approve it before the shared clock-in uses it.
 */
export function FaceEnrollDialog({
  person,
  self = false,
  onClose,
  onSaved,
}: {
  person: { id: string; name: string } | null;
  self?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT("time");
  const open = !!person;
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "consent" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<FaceEngine | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Fresh state each time the dialog opens; camera off when it closes.
  useEffect(() => {
    if (!open) return;
    setConsent(false);
    setPhase({ kind: "consent" });
    // Start loading the models while they read the consent text.
    void loadFaceEngine().catch(() => undefined);
    return () => {
      abortRef.current?.abort();
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [open, person?.id]);

  async function startCam() {
    setPhase({ kind: "loading" });
    try {
      // The <video> mounts with this phase; wait a frame for it.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const video = videoRef.current;
      if (!video) throw new Error("no video element");
      const [engine, stop] = await Promise.all([loadFaceEngine(), startCamera(video)]);
      engineRef.current = engine;
      stopRef.current = stop;
      void capture();
    } catch (e) {
      console.warn("[face enroll]", e);
      const name = e instanceof DOMException ? e.name : "";
      setPhase({
        kind: "error",
        camera: false,
        message:
          name === "NotAllowedError" || name === "SecurityError"
            ? t("The camera is blocked. Allow the camera for this site and try again.")
            : name === "NotFoundError"
              ? t("No camera found on this device.")
              : t("Face recognition can't start on this device."),
      });
    }
  }

  async function capture() {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video || !person) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let got = 0;
    let status: ScanStatus = "look";
    setPhase({ kind: "capturing", status, got });
    const r = await captureSamples(engine, video, {
      count: SAMPLES,
      gapMs: 350,
      timeoutMs: CAPTURE_MS,
      signal: ctrl.signal,
      onStatus: (s) => {
        if (ctrl.signal.aborted || s === status) return;
        status = s;
        setPhase({ kind: "capturing", status, got });
      },
      onProgress: (n) => {
        if (ctrl.signal.aborted || n === got) return;
        got = n;
        setPhase({ kind: "capturing", status, got });
      },
    });
    if (ctrl.signal.aborted) return;
    if (!r.ok) {
      setPhase({
        kind: "error",
        camera: true,
        message: t(
          "Couldn't see the face clearly enough. Face the camera with light on your face (not behind you) and try again.",
        ),
      });
      return;
    }
    setPhase({ kind: "saving" });
    const { error } = self
      ? await supabase.rpc("submit_my_face", { _samples: r.samples, _consent: consent })
      : await supabase.rpc("enroll_employee_face", {
          _user: person.id,
          _samples: r.samples,
          _consent: consent,
        });
    if (ctrl.signal.aborted) return;
    if (error) {
      const similar = error.message.match(/too similar to (.+) \(already enrolled\)/);
      setPhase({
        kind: "error",
        camera: true,
        message: error.message.includes("already enrolled for someone else")
          ? t("This face is already enrolled for someone else. Ask an admin for help.")
          : error.message.includes("must agree")
            ? t("Tick the box to agree first.")
            : similar
              ? t(
                  "This face is too similar to {name}, who is already enrolled. Each person can only be enrolled once.",
                  { name: similar[1] },
                )
              : error.message.includes("do not match each other")
                ? t(
                    "The scans didn't match each other. Make sure only {name} is in front of the camera and try again.",
                    { name: person.name },
                  )
                : error.message,
      });
      return;
    }
    stopRef.current?.();
    stopRef.current = null;
    setPhase({ kind: "done" });
    onSaved();
    setTimeout(onClose, 1200);
  }

  const capturing = phase.kind === "capturing" ? phase : null;
  const good = capturing?.status === "hold";
  const statusText = capturing
    ? capturing.status === "closer"
      ? t("Come a little closer")
      : capturing.status === "one"
        ? t("Only one person in front of the camera, please.")
        : capturing.status === "straight"
          ? t("Look straight at the camera")
          : capturing.status === "hold"
            ? t("Great, hold still…")
            : t("Put your face inside the oval")
    : phase.kind === "loading"
      ? t("Starting the camera…")
      : phase.kind === "saving"
        ? t("Saving…")
        : null;

  const cameraShown = phase.kind !== "consent";
  const progress = capturing ? capturing.got / SAMPLES : phase.kind === "consent" ? 0 : 1;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {self
              ? t("Set up face clock-in")
              : t("Enroll {name}'s face", { name: person?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {self
              ? t(
                  "Face your camera in good light, with nobody else in view. Only a set of numbers describing your face is saved, never a photo. An admin has to approve it before you can clock in with it on the shared clock-in.",
                )
              : t(
                  "Have {name} face this device's camera in good light. Only a set of numbers describing the face is saved, never a photo. They can then clock in on the shared clock-in by looking at it.",
                  { name: person?.name ?? "" },
                )}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "consent" && (
          <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => setConsent(v === true)}
              className="mt-0.5"
            />
            <span>
              {self
                ? t(
                    "I agree to use my face to clock in. I can remove it at any time and use my PIN instead.",
                  )
                : t(
                    "{name} agrees to use their face to clock in. They can ask for it to be removed at any time and use their PIN instead.",
                    { name: person?.name ?? "" },
                  )}
            </span>
          </label>
        )}

        {cameraShown && (
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
            <video
              ref={videoRef}
              className="h-full w-full -scale-x-100 object-cover"
              muted
              playsInline
              autoPlay
            />
            {/* The oval turns green while it is taking good scans. */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={`h-[78%] w-[52%] rounded-[50%] border-4 transition-colors ${
                  phase.kind === "done" || good ? "border-emerald-400" : "border-white/70"
                }`}
              />
            </div>
            {(phase.kind === "loading" || phase.kind === "saving") && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="h-8 w-8 animate-spin text-white" />
              </div>
            )}
            {phase.kind === "done" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white">
                <CheckCircle2 className="h-14 w-14 text-emerald-400" />
                <span className="text-lg font-semibold">
                  {self ? t("Sent for approval") : t("Face saved")}
                </span>
              </div>
            )}
          </div>
        )}

        {cameraShown && phase.kind !== "error" && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}

        {statusText && (
          <p className="text-center text-base font-medium" aria-live="polite">
            {statusText}
          </p>
        )}
        {phase.kind === "error" && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {phase.message}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {phase.kind === "done" ? t("Close") : t("Cancel")}
          </Button>
          {phase.kind === "consent" && (
            <Button onClick={() => void startCam()} disabled={!consent}>
              <ScanFace className="mr-2 h-4 w-4" /> {t("Start camera")}
            </Button>
          )}
          {phase.kind === "error" && (
            <Button onClick={() => void (phase.camera ? capture() : startCam())}>
              <ScanFace className="mr-2 h-4 w-4" /> {t("Try again")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
