# Shared clock-in: display mode and slideshow

Branch `feat/kiosk-slideshow`, cut from `feat/multi-company` (it needs that
branch's `company_memberships`, `has_role` and `current_company_id`).

## Applying the database change

1. Open Studio at supabase.schedulingpilot.com, then **SQL editor**.
2. Paste the whole of
   `supabase/migrations/20261123120000_kiosk_slideshow.sql` and run it.
   It must run after `20261122130000_multi_company_supervisor_scope.sql`.
   It is safe to run again.
3. Check that **Storage** now lists a public bucket named `kiosk-slides`.

Don't use the `supabase` CLI or MCP for this; they point at the old hosted
project.

The migration adds:

- `kiosk_settings`: one row per company with `display_mode` (`simple` or
  `slideshow`) and `idle_seconds` (5 to 3600). A company with no row gets
  `simple` and 30 seconds.
- `kiosk_slides`: the company's slides. Each is a picture or a message, with
  its own `duration_seconds` (2 to 300), a `position` and an `enabled` flag.
  Both tables are under RLS: only company admins (and super admins) can read
  or write them.
- `reorder_kiosk_slides(uuid[])`: sets the order in one call.
- `kiosk_display(_token)`: what the device reads. It is anonymous and checks
  the device token, like the other `kiosk_*` functions. It returns the mode,
  the idle timeout and only the slides that are switched on.
- The `kiosk-slides` bucket:
  - Read is public, because the device has no account.
  - Uploads are limited to 10 MB and to JPEG, PNG, WebP and GIF.
  - Only an admin of the company named by the path's first folder
    (`<company_id>/<file>`) can write. Storage requests don't carry
    `x-company-id`, so this is checked by `can_manage_kiosk_slide_object()`
    rather than by the selected company.

## How it behaves

- **Simple** is the unchanged keypad.
- **Slideshow**:
  - The slides cover the screen while nobody is using the device.
  - A touch, click, key, wheel or mouse move brings up the keypad. The tap
    that wakes the screen never presses a key under it.
  - After `idle_seconds` with no input, any half-typed code is cleared and the
    slideshow comes back. It never comes back while a punch is in flight.
- **Clock-ins are never blocked.**
  - Display settings load beside the keypad.
  - If they fail, or every picture fails to load, the device stays on the
    keypad.
  - Pictures are preloaded, and each one is shown only once it has loaded.
- Devices pick up changes every 5 minutes, or straight away on reload.

## Manual test plan

You need an admin account and a device link from **Shared clock-in**.

1. Apply the migration. Reload the app.
2. **Shared clock-in**: a new **Display** section shows, with **Simple**
   selected.
3. Open the device link in another window. It shows the keypad as before.
4. **Upload picture**: pick two images, one wide and one tall.
   - Both appear in the list with a thumbnail, 8 sec, Shown.
   - Try a PDF or a file over 10 MB. You get a clear error and nothing is
     added.
5. **Add message**: enter a title and some text, then press **Preview**.
   - The message shows full screen.
   - A click closes the preview and you're back in the dialog.
   - **Save**.
6. Use the arrows to move the message to the top. Reload the page; the order
   stays.
7. Set one picture to 3 sec. Switch the other off; it dims.
8. **Preview slideshow**: only the slides that are on play, in order, each for
   its own time. A click or Escape closes it.
9. Choose **Slideshow**, set the timeout to 10 and press **Save display**.
10. Reload the device window.
    - The slideshow plays full screen with the clock in the corner.
    - Rotate a tablet or resize the window. Pictures stay whole, with no
      cropping.
11. Tap the screen. The keypad shows, and that tap entered no digit.
12. Type two digits and wait 10 seconds. The slideshow returns, and the digits
    are cleared when you wake it again.
13. Wake the screen and clock someone in.
    - The confirmation shows in full.
    - About 10 seconds later the slideshow returns.
14. Switch every slide off and reload the device. It stays on the keypad.
15. Switch back to **Simple** and reload the device. It shows the keypad only.
16. Optional: sign in as a non-admin employee. Calls to
    `from("kiosk_slides").select()` return no rows, and uploads to
    `kiosk-slides` are refused.
17. Optional: switch to the Spanish language and check the new strings.
