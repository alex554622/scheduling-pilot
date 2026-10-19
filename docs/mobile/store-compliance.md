# Store compliance, listings and the submission checklist

The data answers below come from reading the code (October 2026). They
describe what the app does today. Re-check them whenever a feature changes
what is collected, and have someone accountable for the business (and ideally
counsel) confirm them before submitting. Nothing here is a finished legal
document.

## 1. Blockers: must be done before either store will accept the app

| # | Item | Status |
| --- | --- | --- |
| 1 | **In-app account deletion** (Apple 5.1.1(v), Google Play User Data) | Done: Settings → Delete account; database function applied and verified, see [account-deletion.md](account-deletion.md) |
| 2 | **Privacy policy URL** on schedulingpilot.com | Done: https://schedulingpilot.com/privacy |
| 3 | **Support URL / contact** | Done: valladolidnovatech@gmail.com, shown in the privacy policy, Settings and the deletion page |
| 4 | **Google Play deletion web page** | Done: https://schedulingpilot.com/delete-account (live) |
| 5 | **Reviewer demo account** | Create one (section 6) |
| 6 | **Developer accounts** | Apple Developer Program (US $99/yr), Google Play Console (US $25 once) |

## 2. Minimum functionality (Apple 4.2) and the "wrapper" risk

The apps bundle their own web assets (no remote `server.url`) and add real
device integration: system share sheet for exports, native session storage,
OS location prompt for the time clock, Android back-button handling, an
offline screen, status bar and safe areas that follow night mode, and app
links. The app opens on the signed-in product, not the marketing site.

Remaining risk: because the app requires a company account, a reviewer who
can't sign in sees only a login screen and may reject it under 2.1 or 4.2.
The demo account (section 6) addresses that. Native lock-screen notifications
([push-notifications.md](push-notifications.md)) strengthen the case further.

## 3. Payments (Apple 3.1, Google Play Payments policy)

**Today the app takes no payments.** Stripe isn't connected; the platform
admin manages billing outside the app (`company-billing.tsx`). So the in-app
purchase rules aren't triggered.

Keep it that way in the apps unless you decide to use Apple/Google billing:

- Don't add in-app buttons or links that take people to buy or upgrade a
  plan on the website. Apple's rules on linking out vary by country, and
  Google requires Play Billing for digital subscriptions bought in-app.
  Before adding any purchase flow, put it behind `!isNativeApp()`.
- The app already opens on the dashboard instead of the marketing home
  page, which shows prices.
- **To check:** the "See plans" button shown when a feature isn't in the
  company's plan. It must only show plan information, never a purchase flow.
  Apple's 3.1.3(c) (enterprise services sold to organizations) is the
  clause that would cover selling to businesses outside the app. Read it before
  adding anything.

## 4. What the app collects: facts for the privacy policy and store forms

| Data | Source in the app | Purpose | Linked to the person | Shared with |
| --- | --- | --- | --- | --- |
| Name, email | Sign-up, profile | Account, showing staff to their company | Yes | The person's employer (company admins) |
| User ID | Supabase auth | Account | Yes | — |
| Role, position, company | Profile, roles | App function | Yes | Employer |
| **Precise location** | Time clock screen (while open), saved with each punch; admins placing a worksite | Geofenced clock-in, record of where a punch happened | Yes | Employer |
| Work schedule, shifts, time punches, breaks, time off, availability, shift trades | In-app use | App function | Yes | Employer |
| Messages | Company messages | App function | Yes | Other members of the company |
| Hourly rate and tax % for the earnings estimate | Entered by the employee | Live earnings estimate | **Stays on the device** (`pay-settings.ts`, local storage), never sent | — |
| Map view | Leaflet with OpenStreetMap tiles | Showing the worksite | IP address and map area sent to OpenStreetMap's tile servers | OpenStreetMap Foundation |
| Web-push endpoint (website only) | Browser push subscription | Notifications | Yes | Browser push service |
| **Push token** (apps) | FCM registration token (Android) or APNs device token (iOS), filed in `push_devices` after the person allows notifications | Delivering notifications | Yes | Google (Firebase Cloud Messaging) on Android, Apple (APNs) on iOS |
| Notification content (apps and website) | Title and text of each notification: schedule changes, break reminders, announcements, a preview of new messages with the poster's name | Delivering notifications | Yes | Passes through Google, Apple or the browser's push service to reach the device. Web Push is end-to-end encrypted; FCM and APNs aren't, so Google and Apple can see the content in transit |

