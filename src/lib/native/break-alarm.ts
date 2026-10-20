import { translate } from "@/lib/i18n";
import { isNativeApp, nativePlatform } from "./platform";
import {
  BREAK_ALERT_CHANNEL_ID,
  breakAlertChannel,
  hasNativePushToken,
  nativePushPermission,
} from "./push";

/**
 * "Two minutes left on your break", set as an alarm on the phone itself.
 *
 * The server already queues this reminder the moment a break starts and sends
 * it through Firebase/APNs (`push_for_break`, src/lib/native/push.ts). That
 * only reaches a phone that is registered for push, and a build without a
 * Firebase config, or a phone that never got a token, is not. The reminder
 * people time themselves by then said nothing once the screen locked.
 *
 * The end of a break is known when it starts, so the phone can set its own
 * alarm for it: no network, no server, nothing has to stay running. The OS
 * draws it on the lock screen with the app closed.
 *
 * Only one of the two may speak, or the phone buzzes twice: where this phone's
 * push token is on file the server's reminder is the one (it also covers a
 * break started on a shared clock-in tablet), and this alarm is cleared.
 *
 * The plugin is imported on first use so the website never downloads it.
 */
const plugin = () => import("@capacitor/local-notifications");

/** One break at a time, so one fixed id: re-arming replaces, cancelling clears. */
const ALARM_ID = 220_002;

/** The same channel the pushed reminder uses (ANDROID_CHANNELS.break). */
const CHANNEL = "break";

const tr = (text: string, vars?: Record<string, string | number>) =>
  translate(text, vars, undefined, "shell");

let channelReady: Promise<void> | null = null;
function ensureChannel(): Promise<void> {
  if (nativePlatform() !== "android") return Promise.resolve();
  channelReady ??= (async () => {
    const local = (await plugin()).LocalNotifications;
    await local.createChannel({
      id: CHANNEL,
      name: tr("Break almost over"),
      description: tr("A reminder two minutes before your break is up."),
      importance: 5,
      visibility: 1,
      vibration: true,
    });
    await local.createChannel(breakAlertChannel());
  })().catch(() => {
    channelReady = null;
  });
  return channelReady;
}

export interface BreakAlarm {
  /** When to speak up: two minutes before the end. */
  warnAt: number;
  /** The length the employee picked, for the sentence. */
  minutes: number;
  /** The company is approved for the recorded alert (useBreakAlertSound). */
  alertSound: boolean;
}

/** The last thing asked for, so a re-render does not re-schedule the same alarm. */
let current: string | null = null;

/**
 * Make the phone's alarm match the break: set for `alarm`, or cleared for
 * null. Safe to call on every render; never throws.
 */
export async function syncBreakAlarm(alarm: BreakAlarm | null): Promise<void> {
  if (!isNativeApp()) return;
  // The server is sending it to this phone already; one is enough.
  const wanted = alarm && alarm.warnAt > Date.now() && !(await hasNativePushToken()) ? alarm : null;
  const key = wanted ? `${wanted.warnAt}:${wanted.alertSound}` : null;
  if (key === current) return;
  current = key;
  try {
    const local = (await plugin()).LocalNotifications;
    await local.cancel({ notifications: [{ id: ALARM_ID }] }).catch(() => {});
    if (!wanted) return;
    // Asked from a tap (the card or the Settings switch), never from here.
    if ((await nativePushPermission()) !== "granted") {
      current = null;
      return;
    }
    await ensureChannel();
    await local.schedule({
      notifications: [
        {
          id: ALARM_ID,
          title: tr("Break almost over"),
          body: tr("Two minutes left on your {minutes}-minute break.", { minutes: wanted.minutes }),
          // allowWhileIdle: fire in Doze too, which is where a locked phone in
          // a pocket is by the end of a break.
          schedule: { at: new Date(wanted.warnAt), allowWhileIdle: true },
          channelId: wanted.alertSound ? BREAK_ALERT_CHANNEL_ID : CHANNEL,
          smallIcon: "ic_stat_notify",
          extra: { link: "/timeclock" },
        },
      ],
    });
  } catch {
    // Nothing here may get in the way of clocking. The toast still shows if
    // the app is open.
    current = null;
  }
}
