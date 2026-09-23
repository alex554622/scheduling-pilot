/**
 * Checks for the hand-rolled Web Push crypto. Run with `bun run test:push`.
 *
 * This is the one part of the notification path that cannot be checked by
 * looking at it: a push service does not say "your ciphertext is wrong", it
 * says 201 and the phone stays quiet. So this plays the part of the device —
 * it generates a subscription keypair, has `encryptPayload` encrypt to it, and
 * decrypts the result the way a browser would (RFC 8291). If the derivation is
 * off by a byte, the AES tag fails and this test says so.
 *
 * The VAPID half is checked the way a push service checks it: parse the
 * Authorization header, verify the signature against the public key.
 */
import crypto from "node:crypto";
import { encryptPayload, vapidAuthorization } from "../src/lib/server/web-push";

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
function ok(name: string, condition: boolean) {
  eq(name, condition, true);
}

/** The same one-block HKDF the sender uses, written out again so a bug there shows here. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  return crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}
const info = (label: string) => Buffer.concat([Buffer.from(label, "utf8"), Buffer.from([0])]);

/* ------------------------------------------------------- a pretend subscriber */

const device = crypto.createECDH("prime256v1");
const devicePublic = device.generateKeys();
const deviceAuth = crypto.randomBytes(16);
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: devicePublic.toString("base64url"),
  auth: deviceAuth.toString("base64url"),
};

/** Everything a browser does on receipt, in the order it does it. */
function decrypt(body: Buffer): string {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + keyLength);
  const sealed = body.subarray(21 + keyLength);

  eq("record size is the standard 4096", recordSize, 4096);
  eq("the sender's key is an uncompressed P-256 point", keyLength, 65);
  eq("…and is flagged as one", senderPublic[0], 4);

  const shared = device.computeSecret(senderPublic);
  const ikm = hkdf(
    deviceAuth,
    shared,
    Buffer.concat([info("WebPush: info"), devicePublic, senderPublic]),
    32,
  );
  const cek = hkdf(salt, ikm, info("Content-Encoding: aes128gcm"), 16);
  const nonce = hkdf(salt, ikm, info("Content-Encoding: nonce"), 12);

  const tag = sealed.subarray(sealed.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);

  eq("the record ends with the last-record delimiter", plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

console.log("a break reminder encrypted to one device");
const payload = JSON.stringify({
  title: "Break almost over",
  body: "Two minutes left on your 30-minute break.",
  link: "/timeclock",
  tag: "break-7f3c",
});
const sealed = encryptPayload(payload, subscription);
eq("the device reads back exactly what was sent", decrypt(sealed), payload);

console.log("");
console.log("two notifications to the same device share nothing");
const a = encryptPayload(payload, subscription);
const b = encryptPayload(payload, subscription);
ok("different salts", !a.subarray(0, 16).equals(b.subarray(0, 16)));
ok("different ephemeral keys", !a.subarray(21, 86).equals(b.subarray(21, 86)));
ok("so identical payloads produce different ciphertext", !a.equals(b));
eq("and both still decrypt", decrypt(b), payload);

console.log("");
console.log("a payload with an accented body survives the round trip");
const accented = JSON.stringify({
  title: "Réunion",
  body: "C'est l'heure — à bientôt.",
  link: "/",
});
eq("read back unchanged", decrypt(encryptPayload(accented, subscription)), accented);

/* --------------------------------------------------------------------- VAPID */

console.log("");
console.log("the VAPID token a push service would check");

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubJwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };
const privJwk = pair.privateKey.export({ format: "jwk" }) as { d: string };
const vapidPublic = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(pubJwk.x, "base64url"),
  Buffer.from(pubJwk.y, "base64url"),
]).toString("base64url");

const header = vapidAuthorization(subscription.endpoint, {
  publicKey: vapidPublic,
  privateKey: privJwk.d,
  subject: "mailto:support@schedulingpilot.com",
});

const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
ok("the header is shaped the way RFC 8292 asks", !!match);

const [jwt, sentKey] = match ? [match[1], match[2]] : ["", ""];
eq("it carries the public key the subscription was made with", sentKey, vapidPublic);

const [h, p, s] = jwt.split(".");
const decodedHeader = JSON.parse(Buffer.from(h, "base64url").toString());
const claims = JSON.parse(Buffer.from(p, "base64url").toString());
eq("signed with ES256", decodedHeader.alg, "ES256");
eq(
  "audience is the push service's origin, not the endpoint",
  claims.aud,
  "https://fcm.googleapis.com",
);
eq("and carries the contact address", claims.sub, "mailto:support@schedulingpilot.com");
const hours = (claims.exp - Math.floor(Date.now() / 1000)) / 3600;
ok("expiry is inside the 24-hour limit", hours > 0 && hours <= 24);

// The signature has to be the raw r||s pair; the DER encoding Node produces by
// default is 70-odd bytes and every push service rejects it.
eq("signature is 64 raw bytes", Buffer.from(s, "base64url").length, 64);
ok(
  "and verifies against the public key",
  crypto.verify(
    "sha256",
    Buffer.from(`${h}.${p}`, "utf8"),
    { key: pair.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url"),
  ),
);

// A token minted for one push service must not be replayable at another.
const other = vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/xyz", {
  publicKey: vapidPublic,
  privateKey: privJwk.d,
  subject: "mailto:support@schedulingpilot.com",
});
const otherClaims = JSON.parse(Buffer.from(other.split(".")[1], "base64url").toString());
eq(
  "a second service gets its own audience",
  otherClaims.aud,
  "https://updates.push.services.mozilla.com",
);

console.log("");
console.log(
  failures === 0 ? "\nAll web push checks passed.\n" : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
