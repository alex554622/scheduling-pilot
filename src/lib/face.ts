/**
 * Face recognition for the shared clock-in, in the browser.
 *
 * Uses @vladmandic/face-api (the maintained fork of face-api.js, TensorFlow.js
 * underneath): a tiny face detector, the 68-point landmark model and the
 * ResNet-34 recognition model, which turns a face into a 128-number
 * descriptor. Two descriptors of the same person are close (Euclidean
 * distance about 0.25-0.40); different people are far apart (0.55+).
 *
 * Everything here runs on the device. No frame leaves it: only descriptors
 * are sent, and matching happens on the server (kiosk_face_match), so the
 * tablet never holds anyone's face data. The models (about 7 MB, served from
 * /models/face) and the library are loaded only on the screens that use them.
 *
 * Liveness: a scan only counts after the person blinks (eye aspect ratio from
 * the landmarks drops and comes back). A printed photo or a still on a phone
 * can't blink. A video of someone can, which is why the server also requires
 * a clear margin over every other enrolled face and the PIN stays available.
 */

type FaceApi = typeof import("@vladmandic/face-api/dist/face-api.esm.js");

let apiPromise: Promise<FaceApi> | null = null;

/** Loads the library and the three models once. Rejects if the device can't run them. */
export function loadFaceApi(): Promise<FaceApi> {
  apiPromise ??= (async () => {
    const faceapi = await import("@vladmandic/face-api/dist/face-api.esm.js");
    // The bundled TensorFlow.js; its typings aren't shipped with the package.
    const tf = faceapi.tf as unknown as {
      setBackend(name: string): Promise<boolean>;
      ready(): Promise<void>;
    };
    // WebGL is fast on tablets; the CPU backend is the slow but safe fallback.
    const gl = await tf.setBackend("webgl").catch(() => false);
    if (!gl) await tf.setBackend("cpu");
    await tf.ready();
    const base = "/models/face";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(base),
      faceapi.nets.faceLandmark68Net.loadFromUri(base),
      faceapi.nets.faceRecognitionNet.loadFromUri(base),
    ]);
    return faceapi;
  })().catch((e: unknown) => {
    apiPromise = null;
    throw e;
  });
  return apiPromise;
}

/** Whether this browser can open a camera at all (secure context + API). */
export function cameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    (typeof window === "undefined" || window.isSecureContext)
  );
}

/** Front camera into the given <video>. Returns a stop function. */
export async function startCamera(video: HTMLVideoElement): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);
  return () => {
    for (const track of stream.getTracks()) track.stop();
    if (video.srcObject === stream) video.srcObject = null;
  };
}

export type FrameResult =
  | { kind: "none" }
  | { kind: "many" }
  | { kind: "far" }
  | { kind: "face"; ear: number; descriptor: Float32Array | null };

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Eye aspect ratio (Soukupová & Čech): ~0.3 open, under ~0.2 closed. */
function eyeAspect(eye: Pt[]): number {
  if (eye.length < 6) return 0;
  return (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * dist(eye[0], eye[3]) || 1);
}

/** A face must fill at least this share of the frame width (close to the camera). */
const MIN_FACE_SHARE = 0.22;

/**
 * Looks at one video frame. With `withDescriptor`, also computes the
 * descriptor (the slow part); without, only detection + landmarks, which is
 * fast enough to catch a blink.
 */
export async function readFrame(
  faceapi: FaceApi,
  video: HTMLVideoElement,
  withDescriptor: boolean,
): Promise<FrameResult> {
  if (video.readyState < 2 || !video.videoWidth) return { kind: "none" };
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const task = faceapi.detectAllFaces(video, options).withFaceLandmarks();
  const all: Array<{
    detection: { score: number; box: { width: number } };
    landmarks: { getLeftEye(): Pt[]; getRightEye(): Pt[] };
    descriptor?: Float32Array;
  }> = withDescriptor ? await task.withFaceDescriptors() : await task;
  if (all.length === 0) return { kind: "none" };
  if (all.length > 1) return { kind: "many" };
  const one = all[0];
  if (one.detection.box.width < video.videoWidth * MIN_FACE_SHARE) return { kind: "far" };
  const ear = (eyeAspect(one.landmarks.getLeftEye()) + eyeAspect(one.landmarks.getRightEye())) / 2;
  // Only a confident detection is good enough to recognise someone by.
  const descriptor = one.descriptor && one.detection.score >= 0.7 ? one.descriptor : null;
  return { kind: "face", ear, descriptor };
}

export function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

export function meanDescriptor(list: ArrayLike<number>[]): number[] {
  const out = new Array<number>(128).fill(0);
  for (const d of list) for (let i = 0; i < 128; i++) out[i] += d[i] / list.length;
  return out;
}

