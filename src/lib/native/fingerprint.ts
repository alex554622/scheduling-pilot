import { registerPlugin } from "@capacitor/core";
import { nativePlatform } from "./platform";

/**
 * Fingerprint clock-in for the shared tablet (routes/clock.$token.tsx), and
 * registering fingerprints from the admin's Shared clock-in page.
 *
 * Android only. The USB fingerprint reader is driven by the separate Pilot
 * Clock app, which carries its driver; the app's own Fingerprint plugin
 * (android/…/FingerprintPlugin.java) opens its windows. A person is registered
 * under their user ID together with their 4-digit clock-in code, and a scan
 * hands that code back. The code then goes through the same
 * kiosk_* RPCs as a typed one, so nothing changes on the server and a scan can
 * do no more than typing the code could. Fingerprints never leave Pilot Clock.
 * Setup: docs/mobile/fingerprint-reader.md.
 */
type IdentifyReply = { ok: true; code: string; name?: string } | { ok: false; error: string };
type OkReply = { ok: boolean; error?: string };

/** What the tablet can do: Pilot Clock present, reader plugged in, who is registered. */
export type FingerprintStatus = {
  installed: boolean;
  readerAttached: boolean;
  /** User IDs with a fingerprint registered on this tablet. */
  enrolled: string[];
  error?: string;
};

const Fingerprint = registerPlugin<{
  isAvailable(): Promise<{ available: boolean }>;
  identify(options: { title?: string }): Promise<IdentifyReply>;
  status(): Promise<FingerprintStatus>;
  enroll(options: { userId: string; name: string; code: string }): Promise<OkReply>;
  remove(options: { userId: string }): Promise<OkReply>;
  updateCode(options: { userId: string; code: string }): Promise<OkReply>;
}>("Fingerprint");

const NO_FINGERPRINT: FingerprintStatus = { installed: false, readerAttached: false, enrolled: [] };

/**
 * Status for the admin's Shared clock-in page. Off the Android app, or
 * without Pilot Clock, everything is false and the page shows no fingerprint
 * controls at all.
 */
export async function fingerprintStatus(): Promise<FingerprintStatus> {
  if (nativePlatform() !== "android") return NO_FINGERPRINT;
  try {
    return await Fingerprint.status();
  } catch (e) {
    console.error("[fingerprint] status", e);
    return NO_FINGERPRINT;
  }
}

async function okCall(run: () => Promise<OkReply>): Promise<OkReply> {
  try {
    return await run();
  } catch (e) {
    console.error("[fingerprint]", e);
    return { ok: false, error: "The fingerprint app could not be opened." };
  }
}

/** Opens Pilot Clock's register window: the person scans the same finger 3 times. */
export function registerFingerprint(userId: string, name: string, code: string) {
  return okCall(() => Fingerprint.enroll({ userId, name, code }));
}

export function removeFingerprint(userId: string) {
  return okCall(() => Fingerprint.remove({ userId }));
}

/** Keeps a registered fingerprint pointing at the person's new clock-in code. */
export function updateFingerprintCode(userId: string, code: string) {
  return okCall(() => Fingerprint.updateCode({ userId, code }));
}

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
