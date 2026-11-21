# Multi-company memberships

One account can belong to several companies. Each membership has its own role,
department, position, hours limit, employee code and clock-in code. The person
picks the company they are working in from the header. The database enforces
that choice on every request.

## How it works

- **`company_memberships`** has one row per person per company, with status
  `active`, `suspended`, `revoked` or `left`. It is never deleted, so removing
  someone keeps their history and their account.
- **`company_join_requests`**: entering a company code only creates a request.
  An admin of that company approves it (and sets the role, department and
  position) or declines it.
- **The selected company** travels on every REST call as the `x-company-id`
  header (see `src/integrations/supabase/client.ts`).
  - `current_company_id()` trusts that header only if the caller has an active
    membership in that company. Otherwise it returns null and the request sees
    nothing; there is no silent fallback to another company.
  - With no header (realtime, edge functions, old clients),
    `current_company_id()` uses `profiles.company_id`, which `switch_company()`
    keeps up to date.
- **`has_role(uid, role, company)`** needs an active membership. For the
  caller's own checks, the company must also be the selected one. Suspending or
  removing someone therefore takes effect on their next request.
- **Profile columns** (`profiles.department_id`, `position`, `max_weekly_hours`,
  …) mirror the selected company's membership, so code that still reads the
  profile keeps working. New code should read the **`company_members`** view.
  It is the roster of the selected company and is writable by its admins.
- **Notifications** carry `company_id`. The bell shows only the selected
  company's notifications plus account-wide ones (membership decisions). The
  switcher shows unread counts for the other companies.
- **Audit:** approvals, rejections, role changes, suspensions, reinstatements,
  removals, leaving and join-code changes are written to `audit_logs`
  (`entity_type = 'membership'`), and the person is notified.
- **Code lookups** are rate-limited per account: 10 per 10 minutes, and 20
  misses per day. Every attempt is recorded in `company_code_attempts`.
- **Leaving** is refused in three cases:
  - the person is the company's last active admin;
  - the person is clocked in there;
  - the company has turned off "Members can leave on their own".

## Applying the migrations

The production database is the self-hosted Supabase at
`supabase.schedulingpilot.com`. **Do not use `supabase db push` or the Supabase
MCP tools**: both are linked to the old hosted project. Paste each file into
Studio → SQL editor and run it, in this order:

1. `20261121120000_supervisor_departments.sql`, from the supervisors branch,
   if it isn't applied yet. The second multi-company file needs it.
2. `supabase/migrations/20261122120000_multi_company_memberships.sql`
   - It ends with a summary row: memberships, revoked memberships, pending
     requests, and profiles left without a membership. The last value should
     be 0.
   - It runs in one transaction; if anything fails, nothing is changed.
   - It needs `20261120180000_punch_without_gps.sql`, which is already on main.
3. `supabase/migrations/20261122130000_multi_company_supervisor_scope.sql`
   - Without it, a supervisor in company A could still reach a shared
     employee's punches in company B. Run it right after step 2.
4. In Coolify, click **Redeploy** for the web app. Pushing does not deploy.
5. Run `supabase/tests/multi_company_isolation.sql` in the SQL editor. It
   creates throwaway companies and accounts and rolls everything back at the
   end. It should finish with `multi-company checks passed`.

Until the redeploy, the app that is live now keeps working:

- `join_company_by_code`, `approve_membership` and `reject_membership` still
  exist as wrappers.
- `profiles.pending_company_id` is still filled in for pending requests.
- The profile columns are mirrored.

The one deliberate break is `join_company(uuid)`. It now refuses, because it
let anyone join any company without approval.

The data already there is kept:

- Every profile with a company becomes an active membership with its current
  department, position and hours.
- People who were removed earlier become `revoked` memberships, so rehiring
  them still works.
- Every pending `pending_company_id` becomes a pending request.

## Manual test plan

You need three companies (A, B, C) and these accounts:

