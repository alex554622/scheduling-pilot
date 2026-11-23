/**
 * Face recognition for the shared clock-in, in the browser.
 *
 * Uses Human (@vladmandic/human 3.3, MIT), the maintained successor of
 * face-api.js by the same author: the BlazeFace detector, a 478-point face
 * mesh with iris refinement, and the "faceres" recognition model, which turns
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
 * Liveness, on the clock-in only: a scan counts after the person blinks. The
 * blink is measured against that person's own eye openness, so it works for
 * every eye shape and on slow tablets. Adding a face doesn't ask for a blink:
 * an admin is there, or an admin approves it afterwards.
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
  warmup(): Promise<unknown>;
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

const CONFIG = {
  modelBasePath: "/models/human/",
  backend: "webgl",
  debug: false,
  // Reuse the face box between video frames: much faster, the mesh still
  // runs every frame.
  cacheSensitivity: 0.7,
  filter: { enabled: true, equalization: false },
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 2, minConfidence: 0.5, skipFrames: 10, skipTime: 500 },
    mesh: { enabled: true },
    iris: { enabled: true },
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
    let human = new mod.Human(CONFIG);
    try {
      await human.load();
    } catch {
      // No WebGL: the CPU backend is slow but works.
      human = new mod.Human({ ...CONFIG, backend: "cpu" });
      await human.load();
    }
    await human.warmup();
    return human;
  })().catch((e: unknown) => {
    enginePromise = null;
    throw e;
  });
  return enginePromise;
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

/** What one frame shows, with a hint for the person if it isn't usable. */
export type FrameResult =
  | { kind: "none" }
  | { kind: "many" }
  | { kind: "far" }
  | { kind: "turned" }
  | { kind: "face"; eyes: number; descriptor: number[] | null };

type Pt = [number, number, number?];
const gap = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Eye openness from the mesh: lid gap over eye width, both eyes averaged. */
function eyeOpenness(mesh: Pt[]): number {
  if (mesh.length < 400) return 0;
  const left = gap(mesh[159], mesh[145]) / (gap(mesh[33], mesh[133]) || 1);
  const right = gap(mesh[386], mesh[374]) / (gap(mesh[362], mesh[263]) || 1);
  return (left + right) / 2;
}

/** A face must be at least this share of the frame width (close enough). */
const MIN_FACE_SHARE = 0.2;
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
): Promise<FrameResult> {
  if (video.readyState < 2 || !video.videoWidth) return { kind: "none" };
  // Human keeps per-call settings, so say both ways every time.
  const r = await human.detect(video, { face: { description: { enabled: withDescriptor } } });
  const faces = r.face.filter((f) => f.score >= 0.5);
  if (faces.length === 0) return { kind: "none" };
  if (faces.length > 1) return { kind: "many" };
  const f = faces[0];
  if (f.box[2] < video.videoWidth * MIN_FACE_SHARE) return { kind: "far" };
  const angle = f.rotation?.angle;
  const turned = !!angle && (Math.abs(angle.yaw) > MAX_TURN || Math.abs(angle.pitch) > MAX_TURN);
  if (turned) return { kind: "turned" };
  const descriptor =
    withDescriptor && f.embedding && f.embedding.length === 1024 && f.score >= 0.7
      ? unit(f.embedding)
      : null;
  return { kind: "face", eyes: eyeOpenness(f.mesh), descriptor };
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

/**
 * Notices a blink relative to the person's own eyes: openness drops below
 * 70% of what it usually is, then comes back above 85%. Works for any eye
 * shape, and a partial close counts, so a slow tablet that misses the frame
 * with the eyes fully shut still sees it.
 */
export class BlinkTracker {
  private open = 0;
  private closed = false;
  blinked = false;
  push(eyes: number) {
    if (eyes <= 0) return;
    // Running "eyes open" level: rises quickly, falls slowly.
    this.open = this.open === 0 ? eyes : Math.max(eyes, this.open * 0.98 + eyes * 0.02);
    if (eyes < this.open * 0.7) this.closed = true;
    else if (this.closed && eyes > this.open * 0.85) this.blinked = true;
  }
  /** Eyes open now: a good frame to take a descriptor from. */
  isOpen(eyes: number) {
    return this.open > 0 && eyes >= this.open * 0.8;
  }
}

export type ScanStatus =
  | "starting"
  | "look"
  | "closer"
  | "one"
  | "straight"
  | "blink"
  | "hold"
  | "checking";

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

/**
 * Clock-in: watches the camera until it has a live (blinking) face and three
 * matching descriptors from open-eye frames, then returns their average.
 * Gives up after `timeoutMs`.
 */
export async function scanLiveFace(
  human: FaceEngine,
  video: HTMLVideoElement,
  opts: { timeoutMs: number; signal: AbortSignal; onStatus: (s: ScanStatus) => void },
): Promise<ScanOutcome> {
  const blink = new BlinkTracker();
  let samples: number[][] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let lastSample = 0;
  opts.onStatus("look");
  while (Date.now() < deadline) {
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    // A descriptor at most every 250 ms; the mesh (for the blink) every frame.
    const wantDescriptor = samples.length < 5 && Date.now() - lastSample > 250;
    let r: FrameResult;
    try {
      r = await readFrame(human, video, wantDescriptor);
    } catch {
      r = { kind: "none" };
    }
    if (opts.signal.aborted) return { ok: false, reason: "cancelled" };
    const hint = statusFor(r);
    if (r.kind === "many") samples = [];
    if (hint) opts.onStatus(hint);
    else if (r.kind === "face") {
      blink.push(r.eyes);
      if (r.descriptor && blink.isOpen(r.eyes)) {
        samples.push(r.descriptor);
        lastSample = Date.now();
        samples = steadySamples(samples);
      }
      if (blink.blinked && samples.length >= 3) {
        opts.onStatus("checking");
        return { ok: true, descriptor: meanDescriptor(samples) };
      }
      opts.onStatus(blink.blinked ? "hold" : "blink");
    }
    await pause(15);
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
