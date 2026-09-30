/**
 * How long a notification is kept once it has been read.
 *
 * Read means dealt with. A day is long enough to find one again after tapping
 * it by mistake, and short enough that the bell holds what is new rather than
 * a history nobody scrolls. Unread notifications are never removed.
 *
 * Shared by the bell, which hides and clears its owner's expired ones, and the
 * server sweep, which clears everyone's — including people who never come back
 * to open the bell.
 */
export const READ_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Anything read before this moment is expired. */
export function readCutoff(now = Date.now()): string {
  return new Date(now - READ_NOTIFICATION_TTL_MS).toISOString();
}
