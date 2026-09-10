import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CalendarRange,
  RefreshCw,
  CalendarOff,
  CalendarCheck,
  Clock,
  FileClock,
  UserCheck,
  ShieldCheck,
  BarChart3,
  ScrollText,
  Network,
  Users,
  ArrowRight,
} from "lucide-react";
import { MarketingHeader } from "@/components/marketing-header";
import { APP_NAME, APP_TAGLINE } from "@/components/brand";
import { Decorations } from "@/components/showcase";
import { MarketingFooter } from "@/components/marketing-footer";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/about")({
  head: () =>
    seo({
      title: "About Scheduling Pilot | Employee Scheduling Software",
      description:
        "What Scheduling Pilot does: build and publish shift schedules, track availability and time off, run a geofenced time clock, approve shift trades, and report on hours.",
      path: "/about",
    }),
  component: About,
});

const CAPABILITIES = [
  {
    icon: CalendarRange,
    title: "Schedule builder",
    desc: "Drag shifts onto a weekly or two-week grid, or plan a whole month at a glance. Build a draft, review it, then publish it to the team in one action.",
  },
  {
    icon: CalendarCheck,
    title: "Availability & auto-fill",
    desc: "Employees record the hours they can work. The generator fills open shifts around that, respecting approved time off, weekly hour limits and who is qualified for each position.",
  },
  {
    icon: RefreshCw,
    title: "Shift trades",
    desc: "An employee offers a shift, a teammate accepts, and an admin gives the final approval. The shift reassigns itself once it clears.",
  },
  {
    icon: CalendarOff,
    title: "Time off",
    desc: "Vacation, sick and personal requests go to an admin for approval, and approved days are visible at the moment someone builds next week's schedule.",
  },
  {
    icon: Clock,
    title: "Time clock with geofence",
    desc: "Staff clock in and out from their phone. Punches record distance from the worksite, so you can see which ones landed inside the fence.",
  },
  {
    icon: FileClock,
    title: "Timecards & corrections",
    desc: "Hours roll up into timecards for the pay period. An admin can add or fix a punch, but every correction needs a written reason and is kept on record.",
  },
  {
    icon: UserCheck,
    title: "Who's in",
    desc: "A live view of who is currently clocked in, who is on a break and who has not shown up yet.",
  },
  {
    icon: Network,
    title: "Departments, sites & positions",
    desc: "Model the company the way it actually works: departments, locations with their own geofence, and named positions employees are qualified for.",
  },
  {
    icon: BarChart3,
    title: "Reports",
    desc: "Scheduled hours, coverage and cost across a date range, with the underlying shifts listed so the numbers can be checked.",
  },
  {
    icon: ScrollText,
    title: "Audit log",
    desc: "A record of who changed what and when, so a disputed schedule or timecard has an answer.",
  },
];

const ROLES = [
  {
    name: "Company admin",
    desc: "Runs the company: builds and publishes schedules, manages the roster and invites, approves trades and time off, corrects punches, and sees reports and billing.",
  },
  {
    name: "Employee",
    desc: "Sees their own schedule, sets their availability, clocks in and out, offers and accepts shift trades, and requests time off.",
  },
  {
    name: "Platform admin",
    desc: "Operates the service itself — approves new companies, manages plans, and never sees a single company's day-to-day data by accident.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Create your company",
    desc: "Sign up, name the company, and you become its first admin. A platform admin approves the account.",
  },
  {
    n: "2",
    title: "Bring the team in",
    desc: "Share your 8-character join code, or send email invitations. Requests from the join code land in your Employees page for approval.",
  },
  {
    n: "3",
    title: "Set up the shape of the work",
    desc: "Add departments, locations and positions, then mark who is qualified for what and how many hours each person can work.",
  },
  {
    n: "4",
    title: "Publish the schedule",
    desc: "Build a draft by hand or generate one, check the conflict warnings, then publish. From that point the team sees it and the clock starts collecting hours.",
  },
];

function About() {
  return (
    <div className="min-h-screen bg-background">
      <MarketingHeader />

      <main>
      <section className="relative isolate overflow-hidden">
        <Decorations />
        <div className="relative z-10 mx-auto max-w-3xl px-6 pb-16 pt-8 text-center">
          <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl">
            What {APP_NAME} <span className="text-primary">does</span>
          </h1>
          <p className="mt-5 text-pretty text-lg leading-relaxed text-muted-foreground">
            {APP_NAME} is scheduling software for teams that work in shifts. It replaces the
            spreadsheet, the group chat and the pinned printout with one place where the schedule is
            built, published, traded and clocked against — and where everyone is looking at the same
            version.
          </p>
          <p className="mt-4 text-base italic text-muted-foreground">{APP_TAGLINE}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Who it's for</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Any employer whose staff work variable hours rather than a fixed weekly rota — retail,
          hospitality, clinics, warehouses, municipal crews, security, care work. If you plan
          coverage, hand out shifts and track hours, this is built for you.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((item) => (
            <div
              key={item.title}
              className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-card)]"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft">
                <item.icon className="h-5 w-5 text-primary" />
              </span>
              <h3 className="mt-4 font-semibold text-foreground">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-secondary/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Getting started takes four steps
          </h2>
          <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <li key={step.n}>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {step.n}
                </span>
                <h3 className="mt-4 font-semibold text-foreground">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Who sees what</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          There are three roles, and the boundaries are enforced by the database itself rather than
          by hiding buttons in the interface.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {ROLES.map((role) => (
            <div key={role.name} className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-foreground">{role.name}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{role.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 flex gap-4 rounded-2xl border border-border bg-card p-5">
          <ShieldCheck className="h-6 w-6 shrink-0 text-primary" />
          <div>
            <h3 className="font-semibold text-foreground">Each company is isolated</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Every table carries the company it belongs to, and row-level security in Postgres
              decides what each signed-in account can read or write. One company cannot reach
              another's people, shifts or punches — not through the interface and not through the
              API.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Ready to try it?
          </h2>
          <p className="mt-3 text-muted-foreground">
            Create a company in a minute, or join one your admin has already set up with their code.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-[var(--shadow-elev)] hover:bg-primary/90"
            >
              Create account <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/"
              hash="pricing"
              className="inline-flex items-center rounded-lg border border-border bg-card px-5 py-3 text-sm font-medium text-foreground hover:bg-accent"
            >
              See pricing
            </Link>
          </div>
          <p className="mt-10 text-sm font-medium text-muted-foreground">
            Powered by Valladolid NovaTech
          </p>
        </div>
      </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
