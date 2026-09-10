import { createFileRoute } from "@tanstack/react-router";
import {
  CalendarRange,
  CalendarCheck,
  Wand2,
  AlertTriangle,
  Send,
  Copy,
  Network,
  BarChart3,
} from "lucide-react";
import { FeaturePage } from "@/components/marketing-feature-page";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/employee-scheduling")({
  head: () =>
    seo({
      title: "Employee Scheduling Software | Scheduling Pilot",
      description:
        "Build employee schedules on a drag-and-drop grid, auto-fill open shifts around availability and time off, catch conflicts before you publish, and send the schedule to your team.",
      path: "/employee-scheduling",
    }),
  component: EmployeeSchedulingPage,
});

function EmployeeSchedulingPage() {
  return (
    <FeaturePage
      h1="Employee Scheduling Software"
      lede="Scheduling Pilot replaces the spreadsheet and the group chat with one place where the work schedule is built, checked and published. Drag shifts onto a weekly grid, let the generator fill the gaps around who is actually available, and send the finished schedule to the whole team in a single action."
      sublede="It is built for teams that work in shifts — retail floors, clinics, restaurants, warehouses, security details and public-sector crews — where coverage matters more than headcount and a missed shift is a real problem."
      sections={[
        {
          heading: "Build the schedule the way that suits the week",
          intro:
            "Some weeks are a copy of the last one. Some need rebuilding from scratch. The schedule builder handles both without forcing you down one path.",
          blocks: [
            {
              icon: CalendarRange,
              title: "Weekly, two-week or month view",
              desc: "Drag shifts onto a weekly or two-week grid, or pull back to a month view to plan a season of coverage at a glance.",
            },
            {
              icon: Copy,
              title: "Copy forward",
              desc: "Duplicate a week you were happy with and adjust the exceptions, rather than rebuilding a stable roster line by line.",
            },
            {
              icon: Wand2,
              title: "Generate a draft",
              desc: "Let the generator fill open shifts around recorded availability, approved time off, weekly hour limits and who is qualified for each position.",
            },
            {
              icon: CalendarCheck,
              title: "Availability built in",
              desc: "Employees record the hours they can work in their own account, so the person building the schedule is never guessing.",
            },
            {
              icon: AlertTriangle,
              title: "Conflict warnings",
              desc: "Double-bookings, shifts that collide with approved leave and people over their weekly hour cap surface before the schedule goes out, not after.",
            },
            {
              icon: Send,
              title: "Draft, then publish",
              desc: "A schedule stays private while you work on it. Publishing is a deliberate action, and only then does the team see it.",
            },
          ],
        },
        {
          heading: "How a scheduling week runs",
          steps: [
            {
              title: "Set the shape of the work",
              desc: "Add departments, locations and named positions, then mark who is qualified for what and how many hours each person can take.",
            },
            {
              title: "Collect availability",
              desc: "Employees keep their own availability current and submit time-off requests, which land with an admin for approval.",
            },
            {
              title: "Build and check",
              desc: "Draft by hand or generate, then work through the conflict warnings until the week is clean.",
            },
            {
              title: "Publish and track",
              desc: "Publish to the team. From that point the schedule is what the time clock measures actual hours against.",
            },
          ],
        },
        {
          heading: "Scheduling that reflects how the company is organised",
          paragraphs: [
            "A schedule is only as good as the structure underneath it. Scheduling Pilot models departments, locations and positions as first-class things, so a shift is not just a block of time — it is a named position at a specific site, filled by someone qualified to work it.",
            "That structure is what makes automatic scheduling trustworthy. The generator will not put an unqualified employee on a specialist position, book someone who is on approved leave, or push a part-time employee past the weekly hours you set for them.",
            "Once the week is running, reports roll scheduled hours, coverage and cost up across any date range, with the underlying shifts listed so the totals can be checked rather than taken on faith.",
          ],
          blocks: [
            {
              icon: Network,
              title: "Departments, sites and positions",
              desc: "Model the company the way it actually works, including locations that each have their own geofence for clock-ins.",
            },
            {
              icon: BarChart3,
              title: "Reports you can audit",
              desc: "Scheduled hours, coverage and cost across a date range, with every contributing shift listed underneath the total.",
            },
          ],
        },
      ]}
      related={[
        {
          to: "/time-clock",
          label: "Employee time clock",
          blurb:
            "Measure what actually happened against the schedule you published, with geofenced clock-ins.",
        },
        {
          to: "/time-off-management",
          label: "Time-off management",
          blurb: "Approved leave is visible at the moment someone builds next week's schedule.",
        },
        {
          to: "/shift-trading",
          label: "Shift trading",
          blurb:
            "Let the team resolve their own coverage gaps, with an admin keeping the final say.",
        },
        {
          to: "/workforce-management",
          label: "Workforce management",
          blurb: "How scheduling, time tracking, leave and reporting fit together in one platform.",
        },
      ]}
      ctaHeading="Start building your first schedule"
      ctaBody="Create a company account, bring your team in with a join code, and publish a schedule this week."
    />
  );
}
