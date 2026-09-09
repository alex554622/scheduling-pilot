/**
 * The employee's own hourly rate and tax deduction, used to show live earnings
 * on the time clock.
 *
 * This lives in `localStorage`, not the database, and that is deliberate: pay is
 * the one thing on this screen that must not be visible to a company admin, and
 * every profile column in this schema is readable by the admins of that company.
 * Keeping it in the browser means it never leaves the device it was typed on —
 * no row to secure, no policy to get wrong. The cost is that it does not follow
 * the user to a second device.
 */

const KEY_PREFIX = "sp-pay-settings:";

export interface PaySettings {
  /** Pay per hour, in whatever currency the user thinks in. */
  hourlyRate: number;
  /** Federal tax withheld, 0–100. Named `taxPercent` because it predates the
   *  state rate and settings already saved on people's devices use this key. */
  taxPercent: number;
  /** State tax withheld, 0–100. Absent from settings saved before it existed. */
  statePercent: number;
}

function clampPercent(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function readPaySettings(userId: string | null | undefined): PaySettings | null {
  if (!userId) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyFor(userId));
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PaySettings>;
    const hourlyRate = Number(parsed.hourlyRate);
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) return null;
    return {
      hourlyRate,
      taxPercent: clampPercent(parsed.taxPercent),
      statePercent: clampPercent(parsed.statePercent),
    };
  } catch {
    return null;
  }
}

export function writePaySettings(userId: string, settings: PaySettings): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(settings));
  } catch {
    /* private mode — the rate just won't stick between visits */
  }
}

export function clearPaySettings(userId: string): void {
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    /* ignore */
  }
}
