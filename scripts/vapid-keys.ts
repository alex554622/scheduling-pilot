/**
 * Make a VAPID keypair. Run with `bun run vapid:keys`.
 *
 * One pair per deployment, generated once and kept. They are what identify this
 * app to Apple's, Google's and Mozilla's push services; rotating them silently
 * invalidates every device already subscribed, which then has to be re-asked.
 *
 * The public half is safe in the browser bundle — it has to be, the browser
 * subscribes with it. The private half signs the delivery requests and belongs
 * only in the server's environment.
 */
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const priv = privateKey.export({ format: "jwk" }) as { d: string };

// VAPID wants the public key as the uncompressed point — 0x04, then x, then y.
const uncompressed = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]).toString("base64url");

console.log(`
Add these to .env (and to the app's environment on the server):

  # The browser subscribes with this; it ships in the client bundle by design.
  VITE_VAPID_PUBLIC_KEY="${uncompressed}"
  VAPID_PUBLIC_KEY="${uncompressed}"

  # Server only. Signs every delivery. Never give this a VITE_ prefix.
  VAPID_PRIVATE_KEY="${priv.d}"

  # Where a push service should complain if this app misbehaves.
  VAPID_SUBJECT="mailto:support@schedulingpilot.com"

Generate these once. Changing them unsubscribes every device that has already
said yes, and each has to be asked again.
`);
