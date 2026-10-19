import type { AnyRouter } from "@tanstack/react-router";
import { registerPlugin } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/client";
import { translate } from "@/lib/i18n";
import { isNativeApp, nativePlatform } from "./platform";

/**
 * Lock-screen notifications for the Android and iOS apps.
 *
 * The website's version of this is `@/lib/push-subscription`: a Web Push
 * subscription filed in `push_subscriptions`. The apps' web view has no Push
 * API, so here the phone registers with its own push service (Firebase Cloud
 * Messaging on Android, APNs on iOS) and hands back one token, which is filed
 * in `push_devices`. The server's dispatcher sends each queued notification to
 * both tables (src/lib/server/push-dispatcher.ts).
 *
 * Same rules as the website: the token is filed only after the person has said
 * yes to the OS prompt, it is re-filed on every start-up (tokens rotate), it
 * comes off the list when they sign out or switch notifications off, and
 * nothing here ever throws at someone trying to clock in.
 *
 * While the app is open, notifications are shown by the app itself (the bell,
 * the toast, the break alarm), exactly as before. The OS only draws them when
 * the app is in the background or closed — see `presentationOptions` in
 * capacitor.config.ts.
 *
 * The plugin is imported on first use so the website never downloads it.
 */
// These resolve to the module, never to the plugin object itself: a Capacitor
// plugin is a proxy that answers every property, so a promise resolving to one
// is taken for a thenable and its `then` is called as a native method, which
// rejects ("Preferences.then() is not implemented on android").
const plugin = () => import("@capacitor/push-notifications");

/**
 * Android only: does this build have a Firebase config (google-services.json)?
 * Without one, the push plugin crashes the app the moment it registers, so
 * nothing is attempted. Implemented in android/…/PushSetupPlugin.java; iOS has
 * no such file to be missing, so there the call fails and the answer is yes.
 */
const PushSetup = registerPlugin<{ isConfigured(): Promise<{ configured: boolean }> }>("PushSetup");

/** Where the current token is kept, so sign-out can remove it after a restart. */
const TOKEN_KEY = "native-push-token";
const preferences = () => import("@capacitor/preferences");

type Permission = NotificationPermission | "unsupported";

const tr = (text: string) => translate(text, undefined, undefined, "shell");

let configured: Promise<boolean> | null = null;
/** Can this build of the app receive push at all? */
export function nativePushAvailable(): Promise<boolean> {
  if (!isNativeApp()) return Promise.resolve(false);
  configured ??= (async () => {
    if (nativePlatform() !== "android") return nativePlatform() === "ios";
    try {
      return (await PushSetup.isConfigured()).configured;
    } catch {
      return false;
    }
  })();
  return configured;
}

/** The OS permission, in the same words the website's Notification.permission uses. */
export async function nativePushPermission(): Promise<Permission> {
  if (!(await nativePushAvailable())) return "unsupported";
  try {
    const { receive } = await (await plugin()).PushNotifications.checkPermissions();
    return receive === "granted" ? "granted" : receive === "denied" ? "denied" : "default";
  } catch {
    return "unsupported";
  }
}

/** Ask the OS. Android below 13 and an already-answered iPhone answer at once. */
export async function requestNativePushPermission(): Promise<Permission> {
  if (!(await nativePushAvailable())) return "unsupported";
  try {
    const { receive } = await (await plugin()).PushNotifications.requestPermissions();
    return receive === "granted" ? "granted" : receive === "denied" ? "denied" : "default";
  } catch {
    return "denied";
  }
}

/**
 * Android groups notifications into channels the person can tune in the
 * system settings. A break reminder is its own, louder one, so someone can
 * keep it on while muting messages. The ids match `ANDROID_CHANNELS` in
 * src/lib/server/native-push.ts.
 */
async function ensureChannels() {
  if (nativePlatform() !== "android") return;
  const push = (await plugin()).PushNotifications;
  await push
    .createChannel({
      id: "alerts",
      name: tr("Notifications"),
      description: tr("Schedules, shift changes, announcements and messages."),
      importance: 4,
      visibility: 0,
      vibration: true,
    })
    .catch(() => {});
  await push
    .createChannel({
      id: "break",
      name: tr("Break almost over"),
      description: tr("A reminder two minutes before your break is up."),
      importance: 5,
      visibility: 1,
      vibration: true,
    })
    .catch(() => {});
}

