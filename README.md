# Scheduling Pilot SaaS

Create a complete SaaS web application for employee scheduling that companies can subscribe to monthly.

APP NAME: Scheduling Pilot

 SaaS

MAIN GOAL:

Build a scheduling system where each company has its own private account, employees, supervisors, schedules, shift trades, approvals, and reports. This must be a multi-tenant SaaS system, meaning each company’s data must be separated and protected from other companies.

TECH STACK:

Use React / Next.js for frontend.

Use Supabase for backend, authentication, database, storage, and Row Level Security.

Use Stripe for monthly subscription billing.

Make the app mobile-friendly and desktop-friendly.

MAIN USER ROLES:

1. Super Admin

- Controls the entire SaaS platform.

- Can see all companies.

- Can activate, suspend, or delete company accounts.

- Can manage subscription plans.

- Can view system analytics.

2. Company Admin

- Owns one company account.

- Can add supervisors and employees.

- Can create departments, locations, job positions, and shift templates.

- Can manage company settings.

- Can view payroll/export reports.

3. Supervisor

- Can create schedules for employees.

- Can create shifts by day, week, month, or full year.

- Can approve or deny shift trade requests.

- Can approve time-off requests.

- Can edit assigned shifts.

- Can see employee availability.

4. Employee

- Can log in to see their schedule.

- Can request time off.

- Can request to trade shifts with another employee.

- Can accept or reject trade offers.

- Can receive notifications when schedule changes.

- Can update their availability.

CORE FEATURES:

1. Multi-Tenant Company Accounts

- Each company has its own company_id.

- Every user, employee, schedule, shift, trade request, and report must belong to one company_id.

- Users from one company must never see data from another company.

- Use Supabase Row Level Security for data protection.

2. Authentication

- Email and password login.

- Role-based access control.

- Secure password reset.

- Invite users by email.

- New company signup flow.

- Optional 2FA-ready structure.

3. Company Dashboard

Create a dashboard for each company showing:

- Today’s scheduled employees.

- Open shifts.

- Pending trade requests.

- Pending time-off requests.

- Weekly labor hours.

- Schedule conflicts.

- Notifications.

4. Schedule Builder

Create a clean calendar-style schedule builder.

Allow supervisors to:

- Create shifts for one day.

- Copy shifts to the whole week.

- Copy weekly schedule to the month.

- Generate schedules for the full year.

- Drag and drop employees into shifts.

- Use shift templates.

- Filter by department, position, location, or employee.

- See conflicts before publishing.

5. Smart Scheduling Algorithm

Create an intelligent scheduling engine that:

- Checks employee availability.

- Prevents double-booking.

- Prevents scheduling outside availability.

- Warns when employees exceed max weekly hours.

- Distributes shifts fairly.

- Prioritizes required positions per shift.

- Checks approved time off.

- Detects understaffed shifts.

- Detects overtime risk.

- Allows supervisor override with warning.

- Supports recurring shifts.

- Supports rotating schedules.

- Supports weekends, holidays, and custom blackout days.

6. Shift Trade System

Employees can:

- Request to trade a shift.

- Select another employee.

- Add a reason.

- See trade status.

The other employee can:

- Accept or decline the trade.

Supervisor can:

- Approve or deny the trade.

- See if the trade creates overtime, conflict, or staffing issues.

Trade status:

- Pending employee acceptance.

- Pending supervisor approval.

- Approved.

- Denied.

- Canceled.

7. Time-Off Requests

Employees can request:

- Vacation.

- Sick time.

- Personal time.

- Unpaid time.

Supervisors can:

- Approve or deny.

- Add notes.

- See how the request affects staffing.

8. Notifications

Create notification system for:

- New schedule published.

- Shift changed.

- Trade request received.

- Trade approved or denied.

- Time-off approved or denied.

- Open shift available.

Use in-app notifications first. Structure the system so email/SMS can be added later.

9. Reports

Create reports for:

- Weekly labor hours.

- Employee scheduled hours.

- Overtime risk.

- Open shifts.

- Approved time off.

- Shift trade history.

- Department coverage.

- Export to CSV and PDF.

10. Subscription Billing

Use Stripe.

Plans:

- Basic: up to 25 employees.

- Pro: up to 100 employees.

- Enterprise: unlimited employees.

If subscription is inactive:

- Company cannot create new schedules.

- Employees can still view existing schedules.

- Company admin sees billing warning.

DATABASE TABLES:

Create tables for:

- companies

- users

- company_members

- roles

- departments

- locations

- positions

- employees

- employee_availability

- shift_templates

- shifts

- schedules

- time_off_requests

- shift_trade_requests

- notifications

- subscription_plans

- company_subscriptions

- audit_logs

SECURITY REQUIREMENTS:

- Use Row Level Security on every table.

- Every table must include company_id when applicable.

- Users can only access records for their company.

- Employees can only view their own schedule unless given higher role.

- Supervisors can only manage employees in their assigned company.

- Company admins can manage only their company.

- Super admins can manage platform-wide data.

- Validate all role permissions on backend, not just frontend.

- Add audit logs for schedule edits, approvals, user changes, and billing changes.

- Protect against SQL injection, XSS, CSRF, IDOR, and privilege escalation.

- Never expose service role keys to the frontend.

- Use environment variables for secrets.

- Add secure error handling.

UI/UX DESIGN STYLE:

Design the app like a modern professional SaaS dashboard.

Use:

- Clean white background.

- Blue, green, and gray professional color palette.

- Rounded cards.

- Simple icons.

- Mobile-first layout.

- Calendar view.

- Table view.

- Drag-and-drop schedule builder.

- Clear status badges.

- Easy navigation sidebar.

MAIN PAGES:

1. Landing page

2. Pricing page

3. Company signup page

4. Login page

5. Super admin dashboard

6. Company dashboard

7. Employee management page

8. Department/location/position setup page

9. Schedule builder page

10. Employee schedule page

11. Shift trade page

12. Time-off request page

13. Reports page

14. Billing page

15. Settings page

16. Audit log page

IMPORTANT LOGIC:

When creating a shift, check:

- Employee belongs to the same company.

- Employee is active.

- Employee is available.

- Employee is not already scheduled.

- Employee is not on approved time off.

- Employee has the required position.

- Employee does not exceed max weekly hours.

- Shift does not create overtime unless supervisor confirms override.

When trading a shift, check:

- Both employees belong to the same company.

- Both employees are active.

- Receiving employee is qualified.

- Receiving employee is available.

- Receiving employee does not exceed max weekly hours.

- Supervisor must approve final change.

DELIVERABLE:

Generate the complete application with:

- Database schema.

- Supabase RLS policies.

- Authentication.

- Role permissions.

- Modern UI.

- Schedule builder.

- Shift trade workflow.

- Time-off workflow.

- Reports.

- Stripe subscription structure.

- Clean, scalable code.

- Comments explaining important security and scheduling logic.

Make the app production-ready, secure, scalable, and easy for non-technical company supervisors to use.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/b5a823a3-2642-447a-b1ba-f692abe65862).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
