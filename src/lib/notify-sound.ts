/**
 * The chime a pop-up makes.
 *
 * Synthesised with the Web Audio API rather than shipped as a file: two short
 * sine tones, a fifth apart, is a notification sound, and a few lines here cost
 * less than an asset to fetch, cache and keep in the service worker's way.
 *
 * Browsers will not play sound on a page nobody has touched yet, so the audio
 * context is unlocked on the first click or key press anywhere in the app (see
 * `unlockSound`). Before that, a chime is simply skipped — the pop-up still
 * appears, silently, which is the best a browser allows.
 */

let ctx: AudioContext | null = null;
let lastChime = 0;

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
 * Wake the audio context on the first real interaction, so later chimes are
 * allowed to play. Safe to call more than once; it only listens until it works.
 */
export function unlockSound(): () => void {
  if (typeof window === "undefined") return () => {};
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

/** Two notes, rising. Quiet enough not to startle, clear enough to hear. */
export function playChime(): void {
  const c = audio();
  if (!c) return;
  // Several pop-ups landing together should sound like one arrival, not a chord.
  const nowMs = Date.now();
  if (nowMs - lastChime < 1500) return;
  lastChime = nowMs;
  if (c.state === "suspended") void c.resume();
  if (c.state !== "running" && c.state !== "suspended") return;

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
