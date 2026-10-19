# Google Play: step by step

Decisions already made: **organization account** (Valladolid NovaTech),
**our own signing key** (the same one that signs the website APK), contact
**valladolidnovatech@gmail.com**, business in **California**.

Ready in the repo:

| What Play asks for | Where it is |
| --- | --- |
| Signed app bundle (`.aab`) | Every **Android release** run on GitHub (in the zip next to the APK) |
| Privacy policy URL | https://schedulingpilot.com/privacy (live after the next website Redeploy) |
| Account deletion URL | https://schedulingpilot.com/delete-account |
| App icon 512×512 | [store/play-icon-512.png](store/play-icon-512.png) |
| Feature graphic 1024×500 | [store/play-feature-graphic-1024x500.png](store/play-feature-graphic-1024x500.png) |
| Target API level | 36 (meets the current requirement) |

Still needed from you: the D-U-N-S number, the Play Console account,
screenshots taken on your phone, and a demo company for Google's reviewers.

---

## 1. Get a D-U-N-S number (free, can take a week or more, so start now)

Google needs it to verify an organization account.

1. Go to https://www.dnb.com/duns/get-a-duns.html and request a D-U-N-S
   number for **Valladolid NovaTech**, using exactly the legal name and address
   on your business registration.
2. Wait for the email with the number.

## 2. Create the Play Console account (US $25 once)

1. https://play.google.com/console/signup. Sign in with the Google account
   that will own the app (valladolidnovatech@gmail.com works well).
2. Choose **An organization or business**.
3. Enter the D-U-N-S number, the organization name and address (they must
   match D&B exactly), website `https://schedulingpilot.com`, contact email
   `valladolidnovatech@gmail.com`, and a phone number.
4. Pay the $25 fee and complete Google's identity verification. That can take
   a few days.

## 3. Create the app

Play Console → **Create app**:

| Field | Answer |
| --- | --- |
| App name | `Scheduling Pilot` |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | Free |
| Declarations | Tick both after reading them |

## 4. Store listing (Grow → Store presence → Main store listing)

| Field | Answer |
| --- | --- |
| App name | `Scheduling Pilot` |
| Short description (80) | `Employee schedules, time clock, shift trades and time off for your team.` |
| Full description | The text in [store-compliance.md](store-compliance.md), section 8 |
| App icon | `docs/mobile/store/play-icon-512.png` |
| Feature graphic | `docs/mobile/store/play-feature-graphic-1024x500.png` |
| Phone screenshots | At least 2, ideally 4–6, taken on your phone (see below) |
| Tablet screenshots | Optional. Add them if you have a tablet |

**Screenshots:** sign in to the demo company (step 6) in the installed app and
take screenshots on your phone (Power + Volume down) of the dashboard, the
schedule, the time clock, a timecard, time off and night mode. Use only demo
data, never real employees' names.

**Store settings** (Grow → Store presence → Store settings): category
**Business**; contact email `valladolidnovatech@gmail.com`; website
`https://schedulingpilot.com`.

## 5. App content (Policy → App content)

| Section | Answer |
| --- | --- |
| Privacy policy | `https://schedulingpilot.com/privacy` |
| App access | **All or some functionality is restricted** → add the demo login (step 6) with the note from store-compliance.md section 6 |
| Ads | **No**, the app has no ads |
| Content rating | Start questionnaire → category **All other app types**. Answer **No** to violence, sexual content, profanity, drugs, gambling. **Users can interact or exchange content: Yes** (company messages). **Shares user's location with other users: Yes** (admins see where punches happened). **Digital purchases: No** |
| Target audience | **18 and over** |
| News app | No |
| COVID-19 contact tracing | No |
| Data safety | Below |
| Government app | No |
| Financial features | No financial features |
| Health | No health features |
| Account deletion | In-app (Settings → Delete account), plus web URL `https://schedulingpilot.com/delete-account` |

### Data safety answers

- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data encrypted in transit? **Yes**
- Which account creation methods? **Username and password**
- Do you provide a way for users to request deletion? **Yes**
  (`https://schedulingpilot.com/delete-account`)

Data types. For each: **Collected: yes. Shared: no. Processed ephemerally:
no. Required.** Purposes: **App functionality, Account management.**

| Category | Type |
| --- | --- |
| Personal info | Name · Email address · User IDs |
| Location | Approximate location · Precise location |
| Messages | Other in-app messages |
| App activity | Other user-generated content (schedules, time punches, time off) |

If you later switch on Android push notifications (Firebase), also add
**Device or other IDs** (purpose: App functionality).

## 6. Demo company for Google's reviewers

On the live site, create a company called for example "Demo Bakery" with one
**admin** and one **employee** login, using email addresses you control.
Add a few shifts, a timecard and a message, and turn the time clock's geofence
**off**. Put both logins in **App access**. Keep these accounts working for as
long as the app is listed.

## 7. Signing: use our own key (do this before the first upload)

Play Console → your app → **Test and release → App integrity → App signing**
(it may also appear when you create the first release):

1. Choose **Use a different key** (sometimes labelled "Export and upload a key
   from Java keystore").
2. Download the two files Play offers, **pepk.jar** and the **encryption
   public key**, into `Documents\scheduling-pilot-keys\`.
3. In a terminal in that folder, run the command Play shows. It looks like
   this (Java is already installed):

   ```bash
   java -jar pepk.jar --keystore=scheduling-pilot-release.keystore --alias=schedulingpilot --output=output.zip --include-cert --rsa-aes-encryption --encryption-key-path=encryption_public_key.pem
   ```

   Type the key password when asked.
4. Upload the generated **output.zip** in Play Console and save.

The same key then signs every Play update and every website APK, so the two
versions can update each other.

## 8. First upload: internal testing

1. GitHub → **Actions → Android release → Run workflow** (leave the boxes empty).
2. Download the zip from the finished run. Inside is
   `scheduling-pilot-1.0.N.aab`.
3. Play Console → **Test and release → Testing → Internal testing → Create new
   release** → upload the `.aab` → release name `1.0.N` → release notes, for example
   "First release of Scheduling Pilot for Android." → **Save → Review release →
   Start rollout to Internal testing**.
4. **Testers** tab → create an email list with your own Google account → copy
   the opt-in link, open it on your phone, and install from Play.

## 9. Production

When internal testing looks good, go to **Production → Create new release** and
promote the same release (or upload a newer `.aab`), then **Send for review**.
The first review usually takes from a few days to a week. Nothing goes public
until you press the final button.

## Every update after that

Run the workflow again (the version goes up automatically), then upload the
new `.aab` to Play and the new `.apk` and `latest.json` to the website bucket.
Both come from the same zip.
