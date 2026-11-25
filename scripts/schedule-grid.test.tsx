/**
 * The weekly schedule grid lists everyone it is given, scheduled or not, under
 * their department. Run with `bun scripts/schedule-grid.test.tsx`.
 *
 * Before this, a row existed only for someone with a shift (or time off) that
 * week, so anyone not yet scheduled was missing from the schedule.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleGrid, type GridShift } from "../src/components/schedule-grid";

let failures = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 23 + i));
const names: Record<string, string> = {
  ana: "Ana Cook",
  ben: "Ben Cook",
  cara: "Cara Server",
  dev: "Dev Nodept",
};
const shifts: GridShift[] = [
  {
    id: "s1",
    employee_id: "ana",
    starts_at: new Date(2026, 10, 24, 9).toISOString(),
    ends_at: new Date(2026, 10, 24, 17).toISOString(),
    position: "Cook",
    color: null,
    published: true,
  } as GridShift,
];
const groups = [
  { id: "k", name: "Kitchen", memberIds: ["ana", "ben"] },
  { id: "f", name: "Front", memberIds: ["cara"] },
];
const timeOff = [{ employee_id: "cara", start_date: "2026-11-25", end_date: "2026-11-25", kind: "other" }];

const render = (people?: string[]) =>
  renderToStaticMarkup(
    <ScheduleGrid
      days={days}
      shifts={shifts}
      nameOf={(id) => names[id] ?? "Unknown"}
      companyName="Test Co"
      rangeLabel="Week"
      groups={groups}
      people={people}
      timeOff={timeOff}
    />,
  );

const before = render();
ok("without a roster, only people with shifts or time off get rows",
  before.includes("Ana") && before.includes("Cara") && !before.includes("Ben") && !before.includes("Dev"));

const html = render(Object.keys(names));
for (const n of ["Ana", "Ben", "Cara", "Dev"]) ok(`${n} has a row`, html.includes(n));
ok("departments are headed in order, No department last",
  html.indexOf("Kitchen") < html.indexOf("Front") && html.indexOf("Front") < html.indexOf("No department"));
ok("Ben (no shift) is under Kitchen", html.indexOf("Kitchen") < html.indexOf("Ben") && html.indexOf("Ben") < html.indexOf("Front"));
ok("Dev (no department) is under No department", html.indexOf("No department") < html.indexOf("Dev"));
const offCells = html.split(">Off<").length - 1;
// 4 people × 7 days = 28 cells, minus Ana's one shift and Cara's one day off.
ok("every unworked day reads Off", offCells === 26, `got ${offCells}`);
ok("the day off is shown", html.includes("Day off"));

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
