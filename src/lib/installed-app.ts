/**
 * The app as added to a phone's home screen (installed from the web manifest).
 *
 * Supabase keeps the session in localStorage and refreshes it on its own, so a
 * signed-in user stays signed in until they sign out — provided the browser
 * keeps that storage. Safari can clear storage for sites that go unvisited,
 * but a home-screen app keeps its own; any browser may also evict it to free
 * space, which a persistent-storage grant opts out of.
 */

export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Older iOS home-screen apps only report themselves this way.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Asks the browser not to evict this site's storage, where the session lives.
 * Installed app only: there Chrome and Safari decide silently, whereas in a
 * Firefox tab the same call pops a permission prompt.
 */
export function keepStorageOnDevice(): void {
  if (!isInstalledApp()) return;
  const storage = navigator.storage;
  if (!storage?.persist) return;
  void storage.persist().catch(() => {
    /* not granted — the session still persists, it's just evictable */
  });
}
