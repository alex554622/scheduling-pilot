/**
 * The text to show for a caught error.
 *
 * Supabase errors (PostgrestError, AuthError from some paths, FunctionsError
 * bodies) are plain objects with a `message`, not `Error` instances, so
 * `String(e)` turns them into "[object Object]".
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const { message, details, hint } = e as { message?: unknown; details?: unknown; hint?: unknown };
    if (typeof message === "string" && message) {
      const extra = [details, hint].filter((x): x is string => typeof x === "string" && !!x);
      return extra.length ? `${message} (${extra.join(" ")})` : message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}
