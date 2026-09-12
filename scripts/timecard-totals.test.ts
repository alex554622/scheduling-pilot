/**
 * Checks for the roster-wide timecard totals. Run with `bun run test:timecards`.
 */
import { totalsByPerson, type SimplePunch } from "../src/lib/timecard-totals";

let failures = 0;
function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} — got ${a}, expected ${e}`);
  }
}

const HOUR = 3_600_000;
const at = (day: number, hour: number, min = 0) => new Date(2026, 7, day, hour, min).toISOString();
const punch = (
  user: string,
  kind: SimplePunch["kind"],
  day: number,
  hour: number,
  min = 0,
  breakMinutes: number | null = null,
): SimplePunch => ({ user_id: user, kind, at: at(day, hour, min), break_minutes: breakMinutes });

console.log("\na plain shift");
let t = totalsByPerson([punch("a", "in", 3, 8), punch("a", "out", 3, 16)]).get("a")!;
eq("eight hours", t.workedMs / HOUR, 8);
eq("no break time", [t.unpaidMs, t.paidMs], [0, 0]);
eq("one day", t.dayTotals.length, 1);

console.log("\nan unpaid break comes off the shift");
t = totalsByPerson([
  punch("a", "in", 3, 8),
  punch("a", "break_start", 3, 12, 0, 30),
  punch("a", "break_end", 3, 12, 30),
  punch("a", "out", 3, 16),
]).get("a")!;
eq("seven and a half hours worked", t.workedMs / HOUR, 7.5);
eq("half an hour unpaid", t.unpaidMs / HOUR, 0.5);
eq("nothing paid", t.paidMs, 0);

console.log("\na ten-minute break is paid and stays in");
t = totalsByPerson([
  punch("a", "in", 3, 8),
  punch("a", "break_start", 3, 10, 0, 10),
  punch("a", "break_end", 3, 10, 10),
  punch("a", "out", 3, 16),
]).get("a")!;
eq("full eight hours", t.workedMs / HOUR, 8);
eq("ten minutes paid", Math.round(t.paidMs / 60_000), 10);
eq("nothing unpaid", t.unpaidMs, 0);

console.log("\nan unfinished shift");
t = totalsByPerson([punch("a", "in", 3, 8)]).get("a")!;
eq("counts nothing until it is closed", t.workedMs, 0);
eq("but the day is still listed", t.dayTotals, [0]);

console.log("\nseveral days and several people");
const many = totalsByPerson([
  punch("a", "in", 3, 8),
  punch("a", "out", 3, 16),
  punch("a", "in", 4, 8),
  punch("a", "out", 4, 14),
  punch("b", "in", 3, 19),
  punch("b", "out", 3, 23),
]);
eq("person a has two days", many.get("a")!.dayTotals.length, 2);
eq("person a worked 14 hours", many.get("a")!.workedMs / HOUR, 14);
eq(
  "day totals are per day",
  many
    .get("a")!
    .dayTotals.map((ms) => ms / HOUR)
    .sort(),
  [6, 8],
);
eq("person b worked 4 hours", many.get("b")!.workedMs / HOUR, 4);
eq("only the people who punched appear", [...many.keys()].sort(), ["a", "b"]);

console.log("\ntwo shifts in one day");
t = totalsByPerson([
  punch("a", "in", 3, 6),
  punch("a", "out", 3, 10),
  punch("a", "in", 3, 18),
  punch("a", "out", 3, 22),
]).get("a")!;
eq("both count", t.workedMs / HOUR, 8);
eq("as one day", t.dayTotals.length, 1);

console.log("\npunches arriving out of order");
t = totalsByPerson([punch("a", "out", 3, 16), punch("a", "in", 3, 8)]).get("a")!;
eq("are sorted before pairing", t.workedMs / HOUR, 8);

console.log(
  failures === 0 ? "\nAll timecard checks passed.\n" : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
