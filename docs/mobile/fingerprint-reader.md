# Fingerprint clock-in on the shared tablet

In the **Android app**, the shared clock-in screen (`/clock/<token>`) can take a
fingerprint instead of a typed 4-digit code. Admins register each person's
fingerprint from **Shared clock-in → Employee codes**.

## What is installed on the tablet

| App | What it does |
|---|---|
| **Scheduling Pilot** | Everything people see: registering fingerprints, the shared clock-in screen |
| **Pilot Clock** (`com.schedpilot.fingerprint`, its own project) | The fingerprint reader's driver (SecuGen SDK). Stores the fingerprints, encrypted, on the tablet |

Both are installed from APK files (e.g. over USB). Pilot Clock carries the SecuGen
SDK, which has its own license, so the SDK stays out of this repository.

## How it works

- **Register** (admin, signed in on the tablet): the Shared clock-in page asks Pilot
  Clock for its status (`status`): installed, reader plugged in, and who is registered.
  When a reader is connected, each person who has a code gets **Register fingerprint**.
  That opens Pilot Clock's window, where the person scans the same finger 3 times
  (`enroll`). They're stored under their user ID together with their current code.
  The same finger can't be registered to two people.
- **Clock in** (anyone, on `/clock/<token>`): **Use fingerprint** opens Pilot Clock's
  scan window (`identify`). On a match it hands back the person's code, the screen
  sets it as if it were typed, and the usual `kiosk_state` / `kiosk_punch` RPCs take over.
- **New code / remove code**: issuing a new code moves a registered fingerprint to the
  new code (`updateCode`). Removing a code also removes the fingerprint.

Code: `src/lib/native/fingerprint.ts` → `android/…/FingerprintPlugin.java` → Pilot
Clock's `IdentifyActivity`, `EnrollActivity`, `ApiActivity`.

There are no server or database changes. A scan can't do anything typing the code
couldn't, so the kiosk's security model is unchanged: the token authenticates the
device, the code identifies the person, and the wrong-code lockout still applies.
Pilot Clock only answers calls from `com.schedulingpilot.app`, so other apps on the
tablet can't register fingers or read codes. No fingerprint data reaches this app or
Supabase. The keypad always stays as a fallback.

## Tablet setup

1. Plug a SecuGen USB reader (e.g. Hamster Pro 20) in with a USB-OTG adapter. Readers that
   only work with Windows Hello (such as the WA28) don't work on Android.
2. Install **Pilot Clock** (built with the SecuGen SDK), then **Scheduling Pilot**.
3. When Android asks whether Pilot Clock may use the reader, tick **Always** and allow it.
4. In Scheduling Pilot, sign in as a company admin → **Shared clock-in**. Give each
   person a code if they don't have one, then tap **Register fingerprint** next to their
   name and have them scan the same finger 3 times.
5. Open the device link on the tablet (Devices, above) and leave it open.
   **Use fingerprint** appears above the keypad.

Fingerprints are stored on the tablet they were registered on. A second tablet needs
its own registration.
