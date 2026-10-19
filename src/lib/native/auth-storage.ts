/**
 * Where the apps keep the Supabase session.
 *
 * The website keeps it in localStorage. Inside the apps that storage belongs to
 * the web view, which the OS may clear under storage pressure — signing people
 * out at random. Preferences is the app's own native store (SharedPreferences
 * on Android, UserDefaults on iOS): inside the app sandbox, unreadable by other
 * apps, kept until the app is uninstalled, and excluded from Android cloud
 * backup by `android:allowBackup="false"` in the manifest.
 *
 * Only the session lives here. No service-role key or other secret is ever in
 * the app — the publishable key it signs in with is public by design.
 *
 * The plugin is imported on first use so the website never downloads it. The
 * import resolves to the module, never to the plugin object itself: a Capacitor
 * plugin is a proxy that answers every property, so a promise resolving to one
 * is taken for a thenable and its `then` is called as a native method, which
 * rejects — and the app then waits on the session forever.
 */
const preferences = () => import("@capacitor/preferences");

export const nativeAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const { value } = await (await preferences()).Preferences.get({ key });
    return value;
  },
  async setItem(key: string, value: string): Promise<void> {
    await (await preferences()).Preferences.set({ key, value });
  },
  async removeItem(key: string): Promise<void> {
    await (await preferences()).Preferences.remove({ key });
  },
};
