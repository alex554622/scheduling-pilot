# Android: from this repo to Google Play (Windows 11)

Work through these steps in order. Commands run in a terminal opened in the
project folder (`C:\Users\Alex\Desktop\Programs\PrimeSchedule`).

## 1. Install Android Studio (one time)

1. Download Android Studio from <https://developer.android.com/studio> and
   install it with the defaults. It brings its own Java (JDK 21), which is all
   the Android build needs.
2. On first launch, pick **Standard** setup. It downloads the Android SDK.
3. **More Actions → SDK Manager**: confirm **Android 16 (API 36)** is ticked
   under SDK Platforms and **Android SDK Build-Tools** under SDK Tools.

> **This PC is an ARM (Snapdragon) machine.** Current Android Studio releases
> run on Windows on ARM. If the emulator gives you trouble, a real Android
> phone over USB (step 3) is the more reliable way to test anyway.

## 2. Build the web part and open the project

```bash
bun run mobile:sync
```

This builds the app's web files into `dist/client/` and copies them into
`android/`. Run it again after **every** change to `src/`, otherwise the app
shows the old version.

For lock-screen notifications, put `google-services.json` from Firebase at
`android/app/google-services.json` before building
([push-notifications.md](push-notifications.md), section A). Without it the
app builds and runs normally, but push stays off.

```bash
bun run mobile:android
```

This opens `android/` in Android Studio. (Or **File → Open** and choose the
`android` folder.) The first Gradle sync downloads dependencies and takes a few
minutes. Wait until the status bar at the bottom says it's finished.

## 3. Run it on a phone or emulator

**Real phone (recommended):**

1. On the phone, open **Settings → About phone** and tap **Build number** seven
   times to unlock Developer options.
2. **Settings → System → Developer options → USB debugging**: on.
3. Plug the phone in and accept the "Allow USB debugging?" prompt.
4. Pick the phone in Android Studio's device dropdown and press **Run ▶**.

**Emulator:** **Device Manager → +** → pick a Pixel → a recent system image
(on an ARM PC, choose an **arm64-v8a** image) → **Finish** → **Run ▶**.

**What to check:** sign in, the dashboard, the Time clock (it should ask for
location with the explanation text), a CSV export and a PDF (both should open
the share sheet), night mode (status-bar icons turn light), the back button
(closes dialogs, then goes back), and airplane mode (offline screen, then it
reconnects by itself).

**Debugging:** a debug build can be inspected from desktop Chrome at
`chrome://inspect`. Release builds turn that off.

## 4. Create your Google Play developer account (one time)

<https://play.google.com/console/signup>. There's a one-time US $25 fee and an
identity check.

- **Organization account** (recommended for Valladolid NovaTech) needs a D-U-N-S
  number. It shows the company as the publisher, and production access isn't
  gated by closed testing.
- **Personal account**: Google requires newer personal accounts to run a
  **closed test with at least 12 testers for 14 days in a row** before they can
  apply for production. Plan for that.

## 5. Create the upload key (one time, keep it safe)

Google Play signs the app people download with its own key (Play App
Signing). You sign each upload with your **upload key**. If the upload key is
lost, Google can reset it, but that takes time, so back it up.

In Android Studio: **Build → Generate Signed App Bundle or APK → Android App
Bundle → Next → Create new…**

- Key store path: somewhere **outside** the repo, for example
  `C:\Users\Alex\Documents\keys\schedulingpilot-upload.jks`
- Choose a strong password and save it in your password manager.
- Alias: `upload`; validity: 25 years or more; fill in the certificate name
  (Valladolid NovaTech).

Then create `android\keystore.properties` (gitignored, never committed):

```properties
storeFile=C:/Users/Alex/Documents/keys/schedulingpilot-upload.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=upload
keyPassword=YOUR_KEY_PASSWORD
```

`android/app/build.gradle` reads this file automatically for release builds.

**Back up** the `.jks` file and both passwords somewhere other than this PC.

Check that git won't pick them up:

```bash
git status --short android
```

Neither `keystore.properties` nor any `.jks` should appear.

## 6. Set the version

`android/app/build.gradle` → `versionCode 1`, `versionName "1.0.0"` for the
first upload. Every later upload needs a **higher** `versionCode`.

## 7. Build the signed release bundle

```bash
bun run mobile:sync
```

Then in Android Studio: **Build → Generate Signed App Bundle or APK → Android
App Bundle**, pick your keystore, choose the **release** build variant, and
click **Create**. The file lands in
`android\app\release\app-release.aab`.

Or from a terminal inside `android\` (needs `JAVA_HOME` pointing at Android
Studio's bundled JDK, e.g. `C:\Program Files\Android\Android Studio\jbr`):

```bash
gradlew.bat bundleRelease
```

Output: `android\app\build\outputs\bundle\release\app-release.aab`.

## 8. Create the app in Play Console

**Create app** → name *Scheduling Pilot*, default language English (United
States), type **App**, **Free**, then accept the declarations.

Fill in every section under **Policy → App content**. Use the answers in
[store-compliance.md](store-compliance.md):

- Privacy policy URL
- App access: give reviewers sign-in details for a demo company
- Ads: **No**
- Content rating questionnaire (category: Productivity / business tool)
- Target audience: 18+
- Data safety
- Government app: No · Financial features: No · Health: No
- Account deletion: in-app path plus a web URL

**Main store listing**: text, icon (512×512), feature graphic (1024×500), and
phone screenshots. Add 7" and 10" tablet screenshots too, since the app supports tablets.

## 9. Upload and test, then go live

1. **Testing → Internal testing → Create new release**, upload the `.aab`, add
   release notes, then roll out to internal testers (your own Google accounts).
   Install it from the opt-in link and check it on a phone.
2. **Closed testing** (and the 12 testers × 14 days rule if the account is personal).
3. **Production → Create new release**, promote the tested bundle, then
   **Send for review**. The first review usually takes a few days.

Nothing is published until you press the final rollout button yourself.

## After launch: App Links

Once the app exists in Play Console, copy the **SHA-256 certificate
fingerprint** from **Test and release → Setup → App signing**, then follow
[deep-links.md](deep-links.md).
