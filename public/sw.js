/**
 * Service worker — notifications only.
 *
 * Two jobs:
 *
 *  1. Show a notification the page asks for. An installed app cannot show one
 *     the way a tab can: Chrome on Android throws "Illegal constructor" for
 *     `new Notification()`, and iOS has no such constructor at all. Both will
 *     only show one through a service worker registration.
 *
 *  2. Show a notification the *server* sends, through Web Push. This is the
 *     half that works with the app closed — the browser wakes this worker for
 *     a `push` event whether or not a single tab is open, which is the only
 *     way "your break is nearly up" reaches a phone in someone's pocket.
 *
 * Deliberately no `fetch` handler and no caching. This app talks to its
 * database on every screen; putting a cache in front of that is a different
 * piece of work with its own failure modes, and nothing here needs it.
 */

self.addEventListener("install", () => {
  // Take over straight away rather than waiting for every tab to close —
  // nothing here is version-sensitive, so there is no old worker worth keeping.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** One place that decides what a notification looks like, however it arrived. */
function show(title, body, tag, link) {
  return self.registration.showNotification(title || "Scheduling Pilot", {
    body: body || "",
    tag: tag || undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // A locked phone should light up and buzz for this, not collect it quietly.
    requireInteraction: false,
    data: { link: link || "/dashboard" },
  });
}

/** The page asks; the worker shows. `link` comes back on the click. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "show-notification") return;
  event.waitUntil(show(data.title, data.body, data.tag, data.link));
});

/**
 * A push from the server.
 *
 * The payload is the JSON the dispatcher encrypted for this device. It carries
 * the same `tag` the page would have used for the same event, so a device that
 * is awake and receives both shows one notification rather than a pair — the
 * second replaces the first instead of stacking on it.
 *
 * A push with no readable payload still shows something. Every browser that
 * supports push requires a visible notification per push, and a silent failure
 * here is what gets a site's push permission revoked.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  event.waitUntil(
    show(
      payload.title || "Scheduling Pilot",
      payload.body || "You have a new notification.",
      payload.tag,
      payload.link,
    ),
  );
});

/**
 * Bring the app forward on a tap rather than opening a second copy of it —
 * an installed app that spawns a duplicate window on every notification is
 * worse than one that does nothing.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(link).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});

/**
 * A browser may retire a subscription and hand out a new one — after a long
 * idle spell, or a key rotation. The app finds out by being told here.
 *
 * The worker cannot write to the database (it has no session), so it asks any
 * open tab to re-register. If none is open, the next time the app is opened it
 * re-syncs on startup anyway; until then this device is simply not subscribed,
 * which is the same state it was in before saying yes.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "push-subscription-changed" });
    }),
  );
});
