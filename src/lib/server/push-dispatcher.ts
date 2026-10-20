/**
 * The loop that empties `push_queue`.
 *
 * It runs inside the Node container that already serves the app, started from
 * `src/server.ts`. That is the whole reason this design was picked over a cron
 * job or an edge function: the container is up anyway, twenty-four hours a day,
 * and a break reminder due in eight minutes needs nothing more than something
 * that is still awake in eight minutes.
 *
 * Each row goes to every device its owner has: browsers through Web Push
 * (`push_subscriptions`), and phones running the Android or iOS app through
 * FCM or APNs (`push_devices`, see native-push.ts).
 *
 * Safe to run in more than one container. `claim_due_pushes` hands a row to
 * exactly one caller (`for update skip locked`), so a second replica takes the
 * next row rather than the same one.
 *
 * Server only — see `importProtection` in vite.config.ts.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  sendPush,
  vapidKeysFromEnv,
  type PushResult,
  type PushSubscriptionRecord,
  type VapidKeys,
} from "@/lib/server/web-push";
import {
  apnsConfigFromEnv,
  fcmConfigFromEnv,
  sendApns,
  sendFcm,
  type ApnsConfig,
  type FcmConfig,
} from "@/lib/server/native-push";

/** How often to look, when the last look found nothing. */
const IDLE_POLL_MS = 15_000;
/** How many rows to take at a time. A full batch is drained without waiting. */
const BATCH = 25;

interface QueueRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  tag: string | null;
}

interface SubscriptionRow extends PushSubscriptionRecord {
  id: string;
  user_id: string;
}

/** A phone running the Android or iOS app (`push_devices`). */
interface DeviceRow {
  id: string;
  user_id: string;
  platform: "android" | "ios";
  token: string;
}

/**
 * Who this deployment can send through. Each is optional: a server with only
 * VAPID keys serves the website exactly as before, and one with only Firebase
 * and Apple credentials serves only the apps.
 */
interface Senders {
  vapid: VapidKeys | null;
  fcm: FcmConfig | null;
  apns: ApnsConfig | null;
}

/** The two tables a device can be filed in. */
type DeviceTable = "push_subscriptions" | "push_devices";

/** One device a notification is about to go to, whichever service it uses. */
interface Target {
  table: DeviceTable;
  id: string;
  send: () => Promise<PushResult>;
}

/**
 * The generated Supabase types predate these tables, and regenerating them
 * needs a linked CLI. Casting at the one boundary keeps the rest of the file
 * honestly typed — the same trick the app already uses for `notification_prefs`
 * and the template `pattern` column.
 */
const db = supabaseAdmin as unknown as {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, values: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
    };
    delete: () => {
      in: (col: string, values: string[]) => PromiseLike<{ error: unknown }>;
    };
  };
};

function errText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "object" && "message" in error) return String((error as Error).message);
  return String(error);
}

/**
 * Send one queued notification to every device its owner has registered.
 *
 * Returns what to record against the row. Somebody with a phone and a laptop
 * counts as delivered if either took it — a laptop that has been reinstalled
 * should not keep a break reminder off the phone in a pocket.
 */
