import { errorMessage } from "@/lib/error-message";

/**
 * Face recognition for the shared clock-in, in the browser.
 *
 * Uses Human (@vladmandic/human 3.3, MIT), the maintained successor of
 * face-api.js by the same author: the BlazeFace detector, a 478-point face
 * mesh, and the "faceres" recognition model, which turns
 * a face into 1024 numbers. We scale those to length 1, so the distance
 * between two faces is between 0 (identical) and 2.
 *
 * Measured on 40 photos of 8 people (different days, light, expressions):
 * Human found 39 faces where the old face-api.js detector found 25, and
 * separated people about twice as well (equal error rate ~4% vs ~10%).
 * Same person, different photos: median 0.81. Different people: never under
 * 0.88. Scans from one camera in one session are much closer than that.
 * The server holds the limits (kiosk_face_match).
 *
 * Everything here runs on the device. No frame leaves it: only descriptors
 * are sent, and matching happens on the server, so the tablet never holds
 * anyone's face data. The library and models (~13 MB, public/vendor/human and
 * public/models/human) load only on the screens that use them.
 *
 * No liveness check: the clock-in matches any steady face, without a blink.
 * That keeps it fast on slow tablets, but a good photo of an enrolled person
 * held up to the camera could clock them in. The PIN still works as before.
 */

/** The parts of a Human detection result we use. */
type HumanFace = {
  box: [number, number, number, number];
  score: number;
  mesh: [number, number, number?][];
  embedding?: number[];
  rotation?: { angle: { roll: number; yaw: number; pitch: number } } | null;
};
type HumanResult = { face: HumanFace[] };
type HumanInstance = {
  load(): Promise<void>;
  warmup(config?: unknown): Promise<HumanResult | undefined>;
  detect(input: HTMLVideoElement, config?: unknown): Promise<HumanResult>;
  tf: { getBackend(): string };
};
type HumanModule = { Human: new (config: unknown) => HumanInstance };

export type FaceEngine = HumanInstance;

/**
 * Loaded as a static file, not bundled: the library is 2 MB of minified
 * TensorFlow.js, and bundling it runs the production build out of memory.
 * To upgrade, copy dist/human.esm.js from a newer @vladmandic/human here
 * (drop its sourceMappingURL line) and the face models into /models/human.
 */
const HUMAN_URL = "/vendor/human/human.esm.js";
/** TensorFlow.js 4.22 WASM files (Apache-2.0), served next to the library. */
const WASM_URL = "/vendor/tfjs-wasm/";

const CONFIG = {
  modelBasePath: "/models/human/",
  debug: false,
  // Reuse the face box between video frames: much faster, the mesh still
  // runs every frame.
  cacheSensitivity: 0.7,
  filter: { enabled: true, equalization: false },
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 2, minConfidence: 0.5, skipFrames: 10, skipTime: 500 },
    mesh: { enabled: true },
    iris: { enabled: false },
    // Turned on per frame when we want a descriptor; never reused across frames.
    description: { enabled: true, skipFrames: 0, skipTime: 0 },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
    attention: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

let enginePromise: Promise<FaceEngine> | null = null;

/** Loads the library and the models once. Rejects if the device can't run them. */
export function loadFaceEngine(): Promise<FaceEngine> {
  enginePromise ??= (async () => {
    // A full URL: Vite's dev server rewrites "/..." imports and refuses
    // public files. Works the same in the build and in the mobile apps.
    const url = new URL(HUMAN_URL, window.location.origin).href;
    const mod = (await import(/* @vite-ignore */ url)) as HumanModule;
    // WASM first: fast, and the same on every device. WebGL depends on the
    // graphics driver, and some Android tablets run it but get wrong numbers
    // back, so no face is ever found. Each one must find Human's built-in
    // test face before it is used; the CPU is the slow last resort.
    const wasmPath = new URL(WASM_URL, window.location.origin).href;
    for (const backend of ["wasm", "webgl"]) {
      try {
        const human = new mod.Human({ ...CONFIG, backend, wasmPath });
        await human.load();
        if (await selfTest(human)) return human;
        console.warn(`[face] ${backend} can't find the test face here`);
      } catch (e) {
        console.warn(`[face] ${backend} unavailable`, e);
      }
    }
    const human = new mod.Human({ ...CONFIG, backend: "cpu" });
    await human.load();
    await human.warmup({ warmup: "face" });
    return human;
  })().catch((e: unknown) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
}

/** Finds Human's own sample face, with a usable descriptor. */
async function selfTest(human: HumanInstance): Promise<boolean> {
  try {
    const r = await human.warmup({ warmup: "face" });
    const f = r?.face?.[0];
    return !!f && f.score >= 0.5 && f.embedding?.length === 1024;
  } catch {
    return false;
  }
}

/** Whether this browser can open a camera at all (secure context + API). */
export function cameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    (typeof window === "undefined" || window.isSecureContext)
  );
}

