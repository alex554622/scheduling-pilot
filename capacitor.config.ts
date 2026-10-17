import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android and iOS apps. Both bundle the web client built by
 * `bun run build:mobile` (a single-page build of this same codebase, see
 * vite.config.ts) and talk to the same Supabase backend as the website.
 *
 * No `server.url`: the apps ship their own copy of the web assets and never
 * load the website remotely. That is what keeps them working on a weak
 * connection and what App Store guideline 4.2 expects of an app. Full guide:
 * docs/mobile/README.md.
 */
const config: CapacitorConfig = {
  appId: "com.schedulingpilot.app",
  appName: "Sched Pilot",
  webDir: "dist/client",
  // Light background behind the web view while it loads — matches the splash.
  backgroundColor: "#ffffff",
  android: {
    // Release builds never accept cleartext HTTP; Supabase is HTTPS-only.
    allowMixedContent: false,
    // webContentsDebuggingEnabled is left unset: Capacitor then enables Chrome
    // inspection for debug builds only, never for the signed release.
  },
  ios: {
    // The page handles the safe areas itself (styles.css, viewport-fit=cover).
    contentInset: "never",
  },
  plugins: {
    SplashScreen: {
      // Hidden by the app once the first screen has painted
      // (lib/native/bootstrap.ts); the timeout is only a safety net.
      launchAutoHide: true,
      launchShowDuration: 3000,
      backgroundColor: "#ffffff",
      showSpinner: false,
      androidScaleType: "CENTER_INSIDE",
      splashFullScreen: false,
      splashImmersive: false,
    },
    SystemBars: {
      // Edge to edge, with --safe-area-inset-* injected for older Android web
      // views (see styles.css).
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
    },
    PushNotifications: {
      // While the app is open it shows notifications itself (the bell, the
      // toast, the break alarm), so iOS must not draw a second banner on top.
      // Android never draws one in the foreground. The OS takes over only when
      // the app is in the background or closed. See src/lib/native/push.ts.
      presentationOptions: [],
    },
    Keyboard: {
      // Keep focused fields above the keyboard on edge-to-edge Android.
      resizeOnFullScreen: true,
    },
  },
};

export default config;
