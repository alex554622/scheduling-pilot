/**
 * Checks for the FCM and APNs senders. Run with `bun run test:native-push`.
 *
 * Like web push, both services answer a badly signed token with a bare 401/403
 * and a phone that stays quiet. So the JWTs are verified here the way Google
 * and Apple verify them — against the public half of a throwaway key — and the
 * message bodies are checked for the fields the app reads when tapped.
 */
import crypto from "node:crypto";
import {
  apnsBody,
  apnsJwt,
  fcmAssertion,
  fcmMessage,
  fcmTokenIsGone,
  readSecret,
} from "../src/lib/server/native-push";

let failures = 0;
function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} — got ${a}, expected ${e}`);
  }
}
const ok = (name: string, condition: boolean) => eq(name, condition, true);

const part = (jwt: string, i: number) =>
  JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString("utf8"));

const payload = {
  title: "Break almost over",
  body: "Two minutes left on your 15-minute break.",
  link: "/timeclock",
  tag: "break-123",
  type: "break_ending",
};

/* ------------------------------------------------------------------- secrets */

console.log("readSecret");
const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
eq("as-is", readSecret(pem), pem);
eq("escaped newlines", readSecret(pem.replace(/\n/g, "\\n")), pem);
eq("base64", readSecret(Buffer.from(pem).toString("base64")), pem);
eq("json base64", readSecret(Buffer.from('{"a":1}').toString("base64")), '{"a":1}');

/* ----------------------------------------------------------------------- FCM */

console.log("FCM");
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const fcm = {
  projectId: "scheduling-pilot",
  clientEmail: "push@scheduling-pilot.iam.gserviceaccount.com",
  privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const assertion = fcmAssertion(fcm, 1_700_000_000);
const [h, c, sig] = assertion.split(".");
ok(
  "assertion verifies with the service account's public key",
  crypto.verify("sha256", Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(sig, "base64url")),
);
eq("assertion header", part(assertion, 0), { alg: "RS256", typ: "JWT" });
eq("assertion claims", part(assertion, 1), {
  iss: fcm.clientEmail,
  scope: "https://www.googleapis.com/auth/firebase.messaging",
  aud: "https://oauth2.googleapis.com/token",
  iat: 1_700_000_000,
  exp: 1_700_003_600,
});

const msg = fcmMessage("device-token", payload, 180).message;
eq("token", msg.token, "device-token");
eq("notification", msg.notification, { title: payload.title, body: payload.body });
eq("tap data", msg.data, { link: "/timeclock", tag: "break-123", type: "break_ending" });
eq("break goes to the break channel", msg.android.notification.channel_id, "break");
eq("ttl", msg.android.ttl, "180s");
eq("priority", msg.android.priority, "HIGH");
eq(
  "anything else goes to alerts",
  fcmMessage("t", { ...payload, type: "schedule_changed" }, 60).message.android.notification
    .channel_id,
  "alerts",
);
const approved = fcmMessage("t", { ...payload, alertSound: true }, 180).message.android
  .notification as Record<string, unknown>;
eq("approved break goes to the recorded-alert channel", approved.channel_id, "break_alert");
eq("approved break names the sound for Android 7", approved.sound, "break_alert");
eq(
  "the flag does nothing for anything but a break",
  fcmMessage("t", { ...payload, type: "schedule_changed", alertSound: true }, 60).message.android
    .notification.channel_id,
  "alerts",
);

ok("404 is gone", fcmTokenIsGone(404, ""));
ok("UNREGISTERED is gone", fcmTokenIsGone(400, '{"errorCode":"UNREGISTERED"}'));
ok(
  "invalid token is gone",
  fcmTokenIsGone(400, "The registration token is not a valid FCM registration token"),
);
ok("a 400 about our payload is not", !fcmTokenIsGone(400, "Invalid JSON payload received."));
ok("a 500 is not", !fcmTokenIsGone(500, "internal"));

/* ---------------------------------------------------------------------- APNs */

console.log("APNs");
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const apns = {
  keyId: "ABC123DEFG",
  teamId: "TEAM123456",
  privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  bundleId: "com.schedulingpilot.app",
  production: true,
};
const jwt = apnsJwt(apns, 1_700_000_000);
const [ah, ac, asig] = jwt.split(".");
ok(
  "provider token verifies with the key's public half (raw r||s)",
  crypto.verify(
    "sha256",
    Buffer.from(`${ah}.${ac}`),
    { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(asig, "base64url"),
  ),
);
eq("signature is 64 bytes, not DER", Buffer.from(asig, "base64url").length, 64);
eq("provider token header", part(jwt, 0), { alg: "ES256", kid: "ABC123DEFG" });
eq("provider token claims", part(jwt, 1), { iss: "TEAM123456", iat: 1_700_000_000 });

const body = apnsBody(payload);
eq("alert", body.aps.alert, { title: payload.title, body: payload.body });
eq("break is time-sensitive", body.aps["interruption-level"], "time-sensitive");
eq(
  "others are active",
  apnsBody({ ...payload, type: "announcement" }).aps["interruption-level"],
  "active",
);
eq("tap data", [body.link, body.tag, body.type], ["/timeclock", "break-123", "break_ending"]);

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall native push checks passed");
