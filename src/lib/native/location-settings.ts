import { registerPlugin } from "@capacitor/core";
import { nativePlatform } from "./platform";

/**
 * Sends someone to where they can let this app use their location.
 *
 * - Android app: this app's page in Settings (Permissions → Location), via the
 *   app's own AppSettings plugin (android/…/AppSettingsPlugin.java).
 * - iOS app: the `app-settings:` URL, which iOS opens as this app's page in the
 *   Settings app (Location is listed there).
 * - Browser: a page cannot open browser settings, so it asks for location
 *   again. That shows the browser's prompt if the person never answered it;
 *   if they blocked it, the browser stays quiet and the caller shows how to
 *   unblock it by hand.
 *
 * Resolves to "opened" when it handed off to Settings or the prompt was
 * granted, and "blocked" when the browser refused without asking.
 */
const AppSettings = registerPlugin<{ openAppSettings(): Promise<void> }>("AppSettings");

export async function openLocationSettings(): Promise<"opened" | "blocked"> {
  const platform = nativePlatform();
  if (platform === "android") {
    await AppSettings.openAppSettings();
    return "opened";
  }
  if (platform === "ios") {
    window.location.href = "app-settings:";
    return "opened";
  }
  if (!("geolocation" in navigator)) return "blocked";
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve("opened"),
      () => resolve("blocked"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });
}
