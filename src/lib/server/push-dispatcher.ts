/**
 * The loop that empties `push_queue`.
 *
 * It runs inside the Node container that already serves the app, started from
 * `src/server.ts`. That is the whole reason this design was picked over a cron
 * job or an edge function: the container is up anyway, twenty-four hours a day,
 * and a break reminder due in eight minutes needs nothing more than something
 * that is still awake in eight minutes.
 *
 * Safe to run in more than one container. `claim_due_pushes` hands a row to
 * exactly one caller (`for update skip locked`), so a second replica takes the
 * next row rather than the same one.
 *
 * Server only — see `importProtection` in vite.config.ts.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPush, vapidKeysFromEnv, type PushSubscriptionRecord } from "@/lib/server/web-push";

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
  keys: NonNullable<ReturnType<typeof vapidKeysFromEnv>>,
): Promise<{ error: string | null; gone: string[] }> {
  if (subs.length === 0) {
    // Nobody has said yes on any device. Not a failure, and retrying it four
    // more times would not change that.
    return { error: null, gone: [] };
  }

  const payload = {
    title: row.title,
    body: row.body ?? "",
    link: row.link ?? "/dashboard",
    tag: row.tag ?? `push-${row.id}`,
  };

  // How long the push service should hold this for a phone that is switched
  // off or out of signal. A break reminder is only true for as long as the
  // break has two minutes left on it, so it is allowed to go stale rather than
  // surface later saying something that is no longer so; the rest keep.
  const ttl = row.type === "break_ending" ? 3 * 60 : 60 * 60;
  const results = await Promise.all(subs.map((s) => sendPush(s, payload, keys, ttl)));

  const gone: string[] = [];
  let delivered = false;
  let lastError = "";
  results.forEach((result, i) => {
    if (result.ok) {
      delivered = true;
      return;
    }
    if (result.gone) gone.push(subs[i].id);
    lastError = result.error;
  });

  // Every device gone is still a finished row: there is nowhere left to send
  // it, and the subscriptions are about to be deleted.
  if (delivered || gone.length === results.length) return { error: null, gone };
  return { error: lastError || "delivery failed", gone };
}

/** One pass. Returns how many rows it handled, so a full batch can be drained. */
async function drainOnce(keys: NonNullable<ReturnType<typeof vapidKeysFromEnv>>): Promise<number> {
  const claimed = await db.rpc("claim_due_pushes", { _limit: BATCH });
  if (claimed.error) throw new Error(errText(claimed.error));
  const rows = (claimed.data ?? []) as QueueRow[];
  if (rows.length === 0) return 0;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const subsQ = await db
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (subsQ.error) throw new Error(errText(subsQ.error));

  const byUser = new Map<string, SubscriptionRow[]>();
  for (const sub of (subsQ.data ?? []) as SubscriptionRow[]) {
    const list = byUser.get(sub.user_id);
    if (list) list.push(sub);
    else byUser.set(sub.user_id, [sub]);
  }

  const dead = new Set<string>();
  await Promise.all(
    rows.map(async (row) => {
      const { error, gone } = await deliver(row, byUser.get(row.user_id) ?? [], keys);
      for (const id of gone) dead.add(id);
      const marked = await db.rpc("mark_push_sent", { _id: row.id, _error: error });
      if (marked.error) console.error("[push] could not mark row", row.id, errText(marked.error));
    }),
  );

  // A subscription the push service has disowned — browser reinstalled, app
  // deleted, permission revoked — is never coming back. Left in place it would
  // fail on every notification forever.
  if (dead.size > 0) {
    const { error } = await db
      .from("push_subscriptions")
      .delete()
      .in("id", [...dead]);
    if (error) console.error("[push] could not clear dead subscriptions", errText(error));
  }

  return rows.length;
}

/** Guards against the dev server re-evaluating this module on every reload. */
const RUNNING = Symbol.for("scheduling-pilot.push-dispatcher");

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

  const keys = vapidKeysFromEnv();
  if (!keys) {
    console.warn(
      "[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — notifications will only " +
        "appear while the app is open. Run `bun run vapid:keys` to make a pair.",
    );
    return;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_URL) {
    console.warn(
      "[push] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — the queue cannot be read, " +
        "so notifications will only appear while the app is open.",
    );
    return;
  }

  global[RUNNING] = true;
  console.log("[push] dispatcher started");

  let stopping = false;
  const tick = async () => {
    while (!stopping) {
      let handled = 0;
      try {
        handled = await drainOnce(keys);
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