async function deliver(
  row: QueueRow,
  subs: SubscriptionRow[],
  devices: DeviceRow[],
  senders: Senders,
  alertSound: boolean,
): Promise<{ error: string | null; gone: Target[] }> {
  const payload = {
    title: row.title,
    body: row.body ?? "",
    link: row.link ?? "/dashboard",
    tag: row.tag ?? `push-${row.id}`,
    // The worker draws a break reminder as an alarm and everything else as a
    // message, so it needs to know which this is.
    type: row.type,
  };

  // How long the push service should hold this for a phone that is switched
  // off or out of signal. A break reminder is only true for as long as the
  // break has two minutes left on it, so it is allowed to go stale rather than
  // surface later saying something that is no longer so. The rest keep for a
  // day, as a chat message would: a shift change is still news to someone
  // whose phone was off over lunch.
  const ttl = row.type === "break_ending" ? 3 * 60 : 24 * 60 * 60;

  const { vapid, fcm, apns } = senders;
  const targets: Target[] = [];
  if (vapid) {
    for (const s of subs) {
      targets.push({
        table: "push_subscriptions",
        id: s.id,
        send: () => sendPush(s, payload, vapid, ttl),
      });
    }
  }
  for (const d of devices) {
    // A phone whose platform this server has no credentials for is skipped,
    // not failed: it starts receiving as soon as the credentials are added.
    if (d.platform === "android" && fcm) {
      targets.push({
        table: "push_devices",
        id: d.id,
        send: () => sendFcm(fcm, d.token, { ...payload, alertSound }, ttl),
      });
    } else if (d.platform === "ios" && apns) {
      targets.push({
        table: "push_devices",
        id: d.id,
        send: () => sendApns(apns, d.token, payload, ttl),
      });
    }
  }

  if (targets.length === 0) {
    // Nobody has said yes on any device. Not a failure, and retrying it four
    // more times would not change that.
    return { error: null, gone: [] };
  }

  const results = await Promise.all(targets.map((t) => t.send()));

  const gone: Target[] = [];
  let delivered = false;
  let lastError = "";
  results.forEach((result, i) => {
    if (result.ok) {
      delivered = true;
      return;
    }
    if (result.gone) gone.push(targets[i]);
    lastError = result.error;
  });

  // Every device gone is still a finished row: there is nowhere left to send
  // it, and the subscriptions are about to be deleted.
  if (delivered || gone.length === results.length) return { error: null, gone };
  return { error: lastError || "delivery failed", gone };
}

/** Said once per process, so a database without `push_devices` does not fill the log. */
let warnedNoDeviceTable = false;

/** Rows of one owner-keyed table, grouped by owner. */
async function byOwner<T extends { user_id: string }>(
  table: DeviceTable,
  cols: string,
  userIds: string[],
): Promise<Map<string, T[]>> {
  const q = await db.from(table).select(cols).in("user_id", userIds);
  if (q.error) throw new Error(errText(q.error));
  const map = new Map<string, T[]>();
  for (const row of (q.data ?? []) as T[]) {
    const list = map.get(row.user_id);
    if (list) list.push(row);
    else map.set(row.user_id, [row]);
  }
  return map;
}

/**
 * Which of these people belong to a company approved for the recorded break
 * alert (`companies.break_alert_sound`). Only the Android app can play it with
 * the app closed, so this is asked only for break reminders headed there.
 *
 * A failed lookup is the standard sound, not a failed notification.
 */
async function approvedForAlertSound(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const q = await db.from("profiles").select("id, companies(break_alert_sound)").in("id", userIds);
  if (q.error) {
    console.warn("[push] could not read break_alert_sound:", errText(q.error));
    return new Set();
  }
  const rows = (q.data ?? []) as {
    id: string;
    companies: { break_alert_sound?: boolean } | null;
  }[];
  return new Set(rows.filter((r) => r.companies?.break_alert_sound === true).map((r) => r.id));
}

