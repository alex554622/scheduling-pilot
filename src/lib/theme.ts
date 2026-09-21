import { useCallback, useEffect, useState } from "react";

/**
 * Night mode.
 *
 * Kept on the device, not the account: the phone someone checks their shift on
 * at night and the desk they run the schedule from by day want different
 * answers, and the choice has to be readable before the first paint — which a
 * round trip to the database never is.
 *
 * It applies to the signed-in app only. The marketing pages and the sign-in
 * screens are designed in light, so `ThemeController` sets the \`dark\` class on
 * <html> while the app is mounted and takes it off again on the way out, and
 * the pre-paint script in `__root` leaves those paths alone.
 */

export type ThemePref = "light" | "dark" | "system";

const KEY = "sp-theme";
const EVENT = "sp-theme-change";

/**
 * Light until someone asks otherwise. Night mode is an option being added, not
 * a change being made — nobody should sign in after a redeploy to a different-
 * looking app they did not choose.
 */
export const DEFAULT_THEME: ThemePref = "light";

/**
 * Paths outside the app, which stay light whatever was chosen. Mirrored in the
 * inline script in `__root.tsx`, which cannot import this.
 */
export const LIGHT_ONLY_PATHS = [
  "/",
  "/about",
  "/login",
  "/join",
  "/forgot-password",
  "/reset-password",
  "/employee-scheduling",
  "/shift-trading",
  "/time-clock",
  "/time-off-management",
  "/workforce-management",
];

export function readThemePref(): ThemePref {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

export function resolveDark(pref: ThemePref): boolean {
  return pref === "dark" || (pref === "system" && systemPrefersDark());
}

/** The choice, and a way to change it. Reading it never touches the page. */
export function useThemePref(): {
  pref: ThemePref;
  dark: boolean;
  setPref: (p: ThemePref) => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(DEFAULT_THEME);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const sync = () => setPrefState(readThemePref());
    sync();
    setSystemDark(systemPrefersDark());
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMq = () => setSystemDark(systemPrefersDark());
    // Another tab, or the other half of this one, changing it.
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    mq?.addEventListener?.("change", onMq);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
      mq?.removeEventListener?.("change", onMq);
    };
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* private mode — it holds for this page only */
    }
    setPrefState(p);
    window.dispatchEvent(new CustomEvent(EVENT));
  }, []);

  return { pref, dark: pref === "dark" || (pref === "system" && systemDark), setPref };
}

/**
 * Puts the choice on the page. Mount it once, in the authenticated layout:
 * while it is mounted the app follows the choice, and when it unmounts — sign
 * out, onto the login screen — the page goes back to light.
 */
export function useThemeController(): void {
  const { dark } = useThemePref();
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => () => document.documentElement.classList.remove("dark"), []);
}
