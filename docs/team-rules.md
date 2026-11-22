# Team rules

Clock-in and timesheet rules for one team (department). A team only stores
the settings it changes. Everything else follows the company's App rules, as
it always has.

Edit them in **Settings → Team rules**. Company admins see every department.
A supervisor sees only the departments they supervise as a whole department,
meaning an assignment with no specific employee.

| Rule | Where it is enforced |
| --- | --- |
| Earliest clock-in (minutes before a published shift that day) | `clock_punch`, `kiosk_punch` refuse it |
| Mark late clock-ins against the schedule, and the grace period | worked out on read from published shifts (`src/lib/lateness.ts`, `punch_late_minutes()` in SQL), never stored. Shown on the time clock, the timecard, the tablet reply and the dashboard. The admins and the person's supervisors get a "Late clock-in" notification. Nothing is blocked. |
| Block punches outside the worksite radius | `clock_punch`, `break_punch`, `switch_location` |
| Require GPS to clock in | `clock_punch` refuses a Clock IN with no location, with no 7-day grace period. Clock OUT always works. |
| Allow the shared clock-in | `kiosk_state`, `kiosk_punch` turn the person away |
| Allowed break lengths 10 / 30 / 60 | `break_punch`, `kiosk_state`, `kiosk_punch` |
| Rounding, daily OT, daily double time, weekly OT | timecards (on screen, print, PDF), the dashboard's hours today, and the Reports over-hours flag (weekly threshold scaled to the range) |
| Require a note on edits | trigger on `time_punch_audit`, so it covers every `manager_*_punch` call and the range delete |

Every rule also has a company default in **Settings → App rules**. The
newer ones (earliest clock-in, require GPS, note on edits) start switched off
there and the shared clock-in starts allowed, so nothing changes until someone
changes them. Lateness uses the company's existing "Connect the schedule to
time cards" switch and grace period. A team can turn lateness on or off and set
its own grace, set its own earliest clock-in, or set it to **No limit** even
when the company has one.

The database merges the rules in `member_rules(user, company)`, which is
`companies.settings || department_rules.rules`. The frontend does the same
merge in `src/lib/team-rules.ts`.

## Apply

1. Open Studio at supabase.schedulingpilot.com, then go to **SQL editor → New query**.
2. Paste all of `supabase/migrations/20261128120000_team_rules.sql` and run it.
   - It depends on the supervisor, multi-company, GPS grace and schedule
     lateness migrations, which are already applied. It stops with an error
     naming what is missing if one isn't.
   - It can be run more than once. It replaces the earlier team-rules SQL
     (`20261124120000`): it drops the `late_minutes` column that one added and
     restores main's `clock_punch` GPS grace period and `kiosk_punch` late reply.
3. Check it worked:
   ```sql
   select count(*) from public.department_rules;                       -- 0, no error
   select column_name from information_schema.columns
    where table_name = 'time_punches' and column_name = 'late_minutes';  -- no rows
   ```
4. Then Redeploy in Coolify.

## Manual test plan

Use a department, say "Parking", with one test employee in it, and a second
employee who isn't in any department.

1. **Editor, as an admin.** Settings → Team rules → choose Parking.
   - Every field starts on the company setting.
   - Set some values and save. The team list then reads "Parking — N own rules".
   - "Use company rules for this team" removes them all again.
2. **Editor, as a supervisor.**
   - A supervisor of all of Parking gets the Team rules tab and sees only Parking.
   - A supervisor assigned only certain people in Parking gets no tab.
   - Run `insert into department_rules (department_id, rules) values ('<other dept>', '{}')`
     as that supervisor. RLS should refuse it.
3. **Earliest clock-in.**
   - Set it to 15 and publish a shift for the test employee that starts 1 hour from now.
   - Clock In is refused with "Too early… you can clock in from …". Check this in
     Spanish too.
   - The employee with no department, or one with no shift today, can still clock in.
4. **Lateness.**
   - Turn on "Mark late clock-ins against the schedule" for Parking with a
     5-minute grace, and publish a shift that started 20 minutes ago.
   - Clock in. The timecard shows "Late 20 min" on that IN, and on the printed or PDF card.
   - Clock out and back in during the same shift. The second IN isn't flagged.
5. **Require GPS.** Turn it on, then deny location in the browser. The time
   clock explains why, Clock In is disabled, and calling the RPC directly
   still fails. Someone already clocked in can still clock out.
6. **Shared clock-in.** Turn it off for Parking, then enter the test
   employee's code on the tablet. They get "Your team can't use the shared
   clock-in…". Someone outside Parking still works.
7. **Breaks.** Turn off 60 for Parking.
   - The time clock and the tablet offer only 10 and 30.
   - Other teams still get 60.
8. **Rounding and overtime.**
   - Set Parking to round to 15 and set daily OT to 6.
   - The timecard for the test employee rounds and splits by those numbers.
   - In the everyone view, each person's row uses their own team's numbers.
9. **Note on edits.** Turn it on.
   - Open a Parking employee's day editor. The note field says "required" and
     Save stays disabled until the note has text.
   - Clearing a period for Parking with no reason is refused.
   - Editing someone outside Parking still works with no note.
10. **Company defaults.**
    - In App rules, set the earliest clock-in to 10. The employee with no
      department is now held to it.
    - Set Parking's earliest clock-in to "No limit". Parking is no longer held to it.
11. **Late notification.** Clock in late as the test employee. Each company
    admin, and the supervisor of Parking, gets "Late clock-in" in the bell, in
    Spanish when the app is in Spanish. A supervisor of another team gets nothing.
12. **Dashboard and Reports.**
    - With Parking rounding to 15, today's hours on the dashboard match the timecard.
    - The dashboard row shows "Late N min".
    - In Reports, a Parking employee with weekly OT at 30 is flagged "Over 30h" for this week.

## Limits

- Late clock-ins are flagged and notified, but never blocked.
- The "Late clock-in" notification can't be muted per type in Settings, the
  same as "Clock-in without GPS". The master switch still mutes it.
