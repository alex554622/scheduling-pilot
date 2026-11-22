import { registerPlugin } from "@capacitor/core";
import { nativePlatform } from "./platform";

/**
 * Fingerprint clock-in for the shared tablet (routes/clock.$token.tsx).
 *
 * Android only. The USB fingerprint reader is driven by the separate Pilot
 * Clock app; the app's own Fingerprint plugin (android/…/FingerprintPlugin.java)
 * opens its scan window and gets back the person's 4-digit clock-in code, which
 * is what they are enrolled under there. The code then goes through the same
 * kiosk_* RPCs as a typed one, so nothing changes on the server and a scan can
 * do no more than typing the code could. Fingerprints never leave Pilot Clock.
 * Setup: docs/mobile/fingerprint-reader.md.
 */
type IdentifyReply = { ok: true; code: string; name?: string } | { ok: false; error: string };

const Fingerprint = registerPlugin<{
  isAvailable(): Promise<{ available: boolean }>;
  identify(options: { title?: string }): Promise<IdentifyReply>;
}>("Fingerprint");

/** True on the Android app when Pilot Clock is installed on the device. */
export async function fingerprintAvailable(): Promise<boolean> {
  if (nativePlatform() !== "android") return false;
  try {
    return (await Fingerprint.isAvailable()).available;
  } catch {
    return false;
  }
}

/**
 * Asks for a scan. Resolves to the 4-digit code on a match, or to an error
 * (already in words for the person at the tablet, from Pilot Clock) otherwise.
 * `cancelled` is set when the person backed out, so the caller can stay quiet.
 */
export async function scanFingerprint(
  title?: string,
): Promise<{ code: string } | { error: string; cancelled: boolean }> {
  try {
    const reply = await Fingerprint.identify({ title });
    if (reply.ok && /^[0-9]{4}$/.test(reply.code)) return { code: reply.code };
    if (reply.ok) {
      // Enrolled in Pilot Clock under something other than a 4-digit code.
      return { error: "This fingerprint is not linked to a clock-in code.", cancelled: false };
    }
    return { error: reply.error, cancelled: reply.error === "Cancelled" };
  } catch (e) {
    console.error("[fingerprint]", e);
    return { error: "The fingerprint app could not be opened.", cancelled: false };
  }
}
