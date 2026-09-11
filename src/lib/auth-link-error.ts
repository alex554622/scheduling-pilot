/**
 * Why an email link from Supabase Auth failed, carried over to the sign-in form.
 *
 * An expired or already-used confirmation link still redirects back to the app,
 * but with the reason in the URL (`#error=…&error_code=…&error_description=…`)
 * instead of a session. supabase-js notices, keeps quiet, and the visitor used to
 * land on /dashboard, get bounced to /login and see no explanation at all. The
 * reason is lifted out of the URL on first load (see `AuthProvider`) and parked
 * here until the sign-in form shows it.
 */

const KEY = "sp-auth-link-error";

/** Everything Supabase Auth adds to a failed redirect, including its `sb` marker. */
const PARAMS = ["error", "error_code", "error_description", "sb"];

/** Pages that explain a failed link themselves. */
const SELF_HANDLED = new Set(["/reset-password"]);

function describe(code: string | null, description: string | null): string {
  if (code === "otp_expired") {
    return "That email link has expired or was already used. If you've already confirmed your email, sign in below. If not, create your account again with the same email and we'll send you a new link.";
  }
  return `That email link didn't work${description ? ` (${description})` : ""}. Sign in below, or create your account again to get a new link.`;
}

/**
 * Moves a failed link's reason from the current URL into session storage and
 * strips it from the address bar. Returns true when there was one. Once the URL
 * is clean, calling it again is a no-op.
 */
export function captureAuthLinkError(): boolean {
  if (typeof window === "undefined" || SELF_HANDLED.has(window.location.pathname)) return false;

  const url = new URL(window.location.href);
  // Implicit-flow redirects put it in the fragment, PKCE ones in the query.
  const fragment = new URLSearchParams(url.hash.slice(1));
  const read = (key: string) => fragment.get(key) ?? url.searchParams.get(key);
  const code = read("error_code");
  const description = read("error_description");
  // A bare `error` is too generic a name to claim; Supabase always sends one of these.
  if (!code && !description) return false;

  try {
    sessionStorage.setItem(KEY, describe(code, description));
  } catch {
    /* storage blocked — the URL still gets cleaned, the message is just lost */
  }

  for (const key of PARAMS) {
    fragment.delete(key);
    url.searchParams.delete(key);
  }
  url.hash = fragment.toString();
  window.history.replaceState(window.history.state, "", url.toString());
  return true;
}

/** The parked message, cleared as it is read so it shows exactly once. */
export function takeAuthLinkError(): string | null {
  // Covers landing straight on the page that shows it, where this can run
  // before AuthProvider's capture does (child effects run first).
  captureAuthLinkError();
  try {
    const message = sessionStorage.getItem(KEY);
    if (message) sessionStorage.removeItem(KEY);
    return message;
  } catch {
    return null;
  }
}