/** One pass. Returns how many rows it handled, so a full batch can be drained. */
async function drainOnce(senders: Senders): Promise<number> {
  const claimed = await db.rpc("claim_due_pushes", { _limit: BATCH });
  if (claimed.error) throw new Error(errText(claimed.error));
  const rows = (claimed.data ?? []) as QueueRow[];
  if (rows.length === 0) return 0;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const subsByUser = senders.vapid
    ? await byOwner<SubscriptionRow>(
        "push_subscriptions",
        "id, user_id, endpoint, p256dh, auth",
        userIds,
      )
    : new Map<string, SubscriptionRow[]>();

  let devicesByUser = new Map<string, DeviceRow[]>();
  if (senders.fcm || senders.apns) {
    try {
      devicesByUser = await byOwner<DeviceRow>(
        "push_devices",
        "id, user_id, platform, token",
        userIds,
      );
    } catch (e) {
      // Most likely the migration that adds the table has not been applied.
      // The website's own deliveries must not wait on that.
      if (!warnedNoDeviceTable) {
        warnedNoDeviceTable = true;
        console.warn("[push] could not read push_devices, so the apps get nothing:", String(e));
      }
    }
  }

  // Rows for people with no device on file are finished without a send. That
  // is correct, but it is also exactly how "my phone never buzzes" looks from
  // the server, so it is said out loud rather than recorded as a success.
  const unreachable = rows.filter(
    (r) => !subsByUser.has(r.user_id) && !devicesByUser.has(r.user_id),
  );
  if (unreachable.length > 0) {
    console.info(
      `[push] ${unreachable.length} of ${rows.length} due notification(s) had no registered ` +
        `device (${[...new Set(unreachable.map((r) => r.type))].join(", ")})`,
    );
  }

  const alertSound = await approvedForAlertSound([
    ...new Set(
      rows
        .filter((r) => r.type === "break_ending" && devicesByUser.has(r.user_id))
        .map((r) => r.user_id),
    ),
  ]);

  const dead: Record<DeviceTable, Set<string>> = {
    push_subscriptions: new Set(),
    push_devices: new Set(),
  };
  await Promise.all(
    rows.map(async (row) => {
      const { error, gone } = await deliver(
        row,
        subsByUser.get(row.user_id) ?? [],
        devicesByUser.get(row.user_id) ?? [],
        senders,
        alertSound.has(row.user_id),
      );
      for (const t of gone) dead[t.table].add(t.id);
      const marked = await db.rpc("mark_push_sent", { _id: row.id, _error: error });
      if (marked.error) console.error("[push] could not mark row", row.id, errText(marked.error));
    }),
  );

  // A device the push service has disowned — browser reinstalled, app
  // deleted, permission revoked — is never coming back. Left in place it would
  // fail on every notification forever.
  for (const table of Object.keys(dead) as DeviceTable[]) {
    if (dead[table].size === 0) continue;
    const { error } = await db
      .from(table)
      .delete()
      .in("id", [...dead[table]]);
    if (error) console.error(`[push] could not clear dead rows in ${table}`, errText(error));
  }

  return rows.length;
}

/** Guards against the dev server re-evaluating this module on every reload. */
const RUNNING = Symbol.for("scheduling-pilot.push-dispatcher");
/** Start-up is attempted twice (push-plugin.ts and server.ts); the warnings are said once. */
const WARNED = Symbol.for("scheduling-pilot.push-dispatcher.warned");

/**
 * Start the loop, if this deployment is set up for push.
 *
 * Missing keys or a missing service-role key are a configuration state, not a
 * crash: the app runs, in-app pop-ups still work, and the log says once what is
 * needed to reach a closed phone.
 */
export function startPushDispatcher(): void {
  const global = globalThis as Record<symbol, unknown>;
  if (global[RUNNING]) return;
  const warn = global[WARNED] ? () => {} : console.warn;
  global[WARNED] = true;

  const senders: Senders = {
    vapid: vapidKeysFromEnv(),
    fcm: fcmConfigFromEnv(),
    apns: apnsConfigFromEnv(),
  };
  if (!senders.vapid) {
    warn(
      "[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — the website's notifications " +
        "will only appear while it is open. Run `bun run vapid:keys` to make a pair.",
    );
  }
  if (!senders.fcm) {
    warn(
      "[push] FCM_SERVICE_ACCOUNT is not set — the Android app will only show alerts while it " +
        "is open. See docs/mobile/push-notifications.md.",
    );
  }
  if (!senders.apns) {
    warn(
      "[push] APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY are not set — the iOS app will only " +
        "show alerts while it is open. See docs/mobile/push-notifications.md.",
    );
  }
  if (!senders.vapid && !senders.fcm && !senders.apns) return;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_URL) {
    warn(
      "[push] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — the queue cannot be read, " +
        "so notifications will only appear while the app is open.",
    );
    return;
  }

  global[RUNNING] = true;
  console.log(
    `[push] dispatcher started (web: ${senders.vapid ? "on" : "off"}, ` +
      `android: ${senders.fcm ? "on" : "off"}, ios: ${senders.apns ? "on" : "off"})`,
  );

  let stopping = false;
  const tick = async () => {
    while (!stopping) {
      let handled = 0;
      try {
        handled = await drainOnce(senders);
      } catch (e) {
        // A database hiccup should slow the loop down, not end it.
        console.error("[push] dispatcher pass failed:", e);
        handled = 0;
      }
      // A full batch means there is more waiting; anything less means the queue
      // is caught up and the next thing due is in the future.
      if (handled < BATCH) {
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
      }
    }
  };

  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  void tick();
}