| Account | A | B | C |
|---|---|---|---|
| Admin A | admin | – | – |
| Admin B | – | admin | – |
| Pat | employee | employee | – |
| Sam | – | – | – |

Admin C is Admin B or a separate account.

### Joining

1. Admin C opens **Employees → Membership requests** and copies the company code.
2. Sam opens **Settings → My companies** and enters a wrong code. The page says
   the code is not valid. Sam enters the right code, sees "MC C", adds a
   message and sends the request.
   - "Your join requests" shows the request as *Waiting for approval*.
   - Sam still has no access to C.
3. Sam cancels the request. It shows *Cancelled*. Sam sends it again.
4. Admin A opens their own Membership requests page. Sam's request to C must
   not appear there.
5. Admin C approves the request as Employee in a department.
   - Sam gets a notification.
   - Sam's switcher now lists C. Sam lands in C after switching, or after the
     next reload if C is Sam's only company.
6. Enter a wrong code 11 times. The next attempt shows "Too many code
   attempts", even with the right code.
7. Admin C turns off **Accept join requests**. The code is then refused. Turn
   it back on.

### Switching and isolation

8. Pat signs in, opens the header menu, and sees A and B with "Employee" and
   unread counts.
9. In A, Pat sees only A on every screen: schedule, time card, time off,
   messages, availability, notifications. Pat switches to B.
   - The page goes to the dashboard and shows only B; no A data flashes up.
   - Use the browser back button on a page opened in A. It must show B data
     or nothing.
10. Reload the page. Pat stays in B, the last company used on this device.
11. Admin A creates and publishes a shift for Pat in A while Pat is in B.
    - Pat gets no pop-up.
    - A dot and an unread count appear on A in the switcher.
    - Switch to A: the notification is there.
12. Pat clocks in while in A, switches to B, and clocks in there.
    - The two punches are independent.
    - B's time card shows only the B punch.
    - Clock-in codes (shared clock-in) are separate per company.
13. Admin A's switcher lists only A. Admin A must never see Pat's B shifts,
    time cards, time off or availability. Check the Employees page, the
    reports and the audit log.

### Roles

14. Admin A changes Pat's role in A to Admin.
    - Pat's role in B stays Employee.
    - Pat gets admin screens in A and only employee screens after switching to
      B.
    - The change is in A's audit log.
15. Admin A tries to make themselves Employee while they are the only admin.
    This is refused.
16. As an employee, Pat cannot reach Employees → Membership requests; it
    redirects. The RPCs refuse too: see the SQL test, section 3.

### Suspend, remove, leave: immediate loss of access

17. Pat has A open in one tab. Admin A clicks **Suspend** on Pat.
    - In Pat's tab, the next action or load fails right away; it doesn't wait
      for a sign-out.
    - Within a minute, or on returning to the tab, Pat is moved to B and A
      shows as *Suspended* in the switcher.
    - B keeps working throughout.
18. Admin A reinstates Pat from the *Suspended* card. A comes back for Pat.
19. Admin A removes Pat from A.
    - Pat loses A at once.
    - Pat's account and B are untouched.
    - Pat appears under former members in A, and Rehire works.
20. Pat (in B) clicks **Leave** on B while clocked in. This is refused. Pat
    clocks out and tries again. If B has "Members can leave on their own"
    turned off, it is refused with that reason. Otherwise Pat leaves and is
    left with no company.
21. Pat sends a new request to B. Admin B approves it. Pat comes back with
    their old history.

### Phone layout

22. Repeat 2, 8 and 9 at phone width (375 px):
    - the switcher fits the header and long company names are cut off;
    - Settings → My companies and the Membership requests list stack
      vertically;
    - the approve dialog fits on the screen.

### Spanish

23. Switch the language to Spanish and look at the switcher, My companies and
    Membership requests. Messages the server sends back, such as the rate-limit
    text, are still in English.
