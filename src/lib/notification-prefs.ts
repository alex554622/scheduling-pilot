import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  DEFAULT_NOTIFICATION_SOUND,
  isNotificationSound,
  type NotificationSound,
} from "@/lib/notify-sound";

/**
 * What each person wants to be told about, and how.
 *
 * Kept on the account rather than the device, because the database is what
 * decides whether a notification row is written at all: `wants_notification()`
 * reads this same column inside the triggers that announce a schedule. A
 * preference held only in a browser could mute the bell but not the writing.
 *
 * The exception is the desktop pop-up, which needs the browser's own
 * permission and so can only ever be true on a device that granted it.
 */

/** The kinds that can be switched off, in the order the settings screen lists them. */
export const NOTIFICATION_TYPES = [
  {
    key: "schedule_published",
    label: "New schedule published",
    detail: "When a week you are on is published.",
  },
  {
    key: "schedule_changed",
    label: "Schedule changes",
    detail: "When a published shift of yours is moved, reassigned or removed.",
  },
  {
    key: "break_ending",
    label: "Break almost over",
    detail: "A reminder two minutes before your break is up.",
  },
  {
    key: "announcement",
    label: "Announcements",
    detail: "When an admin posts an announcement on Messages.",
  },
  {
    // Client-side only: a board message never writes a notification row —
    // one per post per person would bury the bell — so this switch is read in
    // the browser rather than by `wants_notification()`.
    key: "board_message",
    label: "New messages",
    detail: "A pop-up when someone posts on Messages.",
  },
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]["key"];

export interface NotificationPrefs {
  /** The master switch. Off means nothing is written and nothing is shown. */
  enabled: boolean;
  /** Per kind. A key that isn't here is on — see `wants_notification()`. */
  types: Record<string, boolean>;
  /**
   * Pop one up in the app as it arrives, rather than only counting it on the
   * bell. On by default: a notification nobody is told about is a notification
   * that did not happen, which is the complaint this whole feature started on.
   */
  popup: boolean;
  /** A sound when something pops up. On by default, and one switch to silence. */
  sound: boolean;
  /**
   * Which sound. Kept on the account rather than the device, so somebody who
   * has learned to recognise one hears it on their phone as well as at their
   * desk. Anything unsaid — or saved by a build that predates the choice — is
   * the default, the same way an absent type is on.
   */
  soundName: NotificationSound;
  /**
   * Also show them as system pop-ups, on devices that have granted it — and,
   * on a device that could be registered for push, when the app is shut. See
   * `@/lib/push-subscription`.
   */
  desktop: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  types: {},
  popup: true,
  sound: true,
  soundName: DEFAULT_NOTIFICATION_SOUND,
  desktop: false,
};

function parse(raw: unknown): NotificationPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_NOTIFICATION_PREFS;
  const o = raw as Record<string, unknown>;
  const types = o.types && typeof o.types === "object" ? (o.types as Record<string, boolean>) : {};
  return {
    enabled: o.enabled !== false,
    types,
    // Absent means on, the same way an absent type does.
    popup: o.popup !== false,
    sound: o.sound !== false,
    soundName: isNotificationSound(o.soundName) ? o.soundName : DEFAULT_NOTIFICATION_SOUND,
    desktop: o.desktop === true,
  };
}

export interface NotificationPrefsHandle {
  prefs: NotificationPrefs;
  isLoading: boolean;
  /**
   * True when the column this reads has not reached the database yet. Nothing
   * is muted in that state — the screen says so instead of pretending to save.
   */
  unavailable: boolean;
  isSaving: boolean;
  /** Is this kind switched on, master switch included? */
  wants: (type: NotificationType | string) => boolean;
  setEnabled: (on: boolean) => void;
  setType: (type: NotificationType | string, on: boolean) => void;
  setPopup: (on: boolean) => void;
  setSound: (on: boolean) => void;
  setSoundName: (sound: NotificationSound) => void;
  setDesktop: (on: boolean) => void;
}

