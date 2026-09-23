/**
 * The sound a pop-up makes, and the choice between them.
 *
 * Two of them:
 *
 *  * **Alert** — `/sounds/notify-alert.mp3`, the default. A recorded sound, so
 *    it carries further than a synthesised tone across a noisy floor.
 *  * **Chime** — synthesised here with the Web Audio API: two short sine tones
 *    a fifth apart. A few lines cost less than an asset to fetch and cache, and
 *    it is the quieter of the two for anyone at a desk.
 *
 * Both go through one AudioContext. Browsers will not play sound on a page
 * nobody has touched yet, so it is unlocked on the first click or key press
 * anywhere in the app (see `unlockSound`). Before that a sound is simply
 * skipped — the pop-up still appears, silently, which is the best a browser
 * allows.
 *
 * This is for pop-ups drawn while the app is open. A notification delivered to
 * a closed app is drawn by the operating system, which uses its own
 * notification sound: the web platform has no way to attach one to
 * `showNotification()`, so the choice below cannot reach it.
 */

/** The sounds, in the order the settings screen lists them. */
export const NOTIFICATION_SOUNDS = [
  {
    key: "alert",
    label: "Alert",
    detail: "A recorded alert. Carries across a room.",
  },
  {
    key: "chime",
    label: "Chime",
    detail: "Two soft tones. Quieter, for a desk.",
  },
] as const;

export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number]["key"];

/** What plays until somebody picks otherwise. */
export const DEFAULT_NOTIFICATION_SOUND: NotificationSound = "alert";

export function isNotificationSound(value: unknown): value is NotificationSound {
  return NOTIFICATION_SOUNDS.some((s) => s.key === value);
}

/* ------------------------------------------------------------------- context */

let ctx: AudioContext | null = null;
let lastPlayed = 0;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Wake the audio context on the first real interaction, so later sounds are
 * allowed to play. Safe to call more than once; it only listens until it works.
 *
 * The recorded sound is fetched and decoded at the same moment, because the
 * first notification of the day should not be the one that waits on a download.
 */
export function unlockSound(): () => void {
  if (typeof window === "undefined") return () => {};
  void loadAlert();
  const unlock = () => {
    const c = audio();
    if (c && c.state === "suspended") void c.resume();
    if (c?.state === "running") detach();
  };
  const detach = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return detach;
}

/* --------------------------------------------------------------- the alert */

const ALERT_URL = "/sounds/notify-alert.mp3";

/**
 * The file runs 9.05s, but the sound itself only occupies 1.75s–6.51s of it:
 * nearly two seconds of silence before the first hit, two and a half after the
 * last. Played from the top it would arrive a beat late, sounding like a
 * different event from the pop-up that triggered it.
 *
 * Web Audio can start part-way into a buffer, so the file is left exactly as
 * supplied and the dead air is simply never played. Re-cutting the asset would
 * do the same job, less reversibly.
 */
const ALERT_START = 1.75;
/**
 * To 6.8s in the file: the last hit lands at 5.61s and has decayed to −54dB by
 * here, below anything a phone speaker will reproduce. What follows is the
 * encoder's noise floor, not the sound.
 */
const ALERT_LENGTH = 5.05;
/** It is a full-scale recording; at 1.0 it would startle. */
const ALERT_GAIN = 0.45;
/** Enough to make the cut above provably click-free, short enough to not be heard as a fade. */
const ALERT_FADE = 0.06;

let alertBuffer: AudioBuffer | null = null;
let alertLoad: Promise<AudioBuffer | null> | null = null;

function loadAlert(): Promise<AudioBuffer | null> {
  if (alertBuffer) return Promise.resolve(alertBuffer);
  alertLoad ??= (async () => {
    const c = audio();
    if (!c) return null;
    try {
      const response = await fetch(ALERT_URL);
      if (!response.ok) return null;
      alertBuffer = await c.decodeAudioData(await response.arrayBuffer());
      return alertBuffer;
    } catch {
      // A file that will not fetch or decode is not worth retrying on every
      // notification; the chime below covers for it.
      return null;
    }
  })();
  return alertLoad;
}

function playAlert(c: AudioContext, buffer: AudioBuffer): void {
  const source = c.createBufferSource();
  source.buffer = buffer;
  const gain = c.createGain();
  const t0 = c.currentTime;
  gain.gain.setValueAtTime(ALERT_GAIN, t0);
  // Ramped rather than stopped dead. The cut lands in the tail of the last
  // note, and an abrupt end to a non-zero waveform is a click.
  gain.gain.setValueAtTime(ALERT_GAIN, t0 + ALERT_LENGTH - ALERT_FADE);
  gain.gain.linearRampToValueAtTime(0, t0 + ALERT_LENGTH);
  source.connect(gain).connect(c.destination);
  source.start(t0, ALERT_START, ALERT_LENGTH);
  source.stop(t0 + ALERT_LENGTH);
}

/* --------------------------------------------------------------- the chime */

/** Two notes, rising. Quiet enough not to startle, clear enough to hear. */
function playChimeOn(c: AudioContext): void {
  const t0 = c.currentTime;
  const tone = (freq: number, start: number, dur: number) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // A soft attack and an exponential tail: a bell, not a beep.
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(0.16, t0 + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.05);
  };
  tone(880, 0, 0.35); // A5
  tone(1318.5, 0.12, 0.5); // E6
}

/* ---------------------------------------------------------------- playing */

/**
 * Play the sound someone has chosen.
 *
 * `force` is for the preview buttons on Settings: those are somebody pressing
 * a button to hear it, so they bypass the run-together guard below.
 */
export function playNotificationSound(
  sound: NotificationSound = DEFAULT_NOTIFICATION_SOUND,
  force = false,
): void {
  const c = audio();
  if (!c) return;

  // Several pop-ups landing together should sound like one arrival, not a pile-up.
  if (!force) {
    const nowMs = Date.now();
    if (nowMs - lastPlayed < 1500) return;
    lastPlayed = nowMs;
  }

  if (c.state === "suspended") void c.resume();
  if (c.state !== "running" && c.state !== "suspended") return;

  if (sound === "chime") {
    playChimeOn(c);
    return;
  }

  // Already decoded on all but the very first one, so this resolves in the
  // same tick and the sound lands with the pop-up.
  void loadAlert().then((buffer) => {
    const live = audio();
    if (!live) return;
    if (buffer) playAlert(live, buffer);
    // The file could not be loaded — better the other sound than silence.
    else playChimeOn(live);
  });
}
