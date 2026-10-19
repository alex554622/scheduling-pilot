# Android APK from schedulingpilot.com/download (no Play Store)

People can install the Android app straight from your website. The same
GitHub workflow also builds the `.aab` you upload to Google Play later, signed
with the same key, so the two stay compatible.

```
GitHub → Actions → "Android release" → Run      (builds on GitHub's servers)
        ↓  download the artifact (zip)
Supabase Studio → Storage → downloads           (upload 2 files)
        ↓
schedulingpilot.com/download shows the new version (no redeploy needed)
```

## One-time setup

### 1. Create the signing key (on this PC, about 5 minutes)

The key is the app's permanent identity. Every APK and every Play update must
be signed with it. If it's lost, people have to uninstall and reinstall.

1. If Java isn't installed yet:

   ```bash
   winget install EclipseAdoptium.Temurin.21.JDK
   ```

   Then open a **new** terminal.
2. Run:

   ```bash
   powershell -ExecutionPolicy Bypass -File .\scripts\make-android-key.ps1
   ```

   When asked, choose a strong password (type it twice) and save it in your
   password manager. With this key type the key password is the same as the
   store password.
3. It creates, outside the repo, in `Documents\scheduling-pilot-keys\`:
   - `scheduling-pilot-release.keystore`: **back this up** (password manager
     attachment, encrypted USB drive). Never commit it.
   - `ANDROID_KEYSTORE_BASE64.txt`: the same key as text, for GitHub.

### 2. Add the GitHub secrets

GitHub → your repo → **Settings → Secrets and variables → Actions → New
repository secret**. Add each of these:

| Name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The whole contents of `ANDROID_KEYSTORE_BASE64.txt` |
| `ANDROID_KEYSTORE_PASSWORD` | The password you chose |
| `ANDROID_KEY_PASSWORD` | The same password |
| `ANDROID_KEY_ALIAS` | `schedulingpilot` |
| `VITE_SUPABASE_URL` | `https://supabase.schedulingpilot.com` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The same publishable key as in your `.env` (public by design) |
| `GOOGLE_SERVICES_JSON` | *Optional.* The contents of `google-services.json` from Firebase, for lock-screen push ([push-notifications.md](push-notifications.md)) |

After saving, delete `ANDROID_KEYSTORE_BASE64.txt` from the PC; the
`.keystore` file is the copy to keep.

Never add the service-role key or anything else server-only here. The
workflow doesn't need it.

### 3. Create the public download folder in Supabase

Supabase Studio → **Storage → New bucket**:

- Name: `downloads`
- **Public bucket: on** (anyone with the link can download; nothing else is in it)
- Leave the file size limit at its default unless it's below 100 MB

The two files go straight into the bucket, not into a folder.

## Each release

1. **Pick the version.** `versionName` is what people see (`1.0.0`, `1.0.1`, …).
   `versionCode` is a whole number that must be **higher than every earlier
   build**, counting builds uploaded to Google Play too. Phones refuse to
   install a lower number over a higher one.
2. GitHub → **Actions → Android release → Run workflow**, enter both, then
   **Run**. It takes about 5–10 minutes. If it fails at the first step, a
   secret is missing, and the log names it.
3. Open the finished run and download the artifact
   `scheduling-pilot-android-<version>` (a zip). Inside:
   - `scheduling-pilot.apk`: for the website
   - `latest.json`: version, size and checksum, which the download page reads
   - `scheduling-pilot-<version>.aab`: for Google Play (not needed for the website)
   - `signing-certificate.txt`: the key's fingerprint, needed for App Links
4. Studio → Storage → `downloads` (top level, no folder): upload `scheduling-pilot.apk`
   and `latest.json`. On later releases, delete the old two files first (or
   use replace), so the names stay the same.
5. Open https://schedulingpilot.com/download and check the new version
   number shows. Then install it on a phone, ideally over the previous version.

Upload `latest.json` **last**. Until it's there, the page keeps offering the
previous APK, so nobody gets a half-uploaded file.

## Installing on a phone

On the phone, open schedulingpilot.com/download, tap **Download for Android
(APK)**, open the file, and allow "Install unknown apps" for the browser when
Android asks. Updates install over the top, and people stay signed in.

To put it on a phone without a browser download (for example your own test
phone): connect it by USB with USB debugging on, then run

```bash
adb install -r scheduling-pilot.apk
```

`adb` comes with Android Studio's platform-tools.

## Google Play later: keep one key

Google Play normally re-signs apps with its own key. Then the Play version and
your website APK would have **different signatures**, and someone who has
one installed can't update to the other without uninstalling (and losing
their sign-in).

To avoid that, when you set up **App signing** for the app in Play Console,
choose to **use your own app signing key** and upload this same keystore
(Play Console walks you through it with its encryption tool). After that,
the website APK and the Play app are interchangeable updates of each other.
Decide this **before the first Play upload**. It can't be switched later
without Google's key-upgrade process.

## Things to know

- **Google's developer verification.** Google has announced that Android
  will require apps installed from outside Play to come from a verified
  developer: first in a few countries from September 2026, then worldwide.
  Register Valladolid NovaTech and the package `com.schedulingpilot.app` in
  the Android Developer Console so the APK keeps installing everywhere. Check
  the current dates at https://developer.android.com/developer-verification.
- **Play Protect** may show a one-time "unknown app" warning for sideloaded
  APKs. That's normal for apps not installed from Play.
- **Updates aren't automatic.** People install new versions from the page
  themselves. Once the app is on Google Play, point Android users there for
  automatic updates.
- The website's `/download` page needs no redeploy for a new APK. It reads
  `latest.json` from storage.

## iPhone: what's possible without the App Store

Apple doesn't allow installing an app from a website download. The options are:

| Option | Who can install | Needs | Notes |
| --- | --- | --- | --- |
| **Home Screen web app** (available now) | Anyone | Nothing | The /download page explains it. Full screen, signed in, web push notifications on iOS 16.4+ |
| **TestFlight public link** | Up to 10,000 people with the link, via Apple's TestFlight app | Apple Developer Program (US $99/yr), a Mac or cloud Mac build, a short Beta App Review | Each build expires after 90 days, so upload a new one regularly. The usual way to share an iPhone app before or instead of an App Store release |
| **Ad Hoc** | Up to 100 iPhones per year, registered by device ID | Developer Program and a Mac | Good for a handful of company phones |
| **App Store** | Everyone | Developer Program, Mac, full review | [ios.md](ios.md) |

When you have the Apple account, the TestFlight steps are in [ios.md](ios.md),
steps 5–7. Turn on **Public Link** in the TestFlight group settings to get a
shareable invite URL, which you can then add to the /download page.
