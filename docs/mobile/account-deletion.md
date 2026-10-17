# Account deletion

**Decision (2026-10-17): option A, full delete.** This is the same deletion the
platform admin's Delete button already does.

## Why it's needed

- **Apple, guideline 5.1.1(v):** an app that lets people sign up must let them
  start deleting their account inside the app.
- **Google Play, User Data policy:** the same in-app path, plus a public web
  page for people who don't have the app installed. The URL goes in
  Play Console → App content → Data deletion.

## What's built

| Piece | Where |
| --- | --- |
| Database function `delete_my_account()` | `supabase/migrations/20261017120000_delete_my_account.sql` |
| **Delete account** card at the bottom of Settings (website and apps). The person types DELETE to confirm, then the function is called, the device is signed out, and the confirmation page opens | `src/components/delete-account.tsx`, `src/routes/_authenticated/settings.tsx` |
| Public page **https://schedulingpilot.com/delete-account**: how to delete, the deletion card if signed in, a support email if you can't sign in, and the confirmation after deleting | `src/routes/delete-account.tsx` |

If the function isn't on the server yet, the card says so and points to the
support email instead of showing a database error.

## What deleting removes

`delete from auth.users`, which through `on delete cascade` removes the
person's profile, roles, **shifts, time punches**, time-off requests,
availability, shift trades, employment-separation records, the company
messages they wrote, and push subscriptions. Rows that only record who did
something (audit log, schedules, invoices, templates, kiosk devices) stay, with
the person's ID cleared.

The card tells people this, and suggests downloading their timecards as PDF first.

## Guard rails

- The last platform admin can't delete themselves.
- The only company admin of a company that still has other members has to make
  someone else an admin first. The old `supervisor` role counts as an admin.

**Applied to production on 2026-10-17** (Studio SQL editor). Checked: owned
by `postgres` and `security definer`, the same as `admin_delete_user`;
executable by `authenticated`, not by `anon`.

## Applying it (manual: the Supabase CLI can't reach the self-hosted database)

1. Open the self-hosted Supabase Studio → **SQL Editor**.
2. Paste the whole of `supabase/migrations/20261017120000_delete_my_account.sql` and run it.
3. Check it's there:

   ```sql
   select proname, prosecdef from pg_proc where proname = 'delete_my_account';
   select grantee, privilege_type from information_schema.routine_privileges
    where routine_name = 'delete_my_account';
   ```

   You should see one row with `prosecdef = true`, and `EXECUTE` granted to
   `authenticated` (and not to `anon`).
4. Test with a throwaway employee account: Settings → Delete account. Then
   check that account no longer appears under Accounts.

The website and the apps both need a release containing this code for the
card and page to appear (Coolify Redeploy for the website).

## Before you publish

- Confirm **support@schedulingpilot.com** is a mailbox someone reads. The
  page and the error message promise people can email it.
