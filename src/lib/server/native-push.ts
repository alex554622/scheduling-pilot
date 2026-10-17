/**
 * Push to the Android and iOS apps.
 *
 * The apps' web view has no Push API, so instead of a Web Push endpoint each
 * phone hands us one token from its platform's own push service (see
 * `push_devices` and src/lib/native/push.ts):
 *
 *   * Android — a Firebase Cloud Messaging registration token, sent through
 *     the FCM HTTP v1 API with an OAuth token minted from a service account.
 *   * iOS — an APNs device token, sent straight to Apple over HTTP/2 with a
 *     token-signing (.p8) key. The Capacitor plugin hands iOS apps the raw
 *     APNs token, so going direct means no Firebase SDK in the iOS project.
 *
 * Both are two signed JWTs and an HTTPS request, and Node has all of it built
 * in — the same reasoning as web-push.ts doing VAPID by hand rather than
 * pulling in firebase-admin and its dependency tree.
 *
 * Every credential here is a server-only environment variable. None of it may
 * ever be a VITE_* variable: those are compiled into the app bundle.
 *
 * Server only — see `importProtection` in vite.config.ts.
 */
import crypto from "node:crypto";
import http2 from "node:http2";
import type { PushResult } from "@/lib/server/web-push";

/** What the dispatcher hands over: the queue row, already shaped. */
export interface NativePayload {
  title: string;
  body: string;
  link: string;
  tag: string;
  type: string;
}

/* ------------------------------------------------------------------- helpers */

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/**
 * A credential pasted into an environment variable arrives in one of three
 * shapes: as-is, base64 of the file (what survives a single-line env field),
 * or with its newlines escaped as `\n`. All three are accepted.
 */
export function readSecret(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("-----")) return trimmed.replace(/\\n/g, "\n");
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (decoded.startsWith("{") || decoded.startsWith("-----")) return decoded;
  return trimmed.replace(/\\n/g, "\n");
}

/** Notification kinds that are an alarm rather than a message. */
const isAlarm = (type: string) => type === "break_ending";

/* ------------------------------------------------------------------------ FCM */

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Android notification channels. Created by the app (src/lib/native/push.ts). */
export const ANDROID_CHANNELS = { alerts: "alerts", break: "break" } as const;

/**
 * The service account, from `FCM_SERVICE_ACCOUNT`: the JSON file Firebase
 * downloads, pasted whole or base64-encoded. Null when not set or unreadable.
 */
export function fcmConfigFromEnv(): FcmConfig | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const json = JSON.parse(readSecret(raw)) as Record<string, string>;
    if (!json.project_id || !json.client_email || !json.private_key) return null;
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: json.private_key.replace(/\\n/g, "\n"),
    };
  } catch {
    console.error("[push] FCM_SERVICE_ACCOUNT is set but is not a service-account JSON file");
    return null;
  }
}

/** The signed assertion Google trades for an access token (RFC 7523). */
export function fcmAssertion(
  config: FcmConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 60 * 60,
    }),
  );
  const input = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(input), config.privateKey);
  return `${input}.${b64url(signature)}`;
}

let fcmToken: { value: string; expires: number; for: string } | null = null;

/** An OAuth access token for FCM, cached until five minutes before it expires. */
async function fcmAccessToken(config: FcmConfig): Promise<string> {
  if (fcmToken && fcmToken.for === config.clientEmail && fcmToken.expires > Date.now()) {
    return fcmToken.value;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: fcmAssertion(config),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`FCM sign-in failed: ${res.status} ${json.error_description ?? ""}`.trim());
  }
  fcmToken = {
    value: json.access_token,
    expires: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000,
    for: config.clientEmail,
  };
  return fcmToken.value;
}

/** The FCM v1 message body for one device. Exported for the tests. */
export function fcmMessage(token: string, payload: NativePayload, ttlSeconds: number) {
  const alarm = isAlarm(payload.type);
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      // Read by the app when the notification is tapped (pushNotificationActionPerformed).
      data: { link: payload.link, tag: payload.tag, type: payload.type },
      android: {
        // High priority is what wakes a phone in Doze. FCM allows it for
        // messages that show a notification, which every one of these does.
        priority: "HIGH",
        ttl: `${ttlSeconds}s`,
        notification: {
          channel_id: alarm ? ANDROID_CHANNELS.break : ANDROID_CHANNELS.alerts,
          // Same tag as the bell and the website use: a later one for the same
          // event replaces the earlier instead of stacking.
          tag: payload.tag,
          default_sound: true,
          default_vibrate_timings: true,
          notification_priority: alarm ? "PRIORITY_MAX" : "PRIORITY_HIGH",
          visibility: "PRIVATE",
        },
      },
    },
  };
}

/**
 * FCM's way of saying the token is dead: 404 UNREGISTERED (app uninstalled,
 * token rotated), or 400 INVALID_ARGUMENT naming the token. A 400 about
 * anything else is our own bug and must not delete anybody's phone.
 */
export function fcmTokenIsGone(status: number, text: string): boolean {
  if (status === 404) return true;
  if (/UNREGISTERED/.test(text)) return true;
  return status === 400 && /registration token/i.test(text);
}

