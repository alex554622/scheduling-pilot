# Lock-screen notifications in the Android and iOS apps

The website already delivers notifications to a closed browser with Web Push.
The apps can't use Web Push (their web view has no Push API), so they use the
phone's own push service instead. Everything upstream is shared: the same
triggers fill the same `push_queue`, and the same dispatcher on the website's
server sends each row to every device the person has.

```
 triggers ─► push_queue ─► dispatcher (website's Node server)
                              ├─ push_subscriptions ─► Web Push (VAPID)   → browsers   (unchanged)
                              └─ push_devices
                                   ├─ android ─► FCM HTTP v1 (service account) → Android app
                                   └─ ios     ─► APNs HTTP/2 (.p8 key)         → iOS app
```

| Piece | Where |
| --- | --- |
| Device tokens table + `register_push_device()` | `supabase/migrations/20261017130000_native_push_devices.sql` (**apply by hand in Studio**) |
| App side: permission, token, sign-out, taps, Android channels | `src/lib/native/push.ts` |
| Server side: FCM and APNs senders | `src/lib/server/native-push.ts`, wired in `src/lib/server/push-dispatcher.ts` |
| Android crash guard (no `google-services.json` → push stays off) | `android/app/src/main/java/com/schedulingpilot/app/PushSetupPlugin.java` |
| iOS token hand-off | `ios/App/App/AppDelegate.swift` |

**Why APNs directly for iOS, not FCM for both.** The Capacitor plugin gives an
iOS app the raw APNs token. Sending that token through FCM would mean adding the
Firebase iOS SDK to the Xcode project and changing the app delegate to swap
tokens. Sending straight to Apple needs nothing on the phone beyond the Push
Notifications capability, and on the server it's one signed JWT and an HTTP/2
request. So Firebase is only needed for Android.

## How it behaves

- **Asking.** On Android 13+ and iOS, the OS permission prompt only appears
  from a tap: the "Turn on notifications" card or the switch in Settings →
  Notifications. Android 12 and older grant it at install, so those phones
  register automatically.
- **Registering.** Once permission is granted, the app registers on every
  start-up and files the token under the signed-in account. Tokens rotate, and
  this keeps the row current.
- **Sign-out** removes this phone's row before the session ends. **Switching
  "Show them on this device" off** removes the row and drops the OS
  registration.
- **Shared phones.** `register_push_device()` moves a token to whoever signs in
  now. If the previous person's sign-out didn't reach the server, the phone
  still won't keep getting their notifications.
- **App open:** the app shows notifications itself (bell, toast, break alarm),
  as before. The OS doesn't draw a second one (`presentationOptions: []` in
  `capacitor.config.ts`). **App in the background or closed:** the OS shows it
  on the lock screen.
- **Tap** opens the page the notification is about (for example `/timeclock`
  for a break reminder).
- **Break reminders** go to their own Android channel, "Break almost over"
  (maximum importance), so people can mute messages and keep breaks. On iOS
  they are sent as *time-sensitive*. That only breaks through Focus if the
  Time Sensitive capability is added (optional, step B5).
- **Dead tokens** (app uninstalled, token rotated) are deleted the first time
  FCM or Apple refuses them, the same way dead web subscriptions are.
- **Server not configured yet:** each platform without credentials is skipped,
  with one log line at start-up. The website's Web Push is unaffected either way.

## A. Android: Firebase (about 10 minutes, any computer)

1. Go to <https://console.firebase.google.com> → **Create a project** (for
   example `scheduling-pilot`). Google Analytics isn't needed; turn it off.
2. In the project: **Add app → Android**.
   - Package name: `com.schedulingpilot.app` (exactly).
   - Nickname: Sched Pilot. The SHA-1 isn't needed for messaging.
3. Download **`google-services.json`** and put it at
   **`android/app/google-services.json`**. Skip the "add the SDK" steps:
   the Gradle plugin is already set up (`android/build.gradle` and the
   bottom of `android/app/build.gradle` apply it when the file is there).
   - This file isn't a secret (it identifies the project; the keys in it are
     restricted by package name). It's fine to commit it.
   - Without it the app still builds and runs; push simply stays off and
     Settings says alerts show while the app is open.
4. **Service account for the server:** Firebase console → ⚙ **Project
   settings → Service accounts → Generate new private key**. A JSON file
   downloads. **This one is secret**: never commit it and never put it in a
   `VITE_*` variable.
