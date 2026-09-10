import { createFileRoute } from "@tanstack/react-router";
import {
  CalendarOff,
  Inbox,
  CalendarCheck,
  Bell,
  Wand2,
  ScrollText,
  Plane,
  Stethoscope,
} from "lucide-react";
import { FeaturePage } from "@/components/marketing-feature-page";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/time-off-management")({
  head: () =>
    seo({
      title: "Employee Time-Off Management Software | Scheduling Pilot",
      description:
        "Take vacation, sick and personal leave requests in one place, approve or decline them with the schedule in view, and keep approved days out of next week's roster automatically.",
      path: "/time-off-management",
    }),
  component: TimeOffPage,
});

function TimeOffPage() {
  return (
    <FeaturePage
      h1="Employee Time-Off Management Software"
      lede="Vacation, sick days and personal leave arrive as proper requests instead of texts, get approved or declined against the schedule they would affect, and then stay visible to whoever builds the roster next."
      sublede="The failure mode this fixes is a familiar one: leave approved in a conversation, forgotten by the time the schedule is written, and discovered on the morning of the shift."
      sections={[
        {
          heading: "Requests that do not get lost",
          intro:
            "Every request lands in the same queue, with the dates, the type of leave and whatever the employee wrote to explain it.",
          blocks: [
            {
              icon: Inbox,
              title: "One approval queue",
              desc: "Pending requests collect in a single list for the admin rather than scattering across inboxes and group chats.",
            },
            {
              icon: Plane,
              title: "Vacation and personal leave",
              desc: "Planned absence submitted ahead of time, so the schedule for those weeks is built with the gap already known.",
            },
            {
              icon: Stethoscope,
              title: "Sick days",
              desc: "Short-notice absence recorded in the same place, so the record of who was out and when is complete.",
            },
            {
              icon: CalendarCheck,
              title: "Approved leave blocks scheduling",
              desc: "Once approved, those days are visible at the moment someone builds the schedule — and the generator will not roster over them.",
            },
            {
              icon: Bell,
              title: "The employee is told",
              desc: "An approval or a decline reaches the person who asked, so nobody is left refreshing a page wondering.",
            },
            {
              icon: ScrollText,
              title: "A record that survives",
              desc: "Who approved what, and when, is kept — useful the following quarter when the decision is questioned.",
            },
          ],
        },
        {
          heading: "How a request travels",
          steps: [
            {
              title: "The employee asks",
              desc: "They pick the dates and the type of leave from their own account, and add a note if there is anything to explain.",
            },
            {
              title: "The admin sees it in context",
              desc: "The request sits alongside the schedule it would affect, so the decision accounts for coverage rather than being made blind.",
            },
            {
              title: "A decision is recorded",
              desc: "Approve or decline. Either way the employee is notified and the outcome is written down.",
            },
            {
              title: "The roster respects it",
              desc: "Approved days are excluded from scheduling automatically, both for hand-built weeks and generated ones.",
            },
          ],
        },
        {
          heading: "Leave and coverage are the same problem",
          paragraphs: [
            "Time off is usually treated as an HR process that happens somewhere else, and then quietly breaks the schedule. Keeping both in one platform removes the handoff where the information goes missing.",
            "Because approved leave is part of the same data the schedule builder reads, there is no synchronisation step and no window in which the roster is out of date. The person building next week's coverage sees the approved absence as an ordinary part of the grid.",
            "Where a gap does open up, the team can often close it themselves through shift trading, with an administrator keeping the final approval — so a single absence does not automatically become a management task.",
          ],
          blocks: [
            {
              icon: Wand2,
              title: "Automatic scheduling respects leave",
              desc: "The shift generator treats approved time off as unavailable, alongside recorded availability and weekly hour limits.",
            },
            {
              icon: CalendarOff,
              title: "Visible while planning",
              desc: "Absence shows up in the schedule view itself, not in a separate calendar someone has to remember to check.",
            },
          ],
        },
      ]}
      related={[
        {
          to: "/employee-scheduling",
          label: "Employee scheduling software",
          blurb: "Build the roster with approved leave already accounted for.",
        },
        {
          to: "/shift-trading",
          label: "Shift trading",
          blurb: "Let the team cover an approved absence between themselves.",
        },
        {
          to: "/time-clock",
          label: "Employee time clock",
          blurb: "Track the hours that were actually worked around the days that were taken.",
        },
        {
          to: "/workforce-management",
          label: "Workforce management",
          blurb: "See how leave fits with scheduling, attendance and reporting.",
        },
      ]}
      ctaHeading="Stop approving leave in a group chat"
      ctaBody="Create a company account and move time-off requests somewhere they will still exist next month."
    />
  );
}
