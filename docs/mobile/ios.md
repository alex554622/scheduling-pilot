# iOS: from this repo to the App Store

## What needs a Mac

Building, signing and uploading an iOS app needs **Xcode, which only runs on
macOS**. You can do everything else on this Windows PC: the code, the web
build, `cap sync`, App Store Connect in a browser, and the listing.

Options, cheapest first:

1. **Borrow or buy a Mac** (any Apple-silicon Mac that runs the current macOS).
2. **Rent a cloud Mac** (MacinCloud, AWS EC2 Mac, and similar services) and
   use it over Remote Desktop.
3. **Cloud build service** (Codemagic, Ionic Appflow, or GitHub Actions macOS
   runners). They build and upload from the repo without you touching a Mac,
   but signing still has to be set up once with your Apple account.

You also need an **Apple Developer Program** membership (US $99/year). Enroll
as an **organization** (Valladolid NovaTech, which needs a D-U-N-S number) so
the store shows the company as the seller: <https://developer.apple.com/programs/enroll/>.

The iOS project uses Swift Package Manager, Capacitor 8's default, so
CocoaPods is **not** needed.

## 1. On the Mac: tools

- Install **Xcode** (the current release) from the Mac App Store and open it
  once so it installs its components. Apple only accepts uploads built with a
  recent Xcode and SDK.
- Install **Node.js** (LTS) and **bun** (<https://bun.sh>).
- Clone the repo, then:

```bash
bun install
```

- Create `.env` with the same public `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` as the website. Copy it securely from this
  PC; never commit it. No server-only key is needed for the app build.

## 2. Build and open

```bash
bun run mobile:sync
bun run mobile:ios
```

Xcode opens `ios/App/App.xcodeproj`. Wait for the package resolution to
finish (shown in the status area at the top).

## 3. Signing

In Xcode, select the **App** project → target **App** → **Signing &
Capabilities**:

- **Team**: your Apple Developer team (sign in under Xcode → Settings → Accounts).
- **Bundle Identifier**: `com.schedulingpilot.app` (already set).
- Leave **Automatically manage signing** on.
- **+ Capability → Push Notifications** (and optionally Time Sensitive
  Notifications) for lock-screen notifications. The Apple Push key and server
  setup are in [push-notifications.md](push-notifications.md), section B.

## 4. Run on the simulator and a real iPhone

- Simulator: pick an iPhone in the device menu, then **Run ▶**. Try an iPad
  simulator too; the app supports iPad.
- iPhone: connect it with a cable, turn on **Developer Mode** (Settings →
  Privacy & Security), pick it in the device menu, then **Run ▶**.

Check the same list as on Android (android.md, step 3), plus the notch and home
indicator areas. Nothing should sit under them.

## 5. Create the app in App Store Connect

<https://appstoreconnect.apple.com> → **Apps → + → New App**:

- Platform iOS · Name **Scheduling Pilot** · Primary language English (U.S.)
- Bundle ID `com.schedulingpilot.app` (register it first under Certificates,
  Identifiers & Profiles if it isn't listed)
- SKU: `schedulingpilot-ios`

## 6. Archive and upload

1. Version and build: target **App → General**. Version `1.0.0`, Build `1`
   (raise Build on every upload).
2. Set the device menu to **Any iOS Device (arm64)**.
3. **Product → Archive**. When the Organizer opens: **Distribute App → App
   Store Connect → Upload**.

## 7. TestFlight

After processing (around 10–30 minutes) the build appears under **TestFlight**.
Answer the export-compliance question. The app only uses standard HTTPS, and
`ITSAppUsesNonExemptEncryption` is already set to `NO` in `Info.plist`. Then
add yourself as an internal tester and install it with the TestFlight app.

## 8. Listing, privacy, review details

Use [store-compliance.md](store-compliance.md) for:

- Description, keywords, support URL, privacy policy URL
- **App Privacy** (the nutrition label)
- Screenshots: **6.9" iPhone** and **13" iPad** are both required
- **App Review Information**: demo account sign-in and notes
- Age rating

## 9. Submit

Attach the build to the version, then **Add for Review → Submit**. Releasing
after approval is your choice: manual or automatic.

## Before submitting: still to do on the Mac

- **Privacy manifest**: Capacitor and its plugins ship their own
  `PrivacyInfo.xcprivacy`. In Xcode, check **Product → Archive →
  Generate Privacy Report** after archiving and confirm it lists no required-reason
  API without a declared reason.
- **Universal Links** (optional, see deep-links.md): add the **Associated
  Domains** capability with `applinks:schedulingpilot.com`.
- **Spanish location prompt** (optional): add an `InfoPlist.strings`
  localization so the location explanation also appears in Spanish.
