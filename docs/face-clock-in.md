# Face clock-in on the shared clock-in

The shared clock-in screen (`/clock/<token>`) identifies people by their face.
Face is the default. The 4-digit PIN is the second option: there is a
**Use PIN instead** button, and the keypad shows on its own if face can't be
used. This replaces the fingerprint reader, which never reached `main`.

## Applying it

1. Open Studio at supabase.schedulingpilot.com and go to **SQL editor**.
2. Paste the whole of `supabase/migrations/20261129120000_face_clock_in.sql`
   and run it. It must run after `20261128120000_team_rules.sql`. You can run
   it again safely.
3. Redeploy in Coolify.
4. Android/iOS app: rebuild. The app now asks for the camera
   (`CAMERA` in `AndroidManifest.xml`, `NSCameraUsageDescription` in
   `Info.plist`). In a plain browser on the tablet nothing extra is needed:
   the site is HTTPS and the browser asks for the camera once.

Don't use the `supabase` CLI or MCP for this. They point at the old project.

## Why face-api.js (`@vladmandic/face-api`)

- **It recognises who someone is.** It produces a 128-number face descriptor
  (a ResNet-34 face embedding). MediaPipe Face Detection and Face Landmarker
  only find faces and landmarks. They can't tell two people apart, so they'd
  need a second model anyway.
- **It runs on the tablet, in the browser or Capacitor WebView.** It uses
  TensorFlow.js on WebGL. There's no native plugin, no extra app and no
  vendor SDK licence, which the fingerprint approach needed. The same code
  works in Chrome on a tablet and in the Android/iOS app.
- **Small enough.** The models are about 7 MB, served from `public/models/face`.
  The library is a separate 340 KB (gzipped) chunk. Both load only on the
  clock-in screen and in the enrollment dialog.
- **Fast enough.** About 35 ms per frame on a laptop with WebGL. Tablets are
  slower but still fine for a few frames per second.
- `@vladmandic/face-api` is the maintained fork of face-api.js, which is no
  longer developed.

## Security and privacy

- **No photos.** Frames stay on the device. Only descriptors are sent, and a
  descriptor can't be turned back into a picture.
- **The data is locked down.** `employee_faces` has RLS on with no policies,
  and anon/authenticated have no table grants. Only `SECURITY DEFINER`
  functions can touch it, and even admins only see enrolled yes/no
  (`face_enrollment_status`).
- **Consent.** Enrollment requires the admin to tick that the person agreed,
  and `consent_at` is stored. Removing a face deletes it. Biometric laws
  (e.g. Illinois BIPA, GDPR art. 9) may need a written policy; check before
  turning this on in those places.
- **Matching happens on the server** (`kiosk_face_match`). The tablet never
  downloads anyone's face data or PIN. A match needs both of these:
  - distance ≤ 0.45 to the person's closest enrolled sample;
  - at least 0.08 closer than any other enrolled person.

  An ambiguous face is refused, so a look-alike is told "not recognised"
  rather than being clocked in as someone else.
- **One face, one account.** Enrollment refuses a face that is within 0.5 of
  someone already enrolled. It also refuses a set of scans that don't match
  each other (someone else stepped in).
- **Liveness.** A scan only counts after the person blinks, so a printed photo
  or a still on a phone doesn't work. A video of the person could still beat
  it. See "Known limits".
- **Lockout.** 10 failed matches in a row lock face matching on that device for
  1 minute. The PIN has its own lockout (5 wrong codes) and keeps working.
- **Tickets.** A match returns `face:<uuid>`, valid for 90 seconds and only on
  that device. The screen passes it to `kiosk_state` and `kiosk_punch` in
  place of the PIN. `kiosk_resolve` is the only function that changed, so
  every rule `kiosk_punch` applies also applies to face punches: team rules,
  `allow_kiosk`, GPS, breaks, lateness and early clock-in.

## Known limits

- Blink liveness can be fooled by a video of the person. To make cheating
  traceable, a later step could store a small snapshot with each face punch
  for admins to review. It isn't done, because photos weren't wanted.
- The limits 0.45 / 0.08 are set in `kiosk_face_match`. If honest people are
  often refused in poor light, raise `max_dist` slightly (e.g. 0.5). Re-enrolling
  in the tablet's own light usually helps more.
- Faces are per company. Someone in two companies is enrolled once in each.
- Enroll from a device with a decent front camera, ideally the tablet itself.

## Removing the fingerprint option

The fingerprint work lived only on `feat/fingerprint-clock-in` (commits
8db3cb4, 689a3e7, 2429e43). It never reached `main` and had no migrations,
tables or RPCs, so nothing needs reverting in the database. This branch is
cut from `main`, so it contains none of it: no `FingerprintPlugin`, no
`src/lib/native/fingerprint.ts`, and no temporary CI trigger. To finish the
cleanup, delete the branch locally and on GitHub. Uninstall the separate
**Pilot Clock** app from any test tablet.

## Manual test plan

You need a company admin account, a device link from **Shared clock-in**, two
employees (A and B) and a device with a front camera.

**Enrollment (Shared clock-in page, as admin)**

1. The section is now called **Face and PIN**. Each person has **Enroll face**
   next to their PIN controls.
2. Press **Enroll face** for A. **Start camera** stays disabled until the
   consent box is ticked.
3. Tick it and press **Start camera**. Allow the camera. Press **Scan face**
   with A in front of it. The progress shows "1 of 5" up to "5 of 5", then
   "Now blink". Once A blinks, the dialog closes and A shows **Face enrolled**.
4. Try to enroll B using A's face. You get "This face is too similar to A…",
   and nothing is saved.
5. Enroll B properly.
6. With two people in view you get "Only one person in front of the camera".
7. Press **Redo** for A. It replaces A's face. Press the bin for A, then
   enroll A again.
8. As a non-admin, `supabase.from("employee_faces").select()` fails
   (permission denied), and `rpc("face_enrollment_status")` returns no rows.

**Clock-in (device link)**

9. Open the device link. It shows the camera with an oval and "Look at the
   camera and blink". The keypad is not shown.
10. A looks and blinks. A's name and status appear, and Clock in works. The
    confirmation shows, then the screen goes back to the camera.
11. A clocks out the same way. Break buttons and the break lock work as
    with the PIN.
12. Someone who isn't enrolled looks and blinks. After about 2 seconds they
    see "Face not recognised. Try again or use your PIN." It retries twice,
    then shows **Tap to scan your face**.
13. Hold up a photo of A on a phone (a still image). Nothing happens, because
    it never blinks. After 20 seconds it shows **Tap to scan your face**.
14. **Use PIN instead** shows the keypad, and A's PIN still works. **Use face
    instead** goes back to the camera. After any punch or Cancel, the next
    person starts on the camera again.
15. Team rules still apply. Put A in a team with `allow_kiosk = false`: a face
    match shows "Your team can't use the shared clock-in…". A team with an
    early clock-in limit refuses early face clock-ins with the same message
    as the PIN.
16. Stay on A's in/out screen for over 90 seconds, then press Clock in. You
    get "Face scan expired. Scan again."
17. Block the camera in the browser and reload. The keypad shows, with "The
    camera is blocked on this device…" above it.
18. On a company with no faces enrolled, the device shows the keypad only,
    exactly as before.
19. Slideshow mode: while the slideshow plays the camera is off (its light is
    off). Tap the screen to wake it; the camera starts.
20. Switch to Spanish. Every new string is translated, on the device and on
    the admin page.
21. Android app (after a rebuild): the first scan asks for the camera; after
    you allow it, steps 9 to 14 work the same.
