import { Moon, Sun } from "lucide-react";
import { useThemePref } from "@/lib/theme";
import { useT } from "@/lib/i18n";

/**
 * The one-tap switch in the header. Two states, because that is what someone
 * reaching for it at night wants; "match my device" lives on Settings for the
 * people who want the app to follow the phone instead.
 */
export function ThemeToggle() {
  const { dark, setPref } = useThemePref();
  const t = useT("shell");
  const label = dark ? t("Switch to day mode") : t("Switch to night mode");
  return (
    <button
      type="button"
      onClick={() => setPref(dark ? "light" : "dark")}
      className="rounded-md p-2 text-muted-foreground hover:bg-accent"
      aria-label={label}
      title={label}
    >
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
