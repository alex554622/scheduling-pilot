import type { AnyRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { isNativeApp, nativePlatform, PUBLIC_SITE_ORIGIN } from "./platform";
import { wireNativePushTaps } from "./push";

/**
 * One-time wiring that makes the web app behave like an app on a phone:
 * the Android back button, status-bar colours that follow night mode, the
 * splash screen, links from emails that open in the app, and taps on a
 * lock-screen notification.
 *
 * Every plugin is imported here, on first use, so none of it reaches the
 * website's bundle. Called once from the root route; a no-op off-device.
 */
let started = false;

export function startNativeShell(router: AnyRouter): void {
  if (started || !isNativeApp()) return;
  started = true;

  void wireBackButton(router);
  void followThemeInStatusBar();
  void wireDeepLinks(router);
  void wireNativePushTaps(router);
  void hideSplash();
}

/**
 * Android's back button walks back through the app's own history, closes an
 * open dialog or menu first (the same as pressing Escape would), and only at
 * the first screen sends the app to the background — the platform convention.
 */
async function wireBackButton(router: AnyRouter) {
  if (nativePlatform() !== "android") return;
  const { App } = await import("@capacitor/app");
  await App.addListener("backButton", ({ canGoBack }) => {
    const open = document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    );
    if (open) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return;
    }
    if (canGoBack && router.history.canGoBack()) {
      router.history.back();
      return;
    }
    void App.minimizeApp();
  });
}

/**
 * Light icons on a dark app and dark icons on a light one. Night mode is a
 * class on <html> (see lib/theme.ts), so the status bar watches that class
 * rather than reaching into the theme code.
 */
async function followThemeInStatusBar() {
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  const root = document.documentElement;
  const apply = () => {
    const dark = root.classList.contains("dark");
    void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
  };
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["class"] });
}

async function hideSplash() {
  const { SplashScreen } = await import("@capacitor/splash-screen");
  // The shell has painted by the time this runs; a short fade hides the swap.
  await SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => {});
}

/**
 * Links to schedulingpilot.com that the OS hands to the app (Android App
 * Links / iOS Universal Links — set up in docs/mobile/deep-links.md).
 *
 * A password-reset or sign-up link carries the session in its #fragment, the
 * way Supabase sends it to the website. The website's client reads that from
 * the address bar on load; the app was already loaded, so the tokens are
 * handed to Supabase here and the app then opens the page the link was for.
 */
async function wireDeepLinks(router: AnyRouter) {
  const { App } = await import("@capacitor/app");

  const open = async (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.origin !== PUBLIC_SITE_ORIGIN && url.origin !== "https://www.schedulingpilot.com") {
      return;
    }

    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    if (access_token && refresh_token) {
      await supabase.auth.setSession({ access_token, refresh_token }).catch(() => {});
    }
    // An expired or already-used link arrives as #error=…; the pages that
    // handle auth links read it from the hash (lib/auth-link-error.ts).
    const keepHash = hash.has("error") || hash.has("error_description") ? url.hash : "";
    await router.navigate({ href: `${url.pathname}${url.search}${keepHash}` });
  };

  await App.addListener("appUrlOpen", ({ url }) => void open(url));
  // A link that cold-started the app arrives as the launch URL instead.
  const launch = await App.getLaunchUrl().catch(() => undefined);
  if (launch?.url) await open(launch.url);
}
