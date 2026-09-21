/**
 * Service worker — notifications only.
 *
 * It exists because an installed app cannot show a notification the way a tab
 * can: Chrome on Android throws "Illegal constructor" for `new Notification()`,
 * and iOS has no such constructor at all. Both will only show one through a
 * service worker registration, so the page asks this file to do it.
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

/** The page asks; the worker shows. `link` comes back on the click. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "show-notification") return;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { link: data.link || "/dashboard" },
    }),
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
