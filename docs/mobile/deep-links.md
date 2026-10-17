# Opening schedulingpilot.com links in the app

Optional for launch. Without it, every link opens the website in the
browser, which still works.

## What's already in place

- `src/lib/native/bootstrap.ts` handles links the OS hands to the app. It opens
  the matching page, and if the link carries a Supabase session in its
  `#fragment` (sign-up confirmation, password reset), it signs the person in first.
- Android: `AndroidManifest.xml` declares an App Links filter (`autoVerify`)
  for `https://schedulingpilot.com` paths `/reset-password`, `/join`,
  `/dashboard` and `/clock/`. It stays inactive until step 1 below is live.
- Links the app creates (invitations, email redirects, shared clock-in) always
  point to `https://schedulingpilot.com` (`shareableOrigin()`).

## 1. Android: assetlinks.json

After the first upload to Play Console, copy the **SHA-256** fingerprints from
**Setup → App signing**: the *app signing key* and your *upload key*. Then
publish this at `https://schedulingpilot.com/.well-known/assetlinks.json`, by
creating `public/.well-known/assetlinks.json` and redeploying the website:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.schedulingpilot.app",
      "sha256_cert_fingerprints": ["<APP SIGNING KEY SHA-256>", "<UPLOAD KEY SHA-256>"]
    }
  }
]
```

It must be served as `application/json`, with no redirect.

## 2. iOS: apple-app-site-association

In Xcode, add the **Associated Domains** capability with
`applinks:schedulingpilot.com`. Then publish
`https://schedulingpilot.com/.well-known/apple-app-site-association` (no file
extension, `application/json`):

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAM_ID>.com.schedulingpilot.app"],
        "components": [
          { "/": "/reset-password*" },
          { "/": "/join*" },
          { "/": "/dashboard*" },
          { "/": "/clock/*" }
        ]
      }
    ]
  }
}
```

`<TEAM_ID>` is on the Apple Developer membership page.

## 3. Auth emails: a known limitation

Supabase's emails link to `supabase.schedulingpilot.com/auth/v1/verify?…`,
which then **redirects** to schedulingpilot.com. Android and iOS generally
don't hand a redirect over to an app, so those emails open in the browser even
with steps 1–2 done. That's fine: confirming and resetting a password work
on the website, and the person then signs in to the app.

To make them open the app directly, change the email templates in the
self-hosted Supabase so they link straight to
`https://schedulingpilot.com/reset-password?token_hash={{ .TokenHash }}&type=recovery`
(and the equivalent for sign-up). The pages would then call
`supabase.auth.verifyOtp({ token_hash, type })`. That's a change to the
website's auth pages and to the Supabase server configuration, so it's a
separate task.

Direct links (`/join?token=…` invitations, `/clock/…`) are not affected by
this limitation, and will open the app once steps 1–2 are done.
