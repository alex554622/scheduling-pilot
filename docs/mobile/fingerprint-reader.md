# Fingerprint clock-in on the shared tablet

The shared clock-in screen (`/clock/<token>`, `src/routes/clock.$token.tsx`) can take
a fingerprint instead of a typed 4-digit code, in the **Android app** only.

## How it works

The USB fingerprint reader is driven by a separate app, **Pilot Clock**
(`com.schedpilot.fingerprint`, its own project). Pilot Clock keeps the
fingerprints, encrypted, on the tablet. Each person is enrolled in it **under
their 4-digit clock-in code**.

1. The person taps **Use fingerprint** on the shared clock-in screen.
2. `src/lib/native/fingerprint.ts` calls the app's own `Fingerprint` plugin
   (`android/…/FingerprintPlugin.java`), which opens Pilot Clock's scan window
   (intent action `com.schedpilot.fingerprint.IDENTIFY`).
3. On a match Pilot Clock returns the code. The screen sets it as if it were typed,
   and the usual `kiosk_state` / `kiosk_punch` RPCs take over.

There are no server or database changes. A scan can do nothing that typing the code
couldn't, so the kiosk's security is unchanged. The token still authenticates the
device, the code still identifies the person, and the 5-wrong-codes lockout still
applies. No fingerprint data reaches this app or Supabase.

The button only shows when Pilot Clock is installed (`isAvailable`). The keypad is
always there as a fallback.

## Tablet setup

1. Use a SecuGen USB reader (e.g. Hamster Pro 20) on a USB-OTG adapter. Windows Hello-only
   readers such as the WA28 do not work on Android.
2. Install Pilot Clock (built with the SecuGen SDK) and the Scheduling Pilot app.
3. Plug in the reader and allow USB access (tick **Always**).
4. In Pilot Clock: **Manager** → create a PIN → **Add employee**. Enter the person's
   **4-digit clock-in code** from the Employees page, plus their name, then scan the
   same finger 3 times.
5. Open the shared clock-in link in the Scheduling Pilot app. **Use fingerprint**
   appears above the keypad.

**If an admin issues someone a new clock-in code, enroll them again in Pilot Clock**
with the new code. Until then their fingerprint is answered with "That code was not
recognised", and a few of those trip the device's 1-minute lockout.
