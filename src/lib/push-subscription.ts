/**
 * Registering a device for notifications that arrive with the app closed.
 *
 * Granting notification permission is only half of it. Permission lets a page
 * that is open draw a notification; it does nothing once the tab is gone. What
 * reaches a locked phone is a *push subscription* — an endpoint at Apple,
 * Google or Mozilla, plus the keys to encrypt to this device — handed to the
 * server so it can deliver without anybody being there.
 *
 * So the switch on Settings does both: asks the browser, then files the
 * subscription. The row in `push_subscriptions` is this device's "yes", and
 * deleting it is how a device takes that back.
 *
 * Everything here fails quietly. A phone that will not subscribe still gets the
 * in-app pop-ups it got before; nobody trying to clock in should meet an
 * exception thrown by the notification plumbing.
 */
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useNotificationPrefs } from "@/lib/notification-prefs";

/** Handed to the browser so the push service knows which app is sending. */
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

/**
 * The generated Supabase types predate this table and regenerating them needs a
 * linked CLI, so the client is widened at this one boundary — the same approach
 * the app already takes for `notification_prefs`.
 */
type LooseTable = {
  upsert: (
    values: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => PromiseLike<{ error: unknown }>;
  delete: () => { eq: (col: string, value: string) => PromiseLike<{ error: unknown }> };
};
const pushTable = () => supabase.from("push_subscriptions" as never) as unknown as LooseTable;

/** Can this browser take a push at all? iOS says no until the app is installed. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Whether this deployment has been given VAPID keys. Without them there is nothing to subscribe to. */
export function pushConfigured(): boolean {
  return typeof VAPID_PUBLIC_KEY === "string" && VAPID_PUBLIC_KEY.length > 0;
}

/** The VAPID key travels as base64url text; `subscribe()` wants the raw bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  // Backed by a plain ArrayBuffer rather than whatever `new Uint8Array(n)`
  // infers: `subscribe()` takes a BufferSource, which a SharedArrayBuffer-backed
  // view is not.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function encodeKey(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** Save this device's endpoint and keys against the signed-in account. */
async function store(sub: PushSubscription, userId: string): Promise<boolean> {
  const json = sub.toJSON();
  const { error } = await pushTable().upsert(
    {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? encodeKey(sub.getKey("p256dh")),
      auth: json.keys?.auth ?? encodeKey(sub.getKey("auth")),
      user_agent: navigator.userAgent.slice(0, 300),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );
  return !error;
}

/**
 * Subscribe this device and file it. Returns whether it worked.
 *
 * Called when the switch on Settings goes on, and again on every start-up while
 * it is on: a browser can retire a subscription on its own, and an endpoint
 * that is quietly dead looks exactly like one that works until a notification
 * fails to arrive.
 */
export async function subscribeToPush(userId: string): Promise<boolean> {
  if (!pushSupported() || !pushConfigured()) return false;
  if (Notification.permission !== "granted") return false;

  const reg = await registration();
  if (!reg) return false;

  const applicationServerKey = keyBytes(VAPID_PUBLIC_KEY!);
  let sub: PushSubscription | null = null;
  try {
    sub = await reg.pushManager.getSubscription();
    // A subscription made against a different VAPID key — an older deployment,
    // or keys that have been rotated — will never decrypt what we send, and
    // the push service rejects it rather than saying so. Start again.
    if (sub && !sameKey(sub, applicationServerKey)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({
      // Required by every browser: a push must result in something the person
      // can see. Ours always does.
      userVisibleOnly: true,
      applicationServerKey,
    });
  } catch {
    return false;
  }

  if (await store(sub, userId)) return true;

  // The row would not save. The usual cause is a shared device: the endpoint is
  // already filed against whoever signed in here last, and row-level security
  // will not let this account overwrite someone else's row. Dropping the
  // subscription and taking a fresh one gets a new endpoint, and the old row
  // dies on its own the first time the server tries it.
  try {
    await sub.unsubscribe();
    const replacement = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    return await store(replacement, userId);
  } catch {
    return false;
  }
}

/** Is this subscription built on the key we are sending with? */
function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const existing = sub.options?.applicationServerKey;
  if (!existing) return false;
  const bytes = new Uint8Array(existing as ArrayBuffer);
  if (bytes.length !== key.length) return false;
  return bytes.every((b, i) => b === key[i]);
}

/**
 * Is this device registered for delivery from the server?
 *
 * Asked before the page draws a notification of its own. Where the answer is
 * yes, the server is the one that speaks and the page keeps quiet — two things
 * announcing the same break is how you end up told twice, or told at the wrong
 * moment by whichever of them is the less reliable.
 */
export async function hasPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Take this device back off the list.
 *
 * Both halves matter: the browser stops accepting pushes, and the row goes so
 * the server stops addressing them. Either one alone leaves a notification
 * being sent into nothing, or a device still able to receive one nobody meant
 * to send.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const { endpoint } = sub;
    await sub.unsubscribe().catch(() => false);
    await pushTable().delete().eq("endpoint", endpoint);
  } catch {
    /* already gone, or a browser that will not say — either way, nothing to do */
  }
}

/**
 * Keep this device's registration current, for as long as the app is open.
 *
 * Mounted once in the authenticated layout. It exists because a subscription is
 * not a one-off: a browser can retire one after a long idle spell or a key
 * rotation, and the row is tied to an account, so signing in on a device that
 * already said yes has to re-file it under the new person. Re-subscribing is
 * cheap and idempotent — the browser hands back the subscription it already has
 * — so the safe thing is to do it on every start-up rather than guess.
 */
export function usePushRegistration(): void {
  const { user } = useAuth();
  const { prefs } = useNotificationPrefs();
  const wanted = !!user && prefs.desktop;

  useEffect(() => {
    if (!wanted || !user) return;
    void subscribeToPush(user.id);

    // The worker tells us when the browser has swapped the subscription out
    // from under it; it cannot write the new one itself, having no session.
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "push-subscription-changed") void subscribeToPush(user.id);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [wanted, user]);
}
