/**
 * Company setup that a signup asked for but couldn't finish in one shot.
 *
 * When Supabase is configured to confirm email addresses — the default —
 * `auth.signUp` returns without a session. The `bootstrap_company` /
 * `join_company_by_code` RPCs both need `auth.uid()`, so running them right
 * after signup silently does nothing and the account lands with no company at
 * all. We stash the request here instead and replay it on the first
 * authenticated load, wherever that happens (the confirmation link, or a later
 * sign-in). See `loadContext` in `@/lib/auth`.
 */

const KEY = "sp-signup-intent";
const ERROR_KEY = "sp-signup-intent-error";

/** Long enough to survive "I'll confirm my email tomorrow", short enough not to linger. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SignupIntent =
  | { kind: "create"; companyName: string }
  | { kind: "join"; code: string };

type Stored = SignupIntent & { email: string; savedAt: number };

/** `email` pins the intent to the account that made it, so a second person
 *  signing in on the same device doesn't inherit it. */
export function saveSignupIntent(intent: SignupIntent, email: string): void {
  try {
    const stored: Stored = { ...intent, email: email.trim().toLowerCase(), savedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* private mode — the signup still works, it just can't be replayed */
  }
}

export function clearSignupIntent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Why a replay was rejected. The replay happens during an auth load, far from
 * any form, so the reason is parked here for the "no company" gate to show once
 * the user lands there — otherwise a mistyped join code fails in silence.
 */
export function saveSignupIntentError(message: string): void {
  try {
    localStorage.setItem(ERROR_KEY, message);
  } catch {
    /* ignore */
  }
}

/** Reads the parked message and clears it, so it is shown exactly once. */
export function takeSignupIntentError(): string | null {
  try {
    const message = localStorage.getItem(ERROR_KEY);
    if (message) localStorage.removeItem(ERROR_KEY);
    return message;
  } catch {
    return null;
  }
}

/** The pending intent for `email`, or null if there is none, it belongs to
 *  another account, it has expired, or the stored value is unreadable. */
export function readSignupIntent(email: string | null | undefined): SignupIntent | null {
  if (!email) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let stored: Stored;
  try {
    stored = JSON.parse(raw) as Stored;
  } catch {
    clearSignupIntent();
    return null;
  }

  if (stored?.email !== email.trim().toLowerCase()) return null;
  if (!stored.savedAt || Date.now() - stored.savedAt > MAX_AGE_MS) {
    clearSignupIntent();
    return null;
  }
  if (stored.kind === "create" && stored.companyName) return { kind: "create", companyName: stored.companyName };
  if (stored.kind === "join" && stored.code) return { kind: "join", code: stored.code };

  clearSignupIntent();
  return null;
}
