import { createFileRoute } from "@tanstack/react-router";
import {
  Clock,
  MapPin,
  Coffee,
  FileClock,
  UserCheck,
  ScrollText,
  Smartphone,
  ShieldCheck,
} from "lucide-react";
import { FeaturePage } from "@/components/marketing-feature-page";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/time-clock")({
  head: () =>
    seo({
      title: "Employee Time Clock Software | Scheduling Pilot",
      description:
        "Let staff clock in and out from their phone, record how far each punch was from the worksite, track breaks, and roll hours into timecards ready for payroll.",
      path: "/time-clock",
    }),
  component: TimeClockPage,
});

function TimeClockPage() {
  return (
    <FeaturePage
      h1="Employee Time Clock Software"
      lede="Staff clock in and out from the phone already in their pocket. Every punch records how far it was from the worksite, breaks are tracked as they happen, and the hours roll straight into timecards for the pay period."
      sublede="No hardware to buy, no terminal by the door, and no paper timesheet to decipher at the end of the fortnight."
      sections={[
        {
          heading: "A time clock that records what actually happened",
          intro:
            "The point of a time clock is not to catch people out. It is to end the argument about what the hours were, with a record both sides can look at.",
          blocks: [
            {
              icon: Smartphone,
              title: "Clock in from a phone",
              desc: "Employees start and end their shift from their own device. Nothing to install at the worksite and no queue at a shared terminal.",
            },
            {
              icon: MapPin,
              title: "Geofenced punches",
              desc: "Each location carries its own geofence. Punches record their distance from the site, so you can see at a glance which ones landed inside it.",
            },
            {
              icon: Coffee,
              title: "Breaks tracked properly",
              desc: "Breaks are punched in and out like shifts, so paid and unpaid time are separated in the record rather than estimated afterwards.",
            },
            {
              icon: UserCheck,
              title: "Who's in, live",
              desc: "See who is currently clocked in, who is on a break and who has not shown up for a shift that has already started.",
            },
            {
              icon: FileClock,
              title: "Timecards for the pay period",
              desc: "Hours roll up per employee across the pay period, ready to be reviewed and handed to whoever runs payroll.",
            },
            {
              icon: ScrollText,
              title: "Corrections stay on record",
              desc: "An admin can add or fix a punch, but every correction needs a written reason and is kept, so a disputed timecard has an answer.",
            },
          ],
        },
        {
          heading: "From punch to payroll",
          steps: [
            {
              title: "The shift starts",
              desc: "The employee clocks in from their phone. The punch is stamped with its time and its distance from the worksite.",
            },
            {
              title: "Breaks are punched",
              desc: "Break start and end are recorded as their own punches, keeping unpaid time out of the worked total.",
            },
            {
              title: "The admin reviews",
              desc: "Timecards show the period's hours per person. Anything odd — a missed clock-out, a punch well outside the fence — is visible for review.",
            },
            {
              title: "Corrections are logged",
              desc: "If a punch genuinely needs fixing, the admin records the correction with a reason. The original and the change both survive in the audit log.",
            },
          ],
        },
        {
          heading: "Why the audit trail matters",
          paragraphs: [
            "Time records are the evidence in any dispute about pay, and a system that lets an administrator silently rewrite history is worth very little when that dispute arrives. Scheduling Pilot treats every punch correction as an event in its own right: who changed it, when, and the reason they gave.",
            "The same applies to the schedule the hours are measured against. Publishing, trades and time-off approvals are all recorded, so the question of what someone was rostered to work has a documented answer rather than a recollection.",
            "None of this requires a separate system. The clock, the timecards and the schedule are the same platform, which is why the hours can be compared against the roster without exporting anything.",
          ],
          blocks: [
            {
              icon: ShieldCheck,
              title: "Role-based access",
              desc: "Employees see their own punches. Admins see their company's. Per-company isolation is enforced in the database itself.",
            },
            {
              icon: Clock,
              title: "Scheduled against actual",
              desc: "Because the roster and the clock live together, planned hours and worked hours can be read side by side.",
            },
          ],
        },
      ]}
      related={[
        {
          to: "/employee-scheduling",
          label: "Employee scheduling software",
          blurb: "Build and publish the schedule the time clock measures against.",
        },
        {
          to: "/time-off-management",
          label: "Time-off management",
          blurb: "Approved leave, holidays and sick days handled in the same place as the hours.",
        },
        {
          to: "/workforce-management",
          label: "Workforce management",
          blurb: "Scheduling, attendance, leave and reporting as one connected system.",
        },
        {
          to: "/shift-trading",
          label: "Shift trading",
          blurb: "When cover changes hands, the clock and the schedule stay in agreement.",
        },
      ]}
      ctaHeading="Put the timesheet away"
      ctaBody="Create a company account and have your team clocking in from their phones this week."
    />
  );
}