5. Check **Project settings → Cloud Messaging**: "Firebase Cloud Messaging API
   (V1)" should be **Enabled**. If not, click the ⋮ menu → *Manage API in Google
   Cloud Console* → **Enable**. (The legacy API isn't used.)
6. On the server, see step C.

## B. iOS: Apple Push key and the capability (needs the Mac for B3–B5)

1. <https://developer.apple.com/account> → **Certificates, Identifiers &
   Profiles → Keys → +**.
   - Name: `Scheduling Pilot push`. Tick **Apple Push Notifications service
     (APNs)**. Environment: **Sandbox & Production**. Continue → Register.
   - **Download the `.p8` file.** Apple lets you download it only once. Keep
     it with the Android upload key, outside the repo (`*.p8` is gitignored).
   - Note the **Key ID** (10 characters, shown on the key page) and your
     **Team ID** (top right of the developer site, or Membership details).
2. The App ID `com.schedulingpilot.app` (Identifiers) gets the Push
   Notifications capability ticked automatically when Xcode adds it in B3. You
   can also tick it there by hand.
3. In Xcode: target **App → Signing & Capabilities → + Capability → Push
   Notifications**. This creates `App.entitlements` with `aps-environment`.
   Commit that file.
4. *(No Background Modes needed.* These are ordinary alert notifications.)
5. *(Optional)* **+ Capability → Time Sensitive Notifications**, so break
   reminders get through Focus modes. Apple asks you to use it only for
   notifications that really are time-sensitive, which a break ending is.
6. Run on a **real iPhone** (the simulator can register but can't receive
   from APNs reliably). A build from Xcode gets a *sandbox* token, and
   TestFlight/App Store builds get *production* ones. The server tries both,
   so one setting covers both.

## C. Server environment (Coolify → the website's app → Environment Variables)

All server-only. None of them start with `VITE_`.

| Variable | Value |
| --- | --- |
| `FCM_SERVICE_ACCOUNT` | The service-account JSON from A4. Paste it whole, or base64-encode it if the field won't take newlines: `base64 -w0 file.json` (Linux), or in PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("file.json"))` |
| `APNS_KEY_ID` | Key ID from B1 |
| `APNS_TEAM_ID` | Team ID from B1 |
| `APNS_PRIVATE_KEY` | Contents of the `.p8` file (with its BEGIN/END lines), or base64 of it |
| `APNS_BUNDLE_ID` | *(optional)* defaults to `com.schedulingpilot.app` |
| `APNS_ENV` | *(optional)* `production` (default) or `sandbox`: which Apple server is tried first |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are needed as before. Then
**Redeploy** (Coolify doesn't redeploy on push). The log should say:

```
[push] dispatcher started (web: on, android: on, ios: on)
```

## D. Database

Apply `supabase/migrations/20261017130000_native_push_devices.sql` in the
self-hosted Studio SQL editor (the CLI isn't linked to the self-hosted
database). It only adds things: the `push_devices` table, its RLS policy and
the `register_push_device()` function. It doesn't touch `push_subscriptions`,
`push_queue` or any trigger. Check afterwards:

```sql
select policyname from pg_policies where tablename = 'push_devices';
select proname from pg_proc where proname = 'register_push_device';
```

## E. Test it

1. `bun run mobile:sync`, then run on a real phone (android.md step 3 / ios.md step 4).
2. Sign in → accept the notification prompt (card, or Settings → Notifications →
   "Show them on this device"). Settings should say "These reach you with the
   app closed".
3. In Studio: `select platform, left(token, 12), last_seen_at from push_devices;`
   should show the phone.
4. Lock the phone. From another account, post a message on Messages, or start
   a 5-minute break on the phone and lock it. The notification should appear on
   the lock screen; tapping it should open Messages / the Time clock.
5. If nothing arrives: the dispatcher log (`[push]` lines in Coolify), then
   `select type, attempts, last_error from push_queue order by created_at desc limit 10;`.
   - `FCM 403 … SENDER_ID_MISMATCH`: `google-services.json` and the service
     account are from different Firebase projects.
   - `FCM sign-in failed`: `FCM_SERVICE_ACCOUNT` is wrong or truncated.
   - `APNs 403 InvalidProviderToken`: Key ID / Team ID / `.p8` don't match.
   - `APNs 400 DeviceTokenNotForTopic`: `APNS_BUNDLE_ID` isn't the app's bundle ID.
   - No row in `push_devices` on iOS: the Push Notifications capability is
     missing (B3). On Android: `google-services.json` was missing when the
     app was built.
6. Sign out on the phone → its row disappears from `push_devices`.
