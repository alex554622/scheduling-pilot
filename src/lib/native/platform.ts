import { Capacitor } from "@capacitor/core";

/**
 * The Android and iOS apps.
 *
 * Both are this same web app, built by `build:mobile` and served from the
 * device by Capacitor (see capacitor.config.ts and docs/mobile/). Everything
 * native lives behind this check, so the website — browser tab or installed
 * from the manifest — keeps doing exactly what it did before the apps existed.
 */
export function isNativeApp(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

export function nativePlatform(): "android" | "ios" | null {
  if (!isNativeApp()) return null;
  const p = Capacitor.getPlatform();
  return p === "android" || p === "ios" ? p : null;
}

/** The public website, which links in emails and shared links must point at. */
export const PUBLIC_SITE_ORIGIN = "https://schedulingpilot.com";

/**
 * Where a link that leaves this device should send people.
 *
 * In a browser that is this page's own origin, so a staging deploy keeps
 * linking to staging. Inside the apps the origin is the device itself
 * (https://localhost on Android, capacitor://localhost on iOS), which means
 * nothing in an email or on someone else's phone — so those links go to the
 * public website instead.
 */
export function shareableOrigin(): string {
  if (typeof window === "undefined") return PUBLIC_SITE_ORIGIN;
  return isNativeApp() ? PUBLIC_SITE_ORIGIN : window.location.origin;
}
