import { useCallback, useEffect, useSyncExternalStore } from "react";
import { es as esDateLocale } from "date-fns/locale/es";
import type { Locale } from "date-fns";
import { ES, ES_AREAS, type Area } from "./es";

/**
 * Language.
 *
 * Kept on the device, like night mode (see `@/lib/theme`): it has to be known
 * before anything is drawn, and someone sharing a phone at a clock-in station
 * should not flip the language of everyone else's account.
 *
 * Strings are keyed by their English text. `t("Save changes")` returns the
 * Spanish entry when Spanish is chosen and one exists, and the English text
 * otherwise — so a string nobody has translated yet still reads, in English,
 * instead of showing a key. Placeholders are `{name}`: `t("Hi {name}", { name })`.
 */

export type Lang = "en" | "es";

export const LANGUAGES: { value: Lang; label: string; native: string }[] = [
  { value: "en", label: "English", native: "English" },
  { value: "es", label: "Spanish", native: "Español" },
];

const KEY = "sp-lang";
const EVENT = "sp-lang-change";
const DEFAULT_LANG: Lang = "en";

const DICTS: Record<Lang, Record<string, string> | null> = { en: null, es: ES };

function read(): Lang {
  if (typeof window === "undefined") return DEFAULT_LANG;
  try {
    const v = localStorage.getItem(KEY);
    return v === "en" || v === "es" ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  // Another tab changing it.
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** The current language, for code outside React (toasts, error messages). */
export function currentLang(): Lang {
  return read();
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* private mode — it holds for this page only */
  }
  document.documentElement.lang = lang;
  window.dispatchEvent(new CustomEvent(EVENT));
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export type TFunction = (text: string, vars?: Record<string, string | number>) => string;

/** Translate outside React. Prefer `useT()` in components so they re-render on a change. */
export function translate(
  text: string,
  vars?: Record<string, string | number>,
  lang = read(),
  area?: Area,
) {
  const own = lang === "es" && area ? ES_AREAS[area][text] : undefined;
  return interpolate(own ?? DICTS[lang]?.[text] ?? text, vars);
}

/** The chosen language, and a way to change it. Renders English on the server. */
export function useLang(): { lang: Lang; setLang: (l: Lang) => void } {
  const lang = useSyncExternalStore(subscribe, read, () => DEFAULT_LANG);
  return { lang, setLang };
}

/**
 * `t()` for the current language. Pass the screen's area so a word with more
 * than one meaning gets the one that area chose — see `./es`.
 */
export function useT(area?: Area): TFunction {
  const { lang } = useLang();
  return useCallback(
    (text: string, vars?: Record<string, string | number>) => translate(text, vars, lang, area),
    [lang, area],
  );
}

/** For date-fns `format(d, "…", { locale })`. Undefined means date-fns' English default. */
export function useDateLocale(): Locale | undefined {
  return useLang().lang === "es" ? esDateLocale : undefined;
}

/**
 * For `toLocaleDateString(tag, …)` / `Intl`. English keeps `undefined` (the
 * browser's own locale, as before); Spanish forces "es" so the dates match the
 * words around them whatever the browser is set to.
 */
export function useLocaleTag(): string | undefined {
  return useLang().lang === "es" ? "es" : undefined;
}

export function localeTag(): string | undefined {
  return read() === "es" ? "es" : undefined;
}

/** Keeps <html lang> in step with the choice. Mount once near the root. */
export function useLangController(): void {
  const { lang } = useLang();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
}
