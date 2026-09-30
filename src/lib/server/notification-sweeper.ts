/**
 * Deletes notifications 24 hours after they were read.
 *
 * Its own loop rather than a step in the push dispatcher: that one only starts
 * when the VAPID keys are set, and a deployment without push still needs its
 * bells emptied. It needs nothing but the service-role key.
 *
 * Running in more than one container is harmless — a delete of rows that are
 * already gone deletes nothing.
 *
 * Server only — see `importProtection` in vite.config.ts.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readCutoff } from "@/lib/notification-retention";

/** Hourly: a read notification lives at most 25 hours instead of 24. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

const RUNNING = Symbol.for("scheduling-pilot.notification-sweeper");

async function sweep(): Promise<void> {
  const { error, count } = await supabaseAdmin
    .from("notifications")
    .delete({ count: "exact" })
    .not("read_at", "is", null)
    .lt("read_at", readCutoff());
  if (error) {
    console.error("[notifications] sweep failed:", error.message);
    return;
  }
  if (count) console.info(`[notifications] cleared ${count} read more than a day ago`);
}

export function startNotificationSweeper(): void {
  const global = globalThis as Record<symbol, unknown>;
  if (global[RUNNING]) return;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_URL) {
    // The bell still clears each person's own on open; this only covers the
    // people who never open it.
    console.warn(
      "[notifications] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — read " +
        "notifications are only cleared when their owner opens the app.",
    );
    return;
  }
  global[RUNNING] = true;

  const run = () => void sweep().catch((e) => console.error("[notifications] sweep failed:", e));
  run();
  const timer = setInterval(run, SWEEP_EVERY_MS);
  // Never the reason the process stays up on shutdown.
  timer.unref?.();
}
