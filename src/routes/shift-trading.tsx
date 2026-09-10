import { createFileRoute } from "@tanstack/react-router";
import {
  RefreshCw,
  Handshake,
  ShieldCheck,
  Bell,
  ScrollText,
  UserCheck,
  CalendarRange,
  AlertTriangle,
} from "lucide-react";
import { FeaturePage } from "@/components/marketing-feature-page";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/shift-trading")({
  head: () =>
    seo({
      title: "Employee Shift Trading Software | Scheduling Pilot",
      description:
        "Let employees offer and pick up shifts between themselves, keep final approval with an administrator, and have the schedule reassign itself once a trade clears.",
      path: "/shift-trading",
    }),
  component: ShiftTradingPage,
});

function ShiftTradingPage() {
  return (
    <FeaturePage
      h1="Employee Shift Trading Software"
      lede="An employee offers a shift they cannot work, a teammate picks it up, and an administrator gives the final approval. Once the trade clears, the schedule reassigns the shift on its own."
      sublede="The team solves most coverage problems between themselves, and the manager stays in control of the outcome without having to broker every swap by phone."
      sections={[
        {
          heading: "Swaps that end in an updated schedule",
          intro:
            "The weak point of trading shifts by text message is that the published schedule never changes. Everyone remembers the swap until the week someone does not.",
          blocks: [
            {
              icon: Handshake,
              title: "Offer and accept",
              desc: "An employee puts a shift up. A qualified teammate accepts it. Both actions happen in the app, so there is a record of who agreed to what.",
            },
            {
              icon: ShieldCheck,
              title: "Admin has the final say",
              desc: "A trade is a request until an administrator approves it. Coverage decisions do not quietly leave management's hands.",
            },
            {
              icon: RefreshCw,
              title: "The shift reassigns itself",
              desc: "On approval the schedule updates. There is no second step where someone has to remember to edit the roster.",
            },
            {
              icon: AlertTriangle,
              title: "Checked before it clears",
              desc: "A trade that would double-book someone, collide with approved leave or push them past their hour limit surfaces as a conflict.",
            },
            {
              icon: Bell,
              title: "Everyone is told",
              desc: "The offering employee, the accepting employee and the admin all learn the outcome, so nobody works a shift that moved.",
            },
            {
              icon: ScrollText,
              title: "Kept on record",
              desc: "Who offered, who accepted and who approved is written down, which settles the argument when a shift is missed.",
            },
          ],
        },
        {
          heading: "How a trade clears",
          steps: [
            {
              title: "A shift is offered",
              desc: "An employee who cannot work a published shift offers it to the team rather than arranging cover privately.",
            },
            {
              title: "A teammate accepts",
              desc: "Someone qualified for the position picks it up. The trade becomes a pending request rather than a done deal.",
            },
            {
              title: "An admin reviews",
              desc: "The administrator sees the swap with its conflict warnings and either approves it or turns it down.",
            },
            {
              title: "The roster updates",
              desc: "Approval reassigns the shift, notifies both employees, and leaves the change in the audit log.",
            },
          ],
        },
        {
          heading: "Trading works because the schedule knows who can do the job",
          paragraphs: [
            "A shift swap is only safe if the person picking it up can actually work that position. Because Scheduling Pilot models positions and tracks which employees are qualified for each one, a trade is evaluated against the same rules that governed the original roster.",
            "The same is true of hours. Somebody who is already close to their weekly limit taking on an extra shift is exactly the kind of thing that produces an unexpected overtime bill, so it is flagged while the trade is still a request.",
            "The result is a process that gives employees real flexibility — the thing they most often want from a scheduling system — without giving up the coverage guarantees the business depends on.",
          ],
          blocks: [
            {
              icon: UserCheck,
              title: "Qualification aware",
              desc: "Only employees marked as qualified for the position are suitable candidates to take the shift on.",
            },
            {
              icon: CalendarRange,
              title: "Hours and leave respected",
              desc: "Weekly hour caps and approved time off are checked as part of the trade, not discovered afterwards.",
            },
          ],
        },
      ]}
      related={[
        {
          to: "/employee-scheduling",
          label: "Employee scheduling software",
          blurb: "The published schedule that trades update when they clear.",
        },
        {
          to: "/time-off-management",
          label: "Time-off management",
          blurb: "Approved absence is often what starts a trade in the first place.",
        },
        {
          to: "/time-clock",
          label: "Employee time clock",
          blurb: "Hours are recorded against whoever actually worked the shift.",
        },
        {
          to: "/workforce-management",
          label: "Workforce management",
          blurb: "Where trading sits in the wider picture of managing a shift-based team.",
        },
      ]}
      ctaHeading="Let the team sort out cover"
      ctaBody="Create a company account and give your employees a way to trade shifts that keeps the schedule honest."
    />
  );
}
