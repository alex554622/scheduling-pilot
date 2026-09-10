import { createFileRoute } from "@tanstack/react-router";
import {
  Network,
  BarChart3,
  ScrollText,
  ShieldCheck,
  Users,
  CalendarRange,
  Clock,
  Building2,
} from "lucide-react";
import { FeaturePage } from "@/components/marketing-feature-page";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/workforce-management")({
  head: () =>
    seo({
      title: "Workforce Management Software | Scheduling Pilot",
      description:
        "Run scheduling, time tracking, leave and reporting for a shift-based team from one platform, with departments, locations, positions and role-based access built in.",
      path: "/workforce-management",
    }),
  component: WorkforceManagementPage,
});

function WorkforceManagementPage() {
  return (
    <FeaturePage
      h1="Workforce Management Software"
      lede="Scheduling, attendance, leave and reporting for shift-based teams, in one platform rather than four that have to be reconciled. The roster, the hours worked against it and the reports drawn from both share the same data."
      sublede="Most of the pain in managing a shift workforce comes from the seams between systems. Scheduling Pilot's approach is to remove the seams rather than to integrate across them."
      sections={[
        {
          heading: "One platform, four jobs",
          intro:
            "Each of these is useful alone. Together they mean a change in one place is immediately true everywhere else.",
          blocks: [
            {
              icon: CalendarRange,
              title: "Scheduling",
              desc: "Build weekly, two-week or monthly rosters by hand or by generator, check conflicts, and publish to the team.",
            },
            {
              icon: Clock,
              title: "Time and attendance",
              desc: "Geofenced clock-ins from a phone, break tracking, and timecards that roll up for the pay period.",
            },
            {
              icon: Users,
              title: "Leave and availability",
              desc: "Employees keep their availability current and request time off; approvals feed straight back into scheduling.",
            },
            {
              icon: BarChart3,
              title: "Reporting",
              desc: "Scheduled hours, coverage and cost across any date range, with the underlying shifts listed so totals can be verified.",
            },
          ],
        },
        {
          heading: "Structure that matches the organisation",
          intro:
            "A workforce system that only understands a flat list of employees stops being useful the moment a company has two sites.",
          blocks: [
            {
              icon: Network,
              title: "Departments",
              desc: "Group the team the way the business is actually run, and let administrators work within their own area.",
            },
            {
              icon: Building2,
              title: "Locations with geofences",
              desc: "Each site carries its own coordinates and radius, so clock-ins are measured against the right place.",
            },
            {
              icon: Users,
              title: "Positions and qualifications",
              desc: "Named positions with a record of who is qualified for each, which is what makes automatic scheduling safe.",
            },
            {
              icon: ShieldCheck,
              title: "Roles and isolation",
              desc: "Company admins, employees and platform administrators each see only what their role warrants, enforced in the database.",
            },
          ],
        },
        {
          heading: "Built to be checked",
          paragraphs: [
            "Workforce records end up in disputes about pay and hours more often than most software does, so Scheduling Pilot is built on the assumption that its records will one day be questioned. Punch corrections require a written reason. Schedule publishing, shift trades and leave decisions are all recorded with who did them and when.",
            "Separation of companies is enforced at the database level with row-level security rather than by filtering in the interface, so one company's data is not reachable from another's account even if the front end were wrong.",
            "Reports are designed the same way: every figure can be expanded into the shifts that produced it, so a total is something to be verified rather than trusted.",
          ],
          blocks: [
            {
              icon: ScrollText,
              title: "Audit log",
              desc: "A record of who changed what and when, so a disputed schedule or timecard has a documented answer.",
            },
            {
              icon: ShieldCheck,
              title: "Per-company isolation",
              desc: "Row-level security in the database, not just a filter in the interface.",
            },
          ],
        },
      ]}
      related={[
        {
          to: "/employee-scheduling",
          label: "Employee scheduling software",
          blurb: "The roster at the centre of everything else.",
        },
        {
          to: "/time-clock",
          label: "Employee time clock",
          blurb: "Geofenced attendance and timecards for the pay period.",
        },
        {
          to: "/time-off-management",
          label: "Time-off management",
          blurb: "Leave requests that feed straight back into the schedule.",
        },
        {
          to: "/shift-trading",
          label: "Shift trading",
          blurb: "Employee-led cover with administrator approval.",
        },
      ]}
      ctaHeading="Run the whole thing from one place"
      ctaBody="Create a company account, set up your departments and sites, and bring the team in with a join code."
    />
  );
}