Not present in the code: advertising, analytics or tracking SDKs, crash
reporting, contacts, photos, camera, microphone, health data, payments in the
app, and background location.

Infrastructure: data is stored on your self-hosted Supabase at
supabase.schedulingpilot.com and the website at schedulingpilot.com, and
encrypted in transit (HTTPS). Sign-up and reset emails go through Resend (SMTP).
Notifications to the apps go through Google Firebase Cloud Messaging (Android)
and Apple Push Notification service (iOS). List Resend, Google (Firebase), Apple
and your hosting provider as processors in the privacy policy. The app uses only
Firebase Cloud Messaging; Firebase Analytics and Crashlytics aren't included.

**OpenStreetMap tiles:** the public `tile.openstreetmap.org` servers have a
usage policy that discourages heavy commercial app use. Consider a tile
provider with a commercial plan before usage grows.

## 5. Store data forms

### Google Play: Data safety

- Does the app collect or share user data? **Yes**
- Is all data encrypted in transit? **Yes**
- Can users request deletion? **Yes**: in-app (Settings → Delete account) and https://schedulingpilot.com/delete-account. Answer Yes only once the database function is applied and the website is redeployed.
- Collected (all **required**, purpose **App functionality** and **Account management**, not shared for advertising):
  - Personal info → **Name**, **Email address**, **User IDs**
  - Location → **Precise location** (and approximate)
  - Messages → **Other in-app messages**
  - App activity → **Other user-generated content** (schedules, time punches, time off)
  - Device or other IDs → **Device or other IDs** (the FCM push token; purpose
    App functionality). Google counts push tokens as device IDs, so declare it.
- "Shared" in Play's sense is transfer to a third party. The employer is part of
  the service the user signed up for. Check Google's current definitions
  carefully for the OpenStreetMap request.

### Apple: App Privacy ("nutrition label")