export async function sendFcm(
  config: FcmConfig,
  token: string,
  payload: NativePayload,
  ttlSeconds: number,
): Promise<PushResult> {
  let access: string;
  try {
    access = await fcmAccessToken(config);
  } catch (e) {
    return { ok: false, gone: false, status: 0, error: String(e).slice(0, 500) };
  }
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify(fcmMessage(token, payload, ttlSeconds)),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    // A revoked or expired access token: drop it so the next send signs in again.
    if (res.status === 401) fcmToken = null;
    return {
      ok: false,
      gone: fcmTokenIsGone(res.status, text),
      status: res.status,
      error: `FCM ${res.status} ${text}`.trim().slice(0, 500),
    };
  } catch (e) {
    return { ok: false, gone: false, status: 0, error: String(e).slice(0, 500) };
  }
}

/* ----------------------------------------------------------------------- APNs */

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 file's contents (PEM). */
  privateKey: string;
  bundleId: string;
  /** Which of Apple's two servers to try first. */
  production: boolean;
}

/**
 * From `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (the .p8 file, pasted
 * or base64), `APNS_BUNDLE_ID` (default com.schedulingpilot.app) and
 * `APNS_ENV` (`production`, the default, or `sandbox`).
 */
export function apnsConfigFromEnv(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const rawKey = process.env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !rawKey) return null;
  const privateKey = readSecret(rawKey);
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    console.error("[push] APNS_PRIVATE_KEY is set but is not a readable .p8 key");
    return null;
  }
  return {
    keyId,
    teamId,
    privateKey,
    bundleId: process.env.APNS_BUNDLE_ID || "com.schedulingpilot.app",
    production: (process.env.APNS_ENV || "production").toLowerCase() !== "sandbox",
  };
}

/** The provider token: ES256, `kid` = key ID, `iss` = team ID. */
export function apnsJwt(config: ApnsConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const input = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(input), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(signature)}`;
}

// Apple wants the same provider token reused for between 20 and 60 minutes:
// re-signing per request gets TooManyProviderTokenUpdates.
let apnsToken: { value: string; minted: number; for: string } | null = null;
function currentApnsJwt(config: ApnsConfig): string {
  const id = `${config.teamId}/${config.keyId}`;
  if (apnsToken && apnsToken.for === id && Date.now() - apnsToken.minted < 40 * 60_000) {
    return apnsToken.value;
  }
  apnsToken = { value: apnsJwt(config), minted: Date.now(), for: id };
  return apnsToken.value;
}

/** The APNs JSON body. Exported for the tests. */
export function apnsBody(payload: NativePayload) {
  const alarm = isAlarm(payload.type);
  return {
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      "thread-id": payload.type,
      // Breaks through a Focus mode when the app has the Time Sensitive
      // Notifications capability; treated as an ordinary alert when it doesn't.
      "interruption-level": alarm ? "time-sensitive" : "active",
    },
    // Read by the app when the notification is tapped.
    link: payload.link,
    tag: payload.tag,
    type: payload.type,
  };
}

const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

const sessions = new Map<string, http2.ClientHttp2Session>();
function apnsSession(origin: string): http2.ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(origin);
  // One idle connection kept open; Apple closes it after a while anyway.
  session.setTimeout(10 * 60_000, () => session.close());
  const forget = () => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };
  session.on("close", forget);
  session.on("error", forget);
  session.unref();
  sessions.set(origin, session);
  return session;
}

function apnsRequest(
  origin: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; reason: string }> {
  return new Promise((resolve) => {
    let session: http2.ClientHttp2Session;
    try {
      session = apnsSession(origin);
    } catch (e) {
      resolve({ status: 0, reason: String(e) });
      return;
    }
    const req = session.request({ ":method": "POST", ...headers });
    let status = 0;
    let data = "";
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      resolve({ status: 0, reason: "timeout" });
    }, 15_000);
    req.setEncoding("utf8");
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => {
      clearTimeout(timer);
      let reason = "";
      try {
        reason = (JSON.parse(data) as { reason?: string }).reason ?? "";
      } catch {
        reason = data;
      }
      resolve({ status, reason });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: 0, reason: String(e) });
    });
    req.end(body);
  });
}

/**
 * Hand one notification to Apple for one iPhone.
 *
 * A build run from Xcode gets a token from Apple's sandbox; TestFlight and the
 * App Store get production ones, and each server rejects the other's as
 * BadDeviceToken. So a BadDeviceToken is tried once on the other server before
 * the device is given up on — one deployment then serves both.
 */
export async function sendApns(
  config: ApnsConfig,
  token: string,
  payload: NativePayload,
  ttlSeconds: number,
): Promise<PushResult> {
  const headers: Record<string, string> = {
    ":path": `/3/device/${token}`,
    authorization: `bearer ${currentApnsJwt(config)}`,
    "apns-topic": config.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + ttlSeconds),
    "content-type": "application/json",
  };
  // Same tag as everywhere else: a newer one for the same event replaces it.
  if (Buffer.byteLength(payload.tag) <= 64) headers["apns-collapse-id"] = payload.tag;
  const body = JSON.stringify(apnsBody(payload));

  const order = config.production
    ? [APNS_HOSTS.production, APNS_HOSTS.sandbox]
    : [APNS_HOSTS.sandbox, APNS_HOSTS.production];

  let last = { status: 0, reason: "" };
  for (const origin of order) {
    last = await apnsRequest(origin, headers, body);
    if (last.status === 200) return { ok: true };
    if (!(last.status === 400 && last.reason === "BadDeviceToken")) break;
  }
  if (last.status === 403 && last.reason === "ExpiredProviderToken") apnsToken = null;
  const gone =
    last.status === 410 ||
    (last.status === 400 && last.reason === "BadDeviceToken") ||
    last.reason === "Unregistered";
  return {
    ok: false,
    gone,
    status: last.status,
    error: `APNs ${last.status} ${last.reason}`.trim().slice(0, 500),
  };
}
