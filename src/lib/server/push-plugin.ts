/**
 * Start the push dispatcher when the server boots, not when it is first asked
 * for a page.
 *
 * Nitro loads the SSR entry lazily, so `startPushDispatcher()` in src/server.ts
 * does not run until somebody requests something. That is almost always within
 * seconds of a deploy — but "almost always" is the wrong guarantee for the
 * thing whose whole job is to fire while nobody is looking. A container that
 * restarted overnight would hold every queued break reminder until the first
 * visitor in the morning.
 *
 * A Nitro plugin runs at start-up, which is what this is for. The call in
 * src/server.ts stays as well: whichever happens first wins, and the second is
 * a no-op (see the `RUNNING` guard in push-dispatcher.ts).
 */
import { startPushDispatcher } from "./push-dispatcher";

export default function pushPlugin(): void {
  startPushDispatcher();
}