- Tracking: **No** (no data is used for tracking across other companies' apps).
- Data linked to the user, purpose **App Functionality**: Contact Info (Name,
  Email Address), Location (Precise Location), Identifiers (User ID), User
  Content (Other User Content; Emails or Text Messages for in-app messages, as
  appropriate). Identifiers → **Device ID** for the APNs push token: Apple
  doesn't clearly require declaring push tokens, so declaring it is the cautious
  choice. Confirm when filling in the form.
- Not collected: Financial info (the pay estimate stays on the device),
  diagnostics, usage data, purchases.

## 6. Reviewer access (App access / App Review Information)

Create a **demo company** on the live system that holds no real personal data:

- One **company admin** login and one **employee** login, with a few shifts,
  a timecard, and a message. Fill in sample data that looks real but belongs
  to nobody.
- Worksite geofence **off** for the demo company (or set wide), so a reviewer
  far from the worksite can still clock in.
- Give both stores the email and password in their review-notes fields, plus
  this note:

  > Scheduling Pilot is a workforce scheduling and time-clock app for businesses.
  > Accounts belong to a company. Use the admin login to see scheduling, timecards and
  > reports, or the employee login to see a personal schedule and the time clock.
  > Location is requested only on the Time clock screen. The app has no in-app purchases.

Keep these logins working for as long as the app is listed.

## 7. Permissions (and why)

| Permission | Platform | Asked when | Text shown |
| --- | --- | --- | --- |
| Location (precise, while in use) | Android `ACCESS_FINE_LOCATION`/`COARSE`; iOS `NSLocationWhenInUseUsageDescription` | First time the Time clock or a worksite map is opened | "Your location is used while the Time clock screen is open, to check that you are at your worksite and to record where each clock-in and clock-out happened. Admins also use it to place a worksite on the map. It is never tracked in the background." |
| Internet | Android | Install time (no prompt) | — |
| Notifications | Android 13+ `POST_NOTIFICATIONS` (runtime); iOS notification authorisation | Only from a tap: the "Turn on notifications" card or Settings → Notifications. Never at launch. Android 12 and older grant it at install | The OS's own prompt. The card above it says: "Get a buzz on this device when your break is almost over, your shifts change, or someone sends a message — even with the app closed." |

No camera, contacts, microphone, storage or background-location permissions are
requested. Push needs no background mode on iOS (these are ordinary alert
notifications).

**Push and review.** Apple 4.5.4: notifications must not be required for the app
to work (they aren't), and must not be used for marketing without a separate
opt-in. Every notification here is about the person's own work. Keep it that
way, or add an opt-in before sending anything promotional.

## 8. Listing text (drafts)

**App name:** Scheduling Pilot
**Subtitle (iOS, ≤30 characters):** Staff schedules & time clock
**Short description (Play, ≤80 characters):** Employee schedules, time clock, shift trades and time off for your team.

**Full description:**

> Scheduling Pilot keeps your team's week in one place: the schedule, the time
> clock, shift trades and time off.
>
> For employees
> • See your upcoming shifts and your team's schedule
> • Clock in and out, with breaks, from your phone
> • Request time off and trade shifts with coworkers
> • Get messages from your managers
> • Night mode, and English or Spanish
>
> For managers and owners
> • Build and publish schedules, and reuse templates
> • Approve time off, shift trades and punch corrections
> • Review timecards and export CSV or PDF reports
> • Set a worksite and an optional geofence for the time clock
> • See who's in right now
>
> Scheduling Pilot works with your company's existing account. Sign in with
> the details your employer gave you, or create a company account.

(Before using any line above, check that the feature is included in the
plans you sell. Don't list features that are locked for most users without
saying so.)

**Keywords (iOS, ≤100 characters):** schedule,shift,employee,time clock,timesheet,roster,staff,workforce,time off,punch

**Category:** Business (both stores). **Age rating:** 4+ / Everyone. User messaging is between members of a company; answer the questionnaires honestly about user-to-user communication.

**Release notes (1.0.0):** "First release of Scheduling Pilot for Android and iPhone: schedules, time clock, shift trades, time off, timecards and messages for your team."

## 9. Screenshots and graphics

Take them from the demo company on real devices or simulators. Don't use
mock-ups that show features the app lacks.

| Store | Required |
| --- | --- |
| Apple | **iPhone 6.9"**: 1320×2868 or 1290×2796 (portrait), 3–10 images. **iPad 13"**: 2064×2752 or 2048×2732. Required because the app runs on iPad |
| Google Play | App icon 512×512 PNG. Feature graphic 1024×500. Phone screenshots: at least 2, sides 320–3840 px, 9:16. 7" and 10" tablet screenshots: recommended, since the app supports tablets |

Suggested set: dashboard, schedule (week view), time clock, timecard, time
off / shift trade, night mode.

## 10. Signing and versioning

- **Android:** upload key in a `.jks` outside the repo; passwords in the gitignored
  `android/keystore.properties`; Play App Signing holds the distribution key.
  `versionCode` +1 on every upload.
- **iOS:** automatic signing with the Valladolid NovaTech team. Build number +1 on every upload.
- Keep `versionName` (Android) and Version (iOS) the same for the same release.

## 11. Final pre-submission checklist

- [x] Account deletion option chosen (A) and UI built
- [x] Deletion migration applied in Studio and verified (2026-10-17)
- [ ] Deletion tested end to end with a throwaway account; website redeployed so /delete-account is live
- [ ] Privacy policy and support pages published; URLs in both consoles and in the app's Settings/About
- [ ] Demo company and two reviewer logins created and tested on a phone
- [ ] `bun run test`, `bun run typecheck`, `bun run build` and `bun run build:mobile` pass
- [ ] Push set up ([push-notifications.md](push-notifications.md)): `google-services.json` in the Android build, Push Notifications capability in Xcode, server variables set and redeployed, `push_devices` migration applied
- [ ] Tested on a real Android phone and a real iPhone: sign-in, Time clock (location prompt), CSV and PDF export (share sheet), night mode, back button (Android), offline screen, rotation on a tablet, a notification on the lock screen and tapping it
- [ ] Version numbers bumped on both platforms
- [ ] Data safety (Play) and App Privacy (Apple) filled in from sections 4–5
- [ ] Content rating questionnaires answered
- [ ] Screenshots taken from the real app
- [ ] Release notes written
- [ ] Internal test (Play) and TestFlight installs checked
- [ ] Final "Send for review" / "Submit" pressed **by you**
