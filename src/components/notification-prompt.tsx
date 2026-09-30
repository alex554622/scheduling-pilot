import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  desktopPermission,
  isStandalone,
  requestDesktopPermission,
  useNotificationPrefs,
} from "@/lib/notification-prefs";
import { pushConfigured, pushSupported, subscribeToPush } from "@/lib/push-subscription";

/**
 * "Turn on notifications", asked the way a chat app asks on first open.
 *
 * Without this, a phone was only registered for push by someone who found the
 * switch at the bottom of Settings. Almost nobody did, so the server queued
 * every break reminder, shift change and message and delivered it to no one —
 * and recorded that as a success, because a person with no device is not an
 * error. The fix for "notifications don't come" was never on the server.
 *
 * The browser's own prompt has to come from a tap (iOS refuses otherwise, and
 * Chrome quietly blocks sites that ask unprompted), so this is a card with a
 * button, not a call on page load. "Not now" hides it on this device for a
 * week; it is never shown once the browser has said "denied", because only the
 * person can undo that, in the browser's own settings.
 */

const SNOOZE_KEY = "notify-prompt-snoozed-until";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

type Mode = "hidden" | "ask" | "install";

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent);
}

export function NotificationPrompt() {
  const { user } = useAuth();
  const { prefs, isLoading } = useNotificationPrefs();
  const [mode, setMode] = useState<Mode>("hidden");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Someone who switched it off in Settings meant it.
    if (!user || isLoading || !prefs.enabled || !prefs.desktop || snoozed()) {
      setMode("hidden");
      return;
    }
    // Safari offers notifications only to an app added to the Home Screen, so
    // on an iPhone tab the useful thing to say is how to get there.
    if (isIos() && !isStandalone() && !pushSupported()) {
      setMode("install");
      return;
    }
    if (!pushSupported() || !pushConfigured()) {
      setMode("hidden");
      return;
    }
    const permission = desktopPermission();
    if (permission === "denied" || permission === "unsupported") {
      setMode("hidden");
      return;
    }
    // Granted already: the layout's registration hook takes it from here, and
    // there is nothing to ask. Only ask where the browser has never been asked.
    if (permission === "granted") {
      setMode("hidden");
      return;
    }
    setMode("ask");
  }, [user, isLoading, prefs.enabled, prefs.desktop]);

  if (mode === "hidden") return null;

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      /* private mode — it simply comes back next time */
    }
    setMode("hidden");
  };

  const allow = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const result = await requestDesktopPermission();
      if (result === "granted") await subscribeToPush(user.id);
    } finally {
      setBusy(false);
      setMode("hidden");
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Turn on notifications"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-xl border border-border bg-card p-4 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4"
    >
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Turn on notifications</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === "install"
              ? "To get alerts on this iPhone or iPad, tap Share, then “Add to Home Screen”, and open Scheduling Pilot from there."
              : "Get a buzz on this device when your break is almost over, your shifts change, or someone sends a message — even with the app closed."}
          </p>
          <div className="mt-3 flex gap-2">
            {mode === "ask" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void allow()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {busy ? "Turning on…" : "Turn on"}
              </button>
            )}
            <button
              type="button"
              onClick={snooze}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={snooze}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
