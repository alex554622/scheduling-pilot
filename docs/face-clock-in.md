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

## Employees enrolling their own face, and admin-chosen PINs

Apply `supabase/migrations/20261130120000_face_self_enroll_and_custom_pins.sql`
the same way, after `20261129120000_face_clock_in.sql`.

- **Self-enrollment.** Settings → My account has a **Face clock-in** card. The
  employee ticks consent and scans their face. The scan is stored in
  `employee_face_requests` (RLS on, no policies, no grants, like
  `employee_faces`). The shared clock-in does not use it yet.
- **Approval.** The Shared clock-in page shows "N faces are waiting for your
  approval" and, under each person, **Approve** or **Reject**. This applies to
  the first face and to every change. While a change waits, the old approved
  face keeps working. To help decide, the page says whether the new scan looks
  like the face already approved for them. A face the admin enrolls directly
  is approved straight away.
- **Checks.** A scan that matches someone else's approved face is refused. The
  employee is told only "already enrolled for someone else", never whose.
  Approval runs the checks again.
- **Removing.** The employee can remove their own face (approved and waiting)
  at any time. The admin can too.
- **PINs.** **Set code** / **Change code** lets the admin type any 4 digits.
  The arrows button still picks a random free code. Two people in one company
  can't have the same code. The old code stops working straight away.

## The face model: Human (`@vladmandic/human` 3.3)

Apply `supabase/migrations/20261201120000_face_model_human.sql` after the two
migrations above. **It deletes every saved face**: faces from the first
version (face-api.js, 128 numbers) can't be compared with the new model, so
everyone adds their face again. PINs are untouched.

Why the switch. The first version used face-api.js. Adding a face kept
failing: its small detector missed many faces, and its same-person distances
(median 0.49) were above the 0.45 limit, so honest scans were refused.
Human is the maintained successor by the same author (MIT, free, runs in the
browser and the Capacitor app on WebGL):

| Measured on 40 photos of 8 people | face-api.js | Human |
|---|---|---|
| Faces not found | 15 | 1 |
| Equal error rate | ~10% | ~4% |
| Same person, median distance | 0.49 | 0.81 (of a gap to ≥ 0.88 for others) |

With the new limits (0.80 / 0.06), nobody was ever taken for someone else,
colleague or stranger, and 11 of 15 were recognised from completely
different photos. At the tablet, scans come from one camera and are much
closer than that.

- **Library and models are static files**: `public/vendor/human/human.esm.js`
  (2 MB) and `public/models/human` (BlazeFace, face mesh, faceres,
  about 11 MB). They load only on the clock-in screen and the enroll dialog.
  Bundling the library ran the production build out of memory, so it is
  loaded by URL. To upgrade, copy a newer `dist/human.esm.js` (without its
  `sourceMappingURL` line) and the three models.
- **Adding a face is automatic**: after the consent tick and **Start camera**
  it scans by itself, the oval turns green while it is taking good scans, and
  a bar fills up. It says "Come a little closer", "Look straight at the
  camera" or "Only one person" when needed. Blurry frames are dropped and
  taken again instead of failing. No blink is asked for.
- **Clock-in needs no blink.** It takes two scans of the face about a quarter
  of a second apart and matches as soon as they agree, so it is quick even on
  slow tablets. An earlier version asked for a blink; it was removed because
  people found it slow and hard to trigger. Human's own anti-spoof and
  liveness scores were tried and left off: on genuine faces they ranged from
  0.3 to 1.0, too unreliable to gate on.

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
  - distance ≤ 0.80 to the person's closest enrolled sample;
  - at least 0.06 closer than any other enrolled person.

  An ambiguous face is refused, so a look-alike is told "not recognised"
  rather than being clocked in as someone else.
- **One face, one account.** Enrollment refuses a face that is within 0.80 of
  someone already enrolled. It also refuses a set of scans that don't match
  each other (someone else stepped in).
- **No liveness check.** Any steady face is matched, so a clear photo of an
  enrolled person held up to the camera could clock them in. See "Known
  limits".
- **Lockout.** 10 failed matches in a row lock face matching on that device for
  1 minute. The PIN has its own lockout (5 wrong codes) and keeps working.
- **Tickets.** A match returns `face:<uuid>`, valid for 90 seconds and only on
  that device. The screen passes it to `kiosk_state` and `kiosk_punch` in
  place of the PIN. `kiosk_resolve` is the only function that changed, so
  every rule `kiosk_punch` applies also applies to face punches: team rules,
  `allow_kiosk`, GPS, breaks, lateness and early clock-in.

## Known limits

- There is no liveness check, so a photo or video of an enrolled person can
  clock them in. To make cheating
  traceable, a later step could store a small snapshot with each face punch
  for admins to review. It isn't done, because photos weren't wanted.
- The limits 0.80 / 0.06 are set in `kiosk_face_match`. If honest people are
  often refused in poor light, raise `max_dist` slightly (e.g. 0.85, still
  under the 0.88 closest pair of different people measured). Re-enrolling in
  the tablet's own light usually helps more.
- To tune the clock-in on a real tablet, open the device link with
  `?debug=face` at the end. Live numbers show over the camera: face size
  (share of the frame width; under 0.12 asks to come closer), detection score
  (a descriptor needs 0.6), samples taken (2 agreeing scans make a match),
  and ms per frame.
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
3. Tick it and press **Start camera**. Allow the camera. With A in front of
   it, scanning starts by itself: the oval turns green and the bar fills in a
   few seconds, with no blink. "Face saved" shows, the dialog closes and A
   shows **Face enrolled**. Try it far away (it asks to come closer) and with
   the head turned (it asks to look straight).
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
   camera". The keypad is not shown.
10. A looks at the camera. A's name and status appear, and Clock in works. The
    confirmation shows, then the screen goes back to the camera.
11. A clocks out the same way. Break buttons and the break lock work as
    with the PIN.
12. Someone who isn't enrolled looks at the camera. After about 2 seconds they
    see "Face not recognised. Try again or use your PIN." It retries twice,
    then shows **Tap to scan your face**.
13. (Known limit) A clear photo of A held up to the camera is matched as A,
    because there is no blink check.
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

**Self-enrollment, approval and PINs** (after the second migration)

22. As employee A, open Settings → My account. The **Face clock-in** card says
    "You haven't set up face clock-in." Press **Set up face clock-in**, tick the
    box, scan. The card now says the scan is waiting for an admin.
23. On the device link, A's face is not recognised yet; A's PIN still works.
24. As admin, open Shared clock-in. It shows "1 face is waiting for your
    approval" and, under A, "This is their first face…". Press **Approve**.
    A now shows **Face enrolled**, and A's face works on the device.
25. As A, press **Scan my face again** and scan. The card says the new scan is
    waiting and the current one keeps working. On the device, A's old face
    still works.
26. As admin, the row says "It looks like the face already approved for
    them." Press **Reject**. A keeps the old face.
27. As employee B, try to enroll using A's face. B gets "This face is already
    enrolled for someone else" and A's name is not shown.
28. As A, press **Remove my face**. A disappears from the enrolled list and must
    use the PIN.
29. As admin, press **Change code** on A, type 0420, **Save**. 0420 works on the
    device and A's old code doesn't. Typing B's code for A gives "That code is
    already someone else's". The arrows button gives A a random code.
