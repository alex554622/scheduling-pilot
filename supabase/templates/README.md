# Auth email templates

Branded replacements for Supabase's stock auth emails, so what reaches an
employee's inbox carries the Scheduling Pilot name and logo.

| File                  | Supabase template | Sent when                          |
| --------------------- | ----------------- | ---------------------------------- |
| `confirm-signup.html` | Confirm signup    | A new account needs email confirmed |
| `reset-password.html` | Reset password    | Someone uses "Forgot password?"     |
| `magic-link.html`     | Magic link        | Passwordless sign-in (unused today) |
| `invite.html`         | Invite user       | An admin invites someone by email   |
| `change-email.html`   | Change email      | Someone changes their sign-in email |

Subjects and file paths are wired up in `supabase/config.toml`.

## Applying them

**Local development** — nothing to do. `supabase start` reads `config.toml`.

**The hosted project** — either:

- `supabase config push`, if your CLI is new enough to support it; or
- Dashboard → **Authentication** → **Emails** → **Templates**, pick each
  template, and paste the file's contents into the message body (and the subject
  from `config.toml`).

## Two things the templates cannot fix

**1. The sender address.** Supabase's built-in email service always sends from
`noreply@mail.app.supabase.io` — no template can change that, and it is rate
limited to a handful of messages per hour, which makes it unsuitable for real
employees signing up. To send from your own domain, set up **Custom SMTP**:
Dashboard → **Project Settings** → **Authentication** → **SMTP Settings**, using
a provider such as Resend, Postmark, SendGrid, Mailgun or AWS SES. Set the
sender name to `Scheduling Pilot` there. Until that is done the body will be
branded but the "from" line will still say Supabase.

**2. The logo needs a public URL.** The templates load it from
`{{ .SiteURL }}/scheduling-pilot-logo.png`, which resolves against the Site URL
in Dashboard → **Authentication** → **URL Configuration**. That must point at
the deployed app, and the app must be publicly reachable — a `localhost` Site
URL will render a broken image in real inboxes. When images are blocked (Gmail
does this by default for unknown senders) the `alt` text is styled to read as
the wordmark, so the email still looks like ours.

`public/scheduling-pilot-logo.png` is 2172px wide and ~360 KB. It displays fine
at the 210px the template requests, but a ~600px web-optimised copy would be
kinder to mobile inboxes.

## Template variables

These are Go templates. Available in all of them:

- `{{ .ConfirmationURL }}` — the action link
- `{{ .Email }}` — the recipient
- `{{ .SiteURL }}` — the app's base URL
- `{{ .Token }}` / `{{ .TokenHash }}` — the six-digit OTP, if you prefer codes to links
- `{{ .Data }}` — the user's metadata; signup stores `full_name`, `first_name`
  and `last_name`, which is what the greeting uses
- `{{ .NewEmail }}` — change-email only

## Editing them

Email clients are stuck in about 2002: table layouts, inline styles, no
flexbox, no grid, no external stylesheets. Keep changes inside the existing
table structure and keep every style inline. The palette matches the app:

| Token        | Hex       |
| ------------ | --------- |
| Primary      | `#0066cd` |
| Foreground   | `#0b1c2c` |
| Muted text   | `#5b646f` |
| Border       | `#e0e5eb` |
| Page ground  | `#ecf3f8` |
