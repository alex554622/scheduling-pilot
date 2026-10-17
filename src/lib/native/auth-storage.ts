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
 * The plugin is imported on first use so the website never downloads it.
 */
const preferences = () => import("@capacitor/preferences").then((m) => m.Preferences);

export const nativeAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const { value } = await (await preferences()).get({ key });
    return value;
  },
  async setItem(key: string, value: string): Promise<void> {
    await (await preferences()).set({ key, value });
  },
  async removeItem(key: string): Promise<void> {
    await (await preferences()).remove({ key });
  },
};