/** True when every pair is within `max` of each other (one person throughout). */
export function consistent(list: ArrayLike<number>[], max: number): boolean {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) if (distance(list[i], list[j]) > max) return false;
  return true;
}

const OPEN_EAR = 0.25;
const CLOSED_EAR = 0.2;

/** Tracks open -> closed -> open across frames. */
export class BlinkTracker {
  private sawOpen = false;
  private sawClosed = false;
  blinked = false;
  push(ear: number) {
    if (ear >= OPEN_EAR) {
      if (this.sawClosed && this.sawOpen) this.blinked = true;
      this.sawOpen = true;
    } else if (ear <= CLOSED_EAR && this.sawOpen) {
      this.sawClosed = true;
    }
  }
  /** Eyes clearly open: the frames to take descriptors from. */
  static open(ear: number) {
    return ear >= OPEN_EAR;
  }
}

export type ScanStatus = "starting" | "look" | "closer" | "one" | "blink" | "checking";

export type ScanOutcome =
  | { ok: true; descriptor: number[] }
  | { ok: false; reason: "timeout" | "cancelled" | "unsteady" };

/**
 * Watches the camera until it has a live (blinking) face and three matching
 * descriptors from open-eye frames, then returns their average. Gives up after
 * `timeoutMs`.
 */
export async function scanLiveFace(
  faceapi: FaceApi,
  video: HTMLVideoElement,
  opts: { timeoutMs: number; signal: AbortSignal; onStatus: (s: ScanStatus) => void },
): Promise<ScanOutcome> {
  const blink = new BlinkTracker();
  const samples: Float32Array[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let frame = 0;
  opts.onStatus("look");
  while (Date.now() < deadline) {
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    frame++;
    // A descriptor every third frame; landmarks every frame for the blink.
    const wantDescriptor = samples.length < 3 && frame % 3 === 0;
    let r: FrameResult;
    try {
      r = await readFrame(faceapi, video, wantDescriptor);
    } catch {
      r = { kind: "none" };
    }
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    if (r.kind === "none") {
      opts.onStatus("look");
    } else if (r.kind === "many") {
      opts.onStatus("one");
      samples.length = 0;
    } else if (r.kind === "far") {
      opts.onStatus("closer");
    } else {
      blink.push(r.ear);
      if (r.descriptor && BlinkTracker.open(r.ear)) samples.push(r.descriptor);
      if (samples.length >= 3 && !consistent(samples, 0.45)) {
        // Someone else stepped in mid-scan: start the samples over.
        samples.length = 0;
        return { ok: false, reason: "unsteady" };
      }
      if (blink.blinked && samples.length >= 3) {
        opts.onStatus("checking");
        return { ok: true, descriptor: meanDescriptor(samples) };
      }
      opts.onStatus(blink.blinked ? "look" : "blink");
    }
    await new Promise((res) => setTimeout(res, 40));
  }
  return { ok: false, reason: "timeout" };
}

/**
 * For enrollment: `count` descriptors of one live face, taken at least
 * `gapMs` apart so they cover small changes of angle and expression.
 */
export async function captureSamples(
  faceapi: FaceApi,
  video: HTMLVideoElement,
  opts: {
    count: number;
    gapMs: number;
    timeoutMs: number;
    signal: AbortSignal;
    onStatus: (s: ScanStatus) => void;
    onProgress: (n: number) => void;
  },
): Promise<
  { ok: true; samples: number[][] } | { ok: false; reason: "timeout" | "cancelled" | "unsteady" }
> {
  const blink = new BlinkTracker();
  const samples: Float32Array[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let last = 0;
  opts.onStatus("look");
  while (Date.now() < deadline) {
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    const due = samples.length < opts.count && Date.now() - last >= opts.gapMs;
    let r: FrameResult;
    try {
      r = await readFrame(faceapi, video, due);
    } catch {
      r = { kind: "none" };
    }
    if (r.kind === "none") opts.onStatus("look");
    else if (r.kind === "many") opts.onStatus("one");
    else if (r.kind === "far") opts.onStatus("closer");
    else {
      blink.push(r.ear);
      if (r.descriptor && BlinkTracker.open(r.ear)) {
        samples.push(r.descriptor);
        last = Date.now();
        opts.onProgress(samples.length);
        if (!consistent(samples, 0.45)) return { ok: false, reason: "unsteady" };
      }
      if (samples.length >= opts.count && blink.blinked) {
        return { ok: true, samples: samples.map((s) => Array.from(s)) };
      }
      opts.onStatus(samples.length >= opts.count && !blink.blinked ? "blink" : "look");
    }
    await new Promise((res) => setTimeout(res, 40));
  }
  return { ok: false, reason: "timeout" };
}