/** A camera left on for a moment after use, so the next scan starts at once. */
let warm: { stream: MediaStream; timer: ReturnType<typeof setTimeout> } | null = null;

const stopStream = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

/**
 * Front camera into the given <video>. Returns a stop function. With
 * `keepWarmMs`, stopping leaves the camera on that long, and a scan started
 * in the meantime reuses it: opening a camera takes up to 1-2 s on a tablet.
 */
export async function startCamera(video: HTMLVideoElement, keepWarmMs = 0): Promise<() => void> {
  let stream: MediaStream | null = null;
  if (warm) {
    clearTimeout(warm.timer);
    if (warm.stream.getVideoTracks().some((t) => t.readyState === "live")) stream = warm.stream;
    else stopStream(warm.stream);
    warm = null;
  }
  stream ??= await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
  });
  const own = stream;
  video.srcObject = own;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);
  return () => {
    if (video.srcObject === own) video.srcObject = null;
    if (keepWarmMs <= 0) {
      stopStream(own);
      return;
    }
    if (warm) {
      clearTimeout(warm.timer);
      if (warm.stream !== own) stopStream(warm.stream);
    }
    const timer = setTimeout(() => {
      stopStream(own);
      if (warm?.stream === own) warm = null;
    }, keepWarmMs);
    warm = { stream: own, timer };
  };
}

/** What one frame shows, with a hint for the person if it isn't usable. */
export type FrameResult =
  | { kind: "none" }
  | { kind: "many" }
  | { kind: "far" }
  | { kind: "turned" }
  | { kind: "face"; score: number; share: number; descriptor: number[] | null };

/**
 * A face must be at least this share of the frame width. Adding a face wants
 * it close; the clock-in accepts people standing further back.
 */
export const ENROLL_FACE_SHARE = 0.2;
export const KIOSK_FACE_SHARE = 0.12;
/** Detection confidence a descriptor needs (Human's face score, 0 to 1). */
const MIN_DESCRIPTOR_SCORE = 0.6;
/** Head turned further than this (radians, ~20°) gives a poorer descriptor. */
const MAX_TURN = 0.35;

function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** Looks at one video frame. With `withDescriptor`, also computes the descriptor. */
export async function readFrame(
  human: FaceEngine,
  video: HTMLVideoElement,
  withDescriptor: boolean,
  minShare = ENROLL_FACE_SHARE,
): Promise<FrameResult> {
  if (video.readyState < 2 || !video.videoWidth) return { kind: "none" };
  // Human keeps per-call settings, so say both ways every time.
  const r = await human.detect(video, { face: { description: { enabled: withDescriptor } } });
  const faces = r.face.filter((f) => f.score >= 0.5);
  if (faces.length === 0) return { kind: "none" };
  if (faces.length > 1) return { kind: "many" };
  const f = faces[0];
  const share = f.box[2] / video.videoWidth;
  if (share < minShare) return { kind: "far" };
  const angle = f.rotation?.angle;
  const turned = !!angle && (Math.abs(angle.yaw) > MAX_TURN || Math.abs(angle.pitch) > MAX_TURN);
  if (turned) return { kind: "turned" };
  const descriptor =
    withDescriptor && f.embedding && f.embedding.length === 1024 && f.score >= MIN_DESCRIPTOR_SCORE
      ? unit(f.embedding)
      : null;
  return { kind: "face", score: f.score, share, descriptor };
}

export function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/** Average of unit descriptors, scaled back to length 1. */
export function meanDescriptor(list: number[][]): number[] {
  const out = new Array<number>(list[0].length).fill(0);
  for (const d of list) for (let i = 0; i < d.length; i++) out[i] += d[i];
  return unit(out);
}

/**
 * Same session, same person: scans are well within this of each other. A scan
 * further than this from the others is a bad frame (blur, half a turn) or
 * someone else, and is dropped.
 */
const SAME_SESSION = 0.7;

/**
 * The largest group of scans that are all close to their middle one. Bad
 * frames are dropped instead of failing the whole scan.
 */