let pendingToken: Promise<string | null> | null = null;
/** Register with FCM/APNs and wait for the token the OS hands back. */
function obtainToken(): Promise<string | null> {
  pendingToken ??= (async () => {
    const push = (await plugin()).PushNotifications;
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const handles: { remove: () => Promise<void> }[] = [];
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const h of handles) void h.remove();
        resolve(value);
      };
      // No answer at all usually means no network, or (iOS) a build without
      // the Push Notifications capability. Try again on the next start-up.
      const timer = setTimeout(() => finish(null), 20_000);
      void Promise.all([
        push.addListener("registration", (t) => finish(t.value)),
        push.addListener("registrationError", () => finish(null)),
      ]).then((hs) => {
        handles.push(...hs);
        if (done) for (const h of hs) void h.remove();
        else push.register().catch(() => finish(null));
      });
    });
  })().finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}

/**
 * Register this phone and file it under the signed-in account. Returns whether
 * it worked. Never prompts: call `requestNativePushPermission` from a tap first.
 */
export async function registerNativePush(): Promise<boolean> {
  if ((await nativePushPermission()) !== "granted") return false;
  try {
    await ensureChannels();
    const token = await obtainToken();
    if (!token) return false;
    let version: string | null = null;
    try {
      const { App } = await import("@capacitor/app");
      version = (await App.getInfo()).version;
    } catch {
      /* only used for support conversations */
    }
    const { error } = await (
      supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{ error: unknown }>
    )("register_push_device", {
      _token: token,
      _platform: nativePlatform(),
      _app_version: version,
    });
    if (error) return false;
    await (await preferences()).Preferences.set({ key: TOKEN_KEY, value: token });
    return true;
  } catch {
    return false;
  }
}

/** Has this phone been filed for delivery, as far as this device knows? */
export async function hasNativePushToken(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    return !!(await (await preferences()).Preferences.get({ key: TOKEN_KEY })).value;
  } catch {
    return false;
  }
}

/**
 * Take this phone off the account's list. Called on sign-out, while the
 * session still exists (row-level security needs it to delete the row).
 * The OS registration is kept, so the next person to sign in is re-filed
 * without being asked again.
 */
export async function releaseNativePush(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const prefs = (await preferences()).Preferences;
    const { value } = await prefs.get({ key: TOKEN_KEY });
    if (!value) return;
    await (
      supabase.from("push_devices" as never) as unknown as {
        delete: () => { eq: (col: string, v: string) => PromiseLike<{ error: unknown }> };
      }
    )
      .delete()
      .eq("token", value);
    await prefs.remove({ key: TOKEN_KEY });
  } catch {
    /* offline: the server clears it the first time it is refused, or the next sign-in takes it over */
  }
}

/** Switched off in Settings: off the list, and the OS registration dropped too. */
export async function unregisterNativePush(): Promise<void> {
  await releaseNativePush();
  if (!(await nativePushAvailable())) return;
  try {
    await (await plugin()).PushNotifications.unregister();
  } catch {
    /* nothing registered */
  }
}

/**
 * A tap on a notification opens the page it is about. Registered at start-up
 * (src/lib/native/bootstrap.ts) so a tap that launched the app is handled too:
 * the plugin holds that event until a listener is attached.
 */
export async function wireNativePushTaps(router: AnyRouter): Promise<void> {
  if (!(await nativePushAvailable())) return;
  const push = (await plugin()).PushNotifications;
  await push.addListener("pushNotificationActionPerformed", ({ notification }) => {
    const data = (notification.data ?? {}) as Record<string, unknown>;
    const link = typeof data.link === "string" ? data.link : "/dashboard";
    // Only the app's own pages. A link is written by our own triggers, but a
    // tap is no reason to leave the app for somewhere else.
    if (!link.startsWith("/") || link.startsWith("//")) return;
    void router.navigate({ href: link });
  });
}
