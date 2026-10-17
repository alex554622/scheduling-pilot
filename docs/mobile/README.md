# Scheduling Pilot — Android and iOS apps

The Android and iOS apps are this same web app, wrapped with
[Capacitor 8](https://capacitorjs.com). There is one codebase: a change to
`src/` ships to the website, and to the apps on their next store release.

| Guide | What it covers |
| --- | --- |
| [android.md](android.md) | Installing Android Studio on Windows, running on a phone, the upload key, a signed `.aab`, Google Play |
| [ios.md](ios.md) | What needs a Mac, Xcode signing, TestFlight, App Store Connect |
| [store-compliance.md](store-compliance.md) | Privacy answers, account deletion, reviewer access, listings, screenshots, the pre-submission checklist |
| [push-notifications.md](push-notifications.md) | Lock-screen notifications: Firebase (Android), the Apple Push key (iOS), server variables, testing |
| [deep-links.md](deep-links.md) | Making schedulingpilot.com links open the app |
| [account-deletion.md](account-deletion.md) | The proposed database change both stores require. **Not applied.** |

## How it fits together

```
                ┌────────────── one codebase: src/ ──────────────┐
                │                                                 │
   bun run build (unchanged)                         bun run build:mobile
   TanStack Start, SSR, Nitro                        same routes, single-page app
   → .output/  (Coolify)                             → dist/client/  (Capacitor webDir)
                │                                                 │
        schedulingpilot.com                          bun x cap sync → android/, ios/
   + push dispatcher, notification sweeper           assets ship inside the app
                │                                                 │
                └──────── both call supabase.schedulingpilot.com ─┘
                          (same users, roles, RLS, data)
```

**Why a separate mobile build.** The website is server-rendered (TanStack Start
on a Node server). Capacitor can only serve static files from the phone, with no
server behind them. Two things made a static build workable without touching
the website:

1. The app has **no server functions or API routes**. Every query and RPC goes
   straight from the browser to Supabase using the public publishable key, with
   row-level security enforcing access. The website's Node server only
   renders pages and runs the push dispatcher and notification sweeper.
2. TanStack Start has a built-in SPA mode. `vite build --mode mobile` switches
   it on, drops the Nitro server, and prerenders one HTML shell to
   `dist/client/index.html`. The signed-in pages were already client-rendered
   (`ssr: false` on `/_authenticated`).

The apps bundle their own copy of the web assets. There is no `server.url`,
so they never just load the website in a frame. That matters for Apple's
guideline 4.2 (minimum functionality). It also means the apps start
instantly and show a proper offline screen instead of a browser error.

**What stays on the website's server.** The push dispatcher and the
notification sweeper keep running on the Coolify server. The dispatcher also
delivers the apps' lock-screen notifications (FCM for Android, APNs for iOS).
Everything else in the apps works without it.

## What is different inside the apps

All of it sits behind `isNativeApp()` (`src/lib/native/platform.ts`). In a
browser the website takes the same code paths it always has.

| Area | Website | Apps | Where |
| --- | --- | --- | --- |
| Opening screen | Marketing home | Dashboard (or sign-in) | `routes/index.tsx` |
| Session storage | `localStorage` | App-private native storage, excluded from backups | `lib/native/auth-storage.ts`, `AndroidManifest.xml` |
| Links in emails / shared links | This site's origin | Always `https://schedulingpilot.com` | `shareableOrigin()` |
| CSV / PDF export | Browser download | Written to the app cache, opened in the share sheet | `lib/native/files.ts` |
| Print buttons | Shown | Hidden (the web view can't print; Print is in the share sheet) | `timecards.tsx`, `company-billing.tsx` |
| Notifications with the app closed | Web Push + service worker | Native push: FCM (Android), APNs (iOS); no service worker | `push-subscription.ts`, `lib/native/push.ts` |
| Notch, status bar, home bar | n/a | Safe-area padding, status-bar icons follow night mode | `styles.css`, `lib/native/bootstrap.ts` |
| Android back button | n/a | Closes the open dialog, then goes back, then sends the app to the background | `lib/native/bootstrap.ts` |
| No connection | Browser error | Branded offline screen that reconnects by itself | `components/native-shell.tsx` |
| Location (Time clock) | Browser prompt | OS prompt with a plain explanation | `AndroidManifest.xml`, `Info.plist` |

**Notifications in the apps.** While the app is open it shows alerts itself,
as the website does. With the app in the background or closed, they arrive on
the lock screen through the phone's own push service. That needs a Firebase
project and `google-services.json` (Android), an Apple Push key and the Push
Notifications capability (iOS), server variables, and the `push_devices`
migration. All of it is in [push-notifications.md](push-notifications.md).
Until a platform is set up, its app behaves as before: in-app alerts only, and
Settings says so.

## Commands

| Command | What it does |
| --- | --- |
| `bun run build` | Website build, unchanged → `.output/` |
| `bun run build:mobile` | App build → `dist/client/` |
| `bun run mobile:sync` | App build, then copies it and the plugin list into `android/` and `ios/` |
| `bun run mobile:android` | Opens the Android project in Android Studio |
| `bun run mobile:ios` | Opens the iOS project in Xcode (Mac only) |

`bun x cap …` works for any other Capacitor command (`bun x cap doctor`, for example).

## Identity

| | Value |
| --- | --- |
| App ID / Bundle ID | `com.schedulingpilot.app` (permanent once uploaded) |
| Name under the icon | Sched Pilot |
| Store listing name | Scheduling Pilot |
| Publisher | Valladolid NovaTech |
| First version | 1.0.0 (Android versionCode 1, iOS build 1) |
| Android | minSdk 24, compile/target SDK 36 |
| iOS | iOS 15.0 or later, iPhone and iPad |

## Releasing an update

Website and apps release separately: a Coolify Redeploy doesn't change the
apps, and a store release doesn't change the website.

1. Make and test the change as usual (`bun run dev`, `bun run test`, `bun run typecheck`).
2. Deploy the website as usual (push, then Redeploy in Coolify).
3. Bump the app version, keeping the two platforms in step:
   - Android, `android/app/build.gradle`: `versionCode` +1 (every upload, no exceptions) and `versionName`, for example `1.0.1`.
   - iOS, in Xcode under target App → General: Version `1.0.1`, Build +1.
4. `bun run mobile:sync`
5. Android: build the signed `.aab` and upload it ([android.md](android.md), steps 7–9).
6. iOS: Archive and upload, then TestFlight and submit ([ios.md](ios.md), steps 6–9).

**Do you need a store release at all?** Only when the change touches what runs
on the phone, which is almost every change to `src/`. Database changes and
changes to the website's server code reach the apps immediately, because the
apps call the same Supabase backend.

## Keeping the website and apps compatible

Store review takes days and people update apps late, so an app version can
stay in use for months after the website has moved on.

- **Database and RPC changes must be backward compatible.** Add columns and
  new RPCs. Don't rename or remove ones that a released app version still
  calls; keep the old one until no supported app version uses it. The website
  can change in lockstep with the database; the apps can't.
- **RLS is the security boundary, as it is today.** Never put a service-role
  key or any other secret in `VITE_*` variables. They are compiled into the
  app bundle, and anyone can unpack an app.
- **New browser-only APIs** (downloads, `window.print`, Notification,
  `window.open`) need an `isNativeApp()` branch or a check that they work in
  the Android WebView and iOS WKWebView.
- **New links that leave the device** (emails, invitations, QR codes) must use
  `shareableOrigin()`, not `window.location.origin`.
- **New full-height or fixed elements**: use the existing classes. `min-h-screen`
  and the sheets already respect the safe area in the apps. Anything new pinned
  to the top or bottom edge needs `var(--sat)` / `var(--sab)` padding (both are 0 on the website).
- Before every store release, test sign-in, the Time clock (location prompt),
  a CSV and a PDF export, and night mode on a real phone.

## Next steps (not done here)

1. **Account deletion.** Built (option A). The database function still has to be applied by hand. See
   [account-deletion.md](account-deletion.md).
2. **Privacy policy and support pages** on schedulingpilot.com. Both stores
   require public URLs. There is a factual draft in
   [store-compliance.md](store-compliance.md) for you or your counsel to finish.
3. **Native push notifications.** Code is done. It still needs the Firebase
   project, the Apple Push key, the server variables and the `push_devices`
   migration applied: [push-notifications.md](push-notifications.md).
4. **Deep links** for password-reset and sign-up emails ([deep-links.md](deep-links.md)).