export function steadySamples(list: number[][], max = SAME_SESSION): number[][] {
  if (list.length < 2) return list;
  let best: number[][] = [];
  for (const centre of list) {
    const near = list.filter((d) => distance(d, centre) <= max);
    if (near.length > best.length) best = near;
  }
  return best;
}

export type ScanStatus = "starting" | "look" | "closer" | "one" | "straight" | "hold" | "checking";

export type ScanOutcome =
  | { ok: true; descriptor: number[] }
  | { ok: false; reason: "timeout" | "cancelled" };

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

function statusFor(r: FrameResult): ScanStatus | null {
  if (r.kind === "none") return "look";
  if (r.kind === "many") return "one";
  if (r.kind === "far") return "closer";
  if (r.kind === "turned") return "straight";
  return null;
}

/** Live numbers for the ?debug=face overlay on the clock-in. */
export type ScanDebug = {
  frame: FrameResult["kind"];
  backend: string;
  share: number;
  score: number;
  samples: number;
  ms: number;
  /** Camera picture size, e.g. 640x480 (0x0 = no picture yet). */
  video: string;
  /** The last detector error, if any. */
  error: string;
};

/**
 * Clock-in: one descriptor, as soon as a face has been steady for one frame
 * (so it isn't taken mid-step while someone walks up). No blink or other
 * movement is asked for. The server decides; a miss just scans again. Gives up
 * after `timeoutMs`.
 */
export async function scanLiveFace(
  human: FaceEngine,
  video: HTMLVideoElement,
  opts: {
    timeoutMs: number;
    signal: AbortSignal;
    onStatus: (s: ScanStatus) => void;
    onDebug?: (d: ScanDebug) => void;
  },
): Promise<ScanOutcome> {
  const deadline = Date.now() + opts.timeoutMs;
  const backend = human.tf.getBackend();
  let steady = 0;
  let error = "";
  opts.onStatus("look");
  while (Date.now() < deadline) {
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    const started = performance.now();
    let r: FrameResult;
    try {
      r = await readFrame(human, video, steady > 0, KIOSK_FACE_SHARE);
    } catch (e) {
      error = errorMessage(e);
      r = { kind: "none" };
    }
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    const hint = statusFor(r);
    if (hint) {
      steady = 0;
      opts.onStatus(hint);
    } else if (r.kind === "face") {
      steady += 1;
      if (r.descriptor) {
        opts.onStatus("checking");
        return { ok: true, descriptor: r.descriptor };
      }
      opts.onStatus("hold");
    }
    opts.onDebug?.({
      frame: r.kind,
      backend,
      share: r.kind === "face" ? r.share : 0,
      score: r.kind === "face" ? r.score : 0,
      samples: steady,
      ms: Math.round(performance.now() - started),
      video: `${video.videoWidth}x${video.videoHeight}`,
      error,
    });
    // Yield to the page (and the camera) between frames.
    await pause(0);
  }
  return { ok: false, reason: "timeout" };
}

/**
 * Adding a face: `count` steady descriptors of one face, taken at least
 * `gapMs` apart so they cover small changes of angle and expression. No blink
 * needed. Bad frames are dropped and taken again, so it keeps going until it
 * has enough or time runs out.
 */
export async function captureSamples(
  human: FaceEngine,
  video: HTMLVideoElement,
  opts: {
    count: number;
    gapMs: number;
    timeoutMs: number;
    signal: AbortSignal;
    onStatus: (s: ScanStatus) => void;
    onProgress: (n: number) => void;
  },
): Promise<{ ok: true; samples: number[][] } | { ok: false; reason: "timeout" | "cancelled" }> {
  let samples: number[][] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let last = 0;
  opts.onStatus("look");
  opts.onProgress(0);
  while (Date.now() < deadline) {
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    const due = Date.now() - last >= opts.gapMs;
    let r: FrameResult;
    try {
      r = await readFrame(human, video, due);
    } catch {
      r = { kind: "none" };
    }
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    const hint = statusFor(r);
    if (r.kind === "many") {
      samples = [];
      opts.onProgress(0);
    }
    if (hint) opts.onStatus(hint);
    else if (r.kind === "face") {
      opts.onStatus("hold");
      if (r.descriptor) {
        samples = steadySamples([...samples, r.descriptor]);
        last = Date.now();
        opts.onProgress(Math.min(samples.length, opts.count));
        if (samples.length >= opts.count) {
          return { ok: true, samples: samples.slice(0, opts.count) };
        }
      }
    }
    await pause(15);
  }
  return { ok: false, reason: "timeout" };
}
