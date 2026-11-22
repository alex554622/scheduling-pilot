import { useEffect, useRef, useState } from "react";
import { Loader2, ScanFace } from "lucide-react";
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
import { captureSamples, loadFaceApi, startCamera, type ScanStatus } from "@/lib/face";
import { useT } from "@/lib/i18n";

/** Descriptors saved per person. More cover more angles; the server takes 3 to 10. */
const SAMPLES = 5;

type Phase =
  | { kind: "consent" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "capturing"; status: ScanStatus; got: number }
  | { kind: "saving" }
  | { kind: "error"; message: string };

/**
 * Admin enrolls one person's face from this device's camera. Only the
 * 128-number descriptors are sent (enroll_employee_face); no photo leaves the
 * device or is kept.
 */
export function FaceEnrollDialog({
  person,
  onClose,
  onSaved,
}: {
  person: { id: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT("time");
  const open = !!person;
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "consent" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const apiRef = useRef<Awaited<ReturnType<typeof loadFaceApi>> | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [camOn, setCamOn] = useState(false);

  // Fresh state each time the dialog opens; camera off when it closes.
  useEffect(() => {
    if (!open) return;
    setConsent(false);
    setCamOn(false);
    setPhase({ kind: "consent" });
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
      const [api, stop] = await Promise.all([loadFaceApi(), startCamera(video)]);
      apiRef.current = api;
      stopRef.current = stop;
      setCamOn(true);
      setPhase({ kind: "ready" });
    } catch (e) {
      console.warn("[face enroll]", e);
      const name = e instanceof DOMException ? e.name : "";
      setPhase({
        kind: "error",
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
    const api = apiRef.current;
    const video = videoRef.current;
    if (!api || !video || !person) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "capturing", status: "look", got: 0 });
    let got = 0;
    const r = await captureSamples(api, video, {
      count: SAMPLES,
      gapMs: 400,
      timeoutMs: 30_000,
      signal: ctrl.signal,
      onStatus: (status) => !ctrl.signal.aborted && setPhase({ kind: "capturing", status, got }),
      onProgress: (n) => {
        got = n;
      },
    });
    if (ctrl.signal.aborted) return;
    if (!r.ok) {
      setPhase({
        kind: "error",
        message:
          r.reason === "unsteady"
            ? t(
                "The scans didn't match each other. Make sure only {name} is in front of the camera and try again.",
                { name: person.name },
              )
            : t(
                "Couldn't get a clear face in time. Face the camera in good light, blink once, and try again.",
              ),
      });
      return;
    }
    setPhase({ kind: "saving" });
    const { error } = await supabase.rpc("enroll_employee_face", {
      _user: person.id,
      _samples: r.samples,
      _consent: consent,
    });
    if (error) {
      const similar = error.message.match(/too similar to (.+) \(already enrolled\)/);
      setPhase({
        kind: "error",
        message: similar
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
    onSaved();
    onClose();
  }

  const statusText =
    phase.kind === "capturing"
      ? phase.status === "closer"
        ? t("Come a little closer")
        : phase.status === "one"
          ? t("Only one person in front of the camera, please.")
          : phase.status === "blink"
            ? t("Now blink")
            : t("Hold still and look at the camera… {n} of {total}", {
                n: phase.got,
                total: SAMPLES,
              })
      : null;

  const cameraShown = phase.kind !== "consent";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Enroll {name}'s face", { name: person?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {t(
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
              {t(
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
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-[78%] w-[52%] rounded-[50%] border-4 border-white/70" />
            </div>
            {(phase.kind === "loading" || phase.kind === "saving") && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="h-8 w-8 animate-spin text-white" />
              </div>
            )}
          </div>
        )}

        {statusText && (
          <p className="text-center text-sm font-medium" aria-live="polite">
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
            {t("Cancel")}
          </Button>
          {phase.kind === "consent" && (
            <Button onClick={() => void startCam()} disabled={!consent}>
              <ScanFace className="mr-2 h-4 w-4" /> {t("Start camera")}
            </Button>
          )}
          {(phase.kind === "ready" || (phase.kind === "error" && camOn)) && (
            <Button onClick={() => void capture()}>
              <ScanFace className="mr-2 h-4 w-4" />{" "}
              {phase.kind === "error" ? t("Try again") : t("Scan face")}
            </Button>
          )}
          {phase.kind === "error" && !camOn && (
            <Button onClick={() => void startCam()}>{t("Try again")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
