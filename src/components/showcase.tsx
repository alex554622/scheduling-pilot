import { Users } from "lucide-react";

/**
 * The product preview that sits beside the marketing headline: four cards that
 * look like the app. Everything here is illustrative, not live data, so it stays
 * static and SSR-safe (fixed arrays, no Math.random).
 */
export function DashboardPreview() {
  return (
    <div className="min-w-0 space-y-5">
      {/* minmax(0,…) rather than bare fractions: grid items default to
          min-width:auto, so one wide card would otherwise widen the whole column. */}
      <div className="grid min-w-0 gap-5 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ScheduleOverviewCard className="min-w-0" />
        <div className="flex min-w-0 flex-col gap-5">
          <CoverageCard />
          <OpenShiftsCard />
        </div>
      </div>
      <TeamAvailabilityCard />
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-border/60 bg-card p-5 shadow-[var(--shadow-card)] ${className}`}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-medium text-foreground">{children}</p>;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
// "" empty · "d" blue dot · "f" faint dot · "b" filled block · a digit renders as a faded number
const HEATMAP: string[][] = [
  ["", "", "", "", "", "1", "d"],
  ["1", "f", "d", "9", "d", "d", "f"],
  ["d", "1", "f", "f", "f", "f", "f"],
  ["d", "b", "", "b", "", "", "b"],
  ["", "", "f", "", "", "", ""],
];

function ScheduleOverviewCard({ className = "" }: { className?: string }) {
  return (
    <Card className={className}>
      <CardTitle>Schedule Overview</CardTitle>
      <div className="mt-4 grid grid-cols-7 text-center">
        {WEEKDAYS.map((d, i) => (
          <span key={i} className="pb-2 text-xs font-medium text-muted-foreground">
            {d}
          </span>
        ))}
        {HEATMAP.flatMap((week, w) =>
          week.map((cell, d) => (
            <div
              key={`${w}-${d}`}
              className={`grid aspect-square place-items-center border-b border-r border-border/40 ${
                d === 0 ? "border-l" : ""
              } ${w === 0 ? "border-t" : ""} ${cell === "b" ? "bg-primary/10" : ""}`}
            >
              {cell === "d" && <span className="h-2 w-2 rounded-full bg-primary" />}
              {cell === "f" && <span className="h-2 w-2 rounded-full bg-primary/30" />}
              {/^\d$/.test(cell) && (
                <span className="text-xs text-muted-foreground/50">{cell}</span>
              )}
            </div>
          )),
        )}
      </div>
    </Card>
  );
}

function CoverageCard() {
  return (
    <Card className="relative overflow-hidden">
      {/* Above the sparkline, which is drawn into the card's bottom-right. */}
      <div className="relative z-10">
        <CardTitle>Coverage</CardTitle>
        <p className="mt-2 text-4xl font-semibold tracking-tight text-foreground">98%</p>
        <p className="mt-1 whitespace-nowrap text-sm font-medium text-success">Optimal Coverage</p>
      </div>
      <Sparkline />
    </Card>
  );
}

/** A rising trend line with a soft fill, tucked into the card's bottom-right. */
function Sparkline() {
  const points = [4, 12, 8, 17, 14, 24, 20, 31, 29, 41, 50];
  const stepX = 100 / (points.length - 1);
  const line = points.map((y, i) => `${i * stepX},${56 - y}`).join(" ");
  return (
    <svg
      viewBox="0 0 100 56"
      preserveAspectRatio="none"
      className="pointer-events-none absolute bottom-0 right-0 h-24 w-3/5"
      aria-hidden="true"
    >
      <polygon points={`0,56 ${line} 100,56`} className="fill-primary/10" />
      <polyline
        points={line}
        className="fill-none stroke-primary"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={100} cy={56 - points[points.length - 1]} r={3} className="fill-primary" />
    </svg>
  );
}

function OpenShiftsCard() {
  return (
    <Card className="flex items-center justify-between gap-3">
      <div className="whitespace-nowrap">
        <CardTitle>Open Shifts</CardTitle>
        <p className="mt-2 text-4xl font-semibold tracking-tight text-foreground">12</p>
        <p className="mt-1 text-sm font-medium text-primary">Needs Coverage</p>
      </div>
      <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary-soft">
        <Users className="h-6 w-6 text-primary" />
      </div>
    </Card>
  );
}

// "away" gives one person the amber dot the design shows.
const TEAM = [
  { name: "Ana Reyes", away: false },
  { name: "Ben Ortiz", away: false },
  { name: "Cara Lin", away: false },
  { name: "Dan Mehta", away: false },
  { name: "Eva Novak", away: true },
];

function TeamAvailabilityCard() {
  return (
    <Card>
      <CardTitle>Team Availability</CardTitle>
      {/* Wraps rather than forcing a min-content width — five avatars plus the
          link need ~394px, which would otherwise blow out the column on a phone. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-2 sm:gap-3">
          {TEAM.map((member) => (
            <span key={member.name} className="relative" title={member.name}>
              <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary sm:h-12 sm:w-12">
                {member.name
                  .split(" ")
                  .map((p) => p[0])
                  .join("")}
              </span>
              <span
                className={`absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-card ${
                  member.away ? "bg-warning" : "bg-success"
                }`}
              />
            </span>
          ))}
        </div>
        <span className="shrink-0 text-sm font-medium text-primary">View all</span>
      </div>
    </Card>
  );
}

/** Dot grids and concentric arcs — pure CSS/SVG, so no extra assets ship. */
export function Decorations() {
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute right-10 top-24 hidden h-36 w-52 lg:block" style={DOTS} />
      <div aria-hidden="true" className="pointer-events-none absolute bottom-24 left-6 hidden h-40 w-28 lg:block" style={DOTS} />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -right-32 hidden h-[36rem] w-[36rem] text-primary/10 lg:block"
        viewBox="0 0 400 400"
        fill="none"
      >
        {[150, 200, 250, 300].map((r) => (
          <circle key={r} cx={200} cy={200} r={r} stroke="currentColor" strokeWidth={2} />
        ))}
      </svg>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-16 hidden h-[30rem] w-[30rem] text-primary/10 lg:block"
        viewBox="0 0 400 400"
        fill="none"
      >
        <rect x={120} y={40} width={240} height={320} rx={40} stroke="currentColor" strokeWidth={2} />
        <circle cx={360} cy={200} r={7} className="fill-primary/40" stroke="none" />
      </svg>
    </>
  );
}

const DOTS: React.CSSProperties = {
  backgroundImage: "radial-gradient(currentColor 1.5px, transparent 1.5px)",
  backgroundSize: "16px 16px",
  color: "var(--primary)",
  opacity: 0.16,
};