export function useNotificationPrefs(): NotificationPrefsHandle {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = ["notification-prefs", user?.id];

  const q = useQuery({
    queryKey: key,
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("notification_prefs")
        .eq("id", user!.id)
        .maybeSingle();
      // A database that hasn't taken the migration yet answers with an error
      // about the column. That is not a reason to break the page: everything
      // stays on, and the settings screen explains why it cannot be changed.
      if (error) return { prefs: DEFAULT_NOTIFICATION_PREFS, unavailable: true };
      return { prefs: parse(data?.notification_prefs), unavailable: false };
    },
  });

  const prefs = q.data?.prefs ?? DEFAULT_NOTIFICATION_PREFS;
  const unavailable = q.data?.unavailable ?? false;

  const save = useMutation({
    mutationFn: async (next: NotificationPrefs) => {
      const { error } = await supabase
        .from("profiles")
        .update({ notification_prefs: next as never })
        .eq("id", user!.id);
      if (error) throw error;
      return next;
    },
    // Written straight into the cache so the switch answers the click rather
    // than the round trip.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData(key);
      qc.setQueryData(key, { prefs: next, unavailable: false });
      return { previous };
    },
    onError: (_e, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  const wants = useCallback(
    (type: NotificationType | string) => prefs.enabled && prefs.types[type] !== false,
    [prefs],
  );

  return {
    prefs,
    isLoading: q.isLoading,
    unavailable,
    isSaving: save.isPending,
    wants,
    setEnabled: (on) => save.mutate({ ...prefs, enabled: on }),
    setType: (type, on) => save.mutate({ ...prefs, types: { ...prefs.types, [type]: on } }),
    setPopup: (on) => save.mutate({ ...prefs, popup: on }),
    setSound: (on) => save.mutate({ ...prefs, sound: on }),
    setSoundName: (sound) => save.mutate({ ...prefs, sound: true, soundName: sound }),
    setDesktop: (on) => save.mutate({ ...prefs, desktop: on }),
  };
}

/* ------------------------------ system pop-ups --------------------------- */

/**
 * Installed apps do not show notifications the way a tab does. Chrome on
 * Android throws "Illegal constructor" for `new Notification()`, and iOS has
 * no constructor at all — both will only show one through a service worker.
 * So everything below goes through `/sw.js` where there is one, and falls
 * back to the constructor on a plain desktop tab.
 */

/** Running from the home screen / app window rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/** Whether this browser can show system notifications at all. */
export function desktopSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function desktopPermission(): NotificationPermission | "unsupported" {
  return desktopSupported() ? Notification.permission : "unsupported";
}

/**
 * Register the worker that shows the notifications, once per page load.
 *
 * iOS only offers notifications to an installed app, so on a tab there is
 * nothing to register for and nothing is attempted.
 */
let swRegistration: Promise<ServiceWorkerRegistration | null> | null = null;
export function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }
  swRegistration ??= navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return swRegistration;
}

/** Ask once. Returns what the browser settled on, "denied" if it isn't offered. */
export async function requestDesktopPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!desktopSupported()) return "unsupported";
  // The worker has to be there before the first notification, and asking is
  // the moment we know one is wanted.
  void ensureServiceWorker();
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Show one, if this browser allows them. `link` is where a tap should land.
 *
 * Silently does nothing when permission is missing — a reminder is never worth
 * an exception thrown at the person who was only trying to clock in.
 */
export async function showAppNotification(
  title: string,
  body: string,
  tag?: string,
  link?: string,
): Promise<void> {
  if (!desktopSupported() || Notification.permission !== "granted") return;
  const reg = await ensureServiceWorker();
  // The worker's own registration is the only route an installed app has.
  if (reg?.showNotification) {
    try {
      await reg.showNotification(title, {
        body,
        tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { link: link ?? "/dashboard" },
      });
      return;
    } catch {
      /* fall through to the constructor below */
    }
  }
  try {
    new Notification(title, { body, tag, icon: "/icons/icon-192.png" });
  } catch {
    /* a tab that refuses both: the in-app toast is what they get */
  }
}
