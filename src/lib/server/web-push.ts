/**
 * Web Push, by hand.
 *
 * A push service will not take a plain HTTP POST: the payload has to be
 * encrypted to the *device's* key (RFC 8291, `aes128gcm`) so that Apple,
 * Google or Mozilla relay something they cannot read, and the request has to
 * carry a signed VAPID token (RFC 8292) proving it came from this app.
 *
 * That is two well-specified paragraphs of crypto, and Node has every piece of
 * it — ECDH on P-256, HKDF via HMAC, AES-128-GCM, ES256 signing — so this does
 * it directly rather than adding `web-push` and its dependency tree. The same
 * reasoning as `notify-sound.ts` synthesising the chime instead of shipping an
 * audio file.
 *
 * Server only. Living under `lib/server/` means the build fails rather than
 * ships if a browser bundle ever reaches for it — see `importProtection` in
 * vite.config.ts.
 */
import crypto from "node:crypto";

export interface PushSubscriptionRecord {
  endpoint: string;
  /** The device's public key, base64url, uncompressed P-256 (65 bytes). */
  p256dh: string;
  /** The device's auth secret, base64url (16 bytes). */
  auth: string;
}

export interface VapidKeys {
  /** base64url, uncompressed P-256 public key — the same value the browser subscribes with. */
  publicKey: string;
  /** base64url, the 32-byte private scalar. */
  privateKey: string;
  /** `mailto:` or `https:` — who a push service should complain to. */
  subject: string;
}

export type PushResult =
  | { ok: true }
  /** The subscription is dead; the caller should forget the device. */
  | { ok: false; gone: true; status: number; error: string }
  | { ok: false; gone: false; status: number; error: string };

/* ------------------------------------------------------------------ base64url */

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/* ----------------------------------------------------------------------- HKDF */

/**
 * One-block HKDF — extract, then a single expand round.
 *
 * Every derivation web push asks for is 32 bytes or fewer, so the counter never
 * passes 0x01 and the loop a general implementation needs is not one.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const okm = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  return okm.subarray(0, length);
}

/** `label` || 0x00, the shape every info string in RFC 8188/8291 takes. */
function info(label: string): Buffer {
  return Buffer.concat([Buffer.from(label, "utf8"), Buffer.from([0])]);
}

/* ------------------------------------------------------------------ encryption */

/**
 * Encrypt one payload for one device, returning the whole `aes128gcm` body:
 * a 21-byte header, this message's ephemeral public key, then the ciphertext.
 *
 * The shared secret comes from a keypair generated per message, so two
 * notifications to the same phone share nothing.
 */
export function encryptPayload(payload: string, sub: PushSubscriptionRecord): Buffer {
  const uaPublic = unb64url(sub.p256dh);
  const authSecret = unb64url(sub.auth);

  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // The device's auth secret is the salt here — it is what ties the key to a
  // subscription rather than to whoever happens to know the public key.
  const ikm = hkdf(
    authSecret,
    sharedSecret,
    Buffer.concat([info("WebPush: info"), uaPublic, asPublic]),
    32,
  );

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, info("Content-Encoding: aes128gcm"), 16);
  const nonce = hkdf(salt, ikm, info("Content-Encoding: nonce"), 12);

  // 0x02 is the "this is the last record" delimiter. One record is all we send:
  // the payloads here are a title and a sentence, nowhere near the 4096-byte
  // record size below.
  const plaintext = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, ciphertext]);
}

/* ----------------------------------------------------------------------- VAPID */

// Importing the key is the expensive half of signing and the key never changes,
// so it is done once per process rather than once per notification.
const keyCache = new Map<string, crypto.KeyObject>();

/**
 * Turn the stored 32-byte private scalar into something Node will sign with.
 *
 * VAPID keys are distributed raw, but `crypto.sign` wants a key object — so the
 * public half is recomputed from the scalar and the pair handed over as a JWK.
 */
function privateKeyObject(rawPrivate: string): crypto.KeyObject {
  const cached = keyCache.get(rawPrivate);
  if (cached) return cached;

  const d = unb64url(rawPrivate);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const key = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64url(d),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
  keyCache.set(rawPrivate, key);
  return key;
}

/**
 * The `Authorization` header: a JWT saying "this app, for this push service,
 * for the next few hours", signed with the VAPID private key.
 *
 * The audience is the push service's origin, not the endpoint — a token minted
 * for Apple must not be replayable at Google.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys): string {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        aud,
        // Twelve hours. The spec caps this at twenty-four, and a shorter life
        // costs nothing when a fresh token is signed per send.
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${body}`;
  // `ieee-p1363` gives the raw r||s pair JWS wants; the default DER encoding is
  // rejected by every push service.
  const signature = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKeyObject(keys.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

/* ------------------------------------------------------------------- delivery */

/** A push service saying the device is gone for good, rather than busy or broken. */
function isGone(status: number): boolean {
  return status === 404 || status === 410;
}

/**
 * Hand one notification to one device's push service.
 *
 * Never throws: a phone that has been wiped, a service having a bad afternoon
 * and a misconfigured key all come back as a result the caller can record,
 * because the alternative is one dead subscription stopping a whole batch.
 */
export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: unknown,
  keys: VapidKeys,
  /** How long the service should hold it for a phone that is off. */
  ttlSeconds = 60 * 60,
): Promise<PushResult> {
  let body: Buffer;
  try {
    body = encryptPayload(JSON.stringify(payload), sub);
  } catch (e) {
    // Key material that will not parse is not going to start working. Treated
    // as gone so the row is cleared rather than retried five times.
    return { ok: false, gone: true, status: 0, error: `bad subscription: ${String(e)}` };
  }

  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        // Wake the phone rather than let it batch this with the morning's mail.
        Urgency: "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      gone: isGone(res.status),
      status: res.status,
      error: `${res.status} ${res.statusText} ${text}`.trim().slice(0, 500),
    };
  } catch (e) {
    // Network trouble — worth another go later, so not `gone`.
    return { ok: false, gone: false, status: 0, error: String(e).slice(0, 500) };
  }
}

/**
 * The keys, or null if this deployment has not been given any.
 *
 * Null is not an error: a stack without VAPID keys still runs, still shows
 * notifications in an open tab, and simply does not deliver to closed ones.
 */
export function vapidKeysFromEnv(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || "mailto:support@schedulingpilot.com",
  };
}
