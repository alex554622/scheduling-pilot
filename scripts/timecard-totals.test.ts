/**
 * Checks for the roster-wide timecard totals. Run with `bun run test:timecards`.
 */
import { readBreak, totalsByPerson, type SimplePunch } from "../src/lib/timecard-totals";

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
const MINUTE = 60_000;
const at = (day: number, hour: number, min = 0) => new Date(2026, 7, day, hour, min).toISOString();
/** "14:25" — a punch time in local wall clock, which is what rounding works on. */
const clock = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
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

console.log("\nthe day detail the roster table expands");
t = totalsByPerson([
  punch("a", "in", 3, 9),
  punch("a", "break_start", 3, 12),
  punch("a", "break_end", 3, 12, 30),
  punch("a", "out", 3, 17),
  punch("a", "in", 4, 9),
  punch("a", "out", 4, 13),
]).get("a")!;
eq("one entry per day", t.days.length, 2);
eq("oldest day first", t.days[0].date.getDate() < t.days[1].date.getDate(), true);
eq("gross keeps the break in", t.days[0].grossMs / HOUR, 8);
eq("worked takes the unpaid break out", t.days[0].workedMs / HOUR, 7.5);
eq("gross across the period", t.grossMs / HOUR, 12);
eq("one span on each day", [t.days[0].spans.length, t.days[1].spans.length], [1, 1]);
eq("the span carries both punch times", t.days[1].spans[0].outAt !== null, true);

console.log("\nstill on the clock");
t = totalsByPerson([punch("a", "in", 3, 9)]).get("a")!;
eq("the open span is still listed", t.days[0].spans.length, 1);
eq("with no clock-out", t.days[0].spans[0].outAt, null);
eq("and counts nothing", t.days[0].workedMs, 0);

console.log("\npunch rounding, off by default");
t = totalsByPerson([punch("a", "in", 3, 8, 2), punch("a", "out", 3, 16, 23)]).get("a")!;
eq("counts to the minute", t.workedMs / MINUTE, 8 * 60 + 21);

console.log("\nrounding to the nearest 5 minutes");
// The clock-out the rule is named for: 2:23 reads 2:25.
t = totalsByPerson([punch("a", "in", 3, 14), punch("a", "out", 3, 14, 23)], 5).get("a")!;
eq("2:23 reads 2:25", clock(t.days[0].spans[0].outAt), "14:25");
eq("and is paid to 2:25", t.workedMs / MINUTE, 25);

t = totalsByPerson([punch("a", "in", 3, 14), punch("a", "out", 3, 14, 22)], 5).get("a")!;
eq("2:22 reads 2:20 — nearest, not up", clock(t.days[0].spans[0].outAt), "14:20");

t = totalsByPerson([punch("a", "in", 3, 8, 2), punch("a", "out", 3, 16, 23)], 5).get("a")!;
eq(
  "both ends round",
  [clock(t.days[0].spans[0].inAt), clock(t.days[0].spans[0].outAt)],
  ["08:00", "16:25"],
);
eq("hours follow the rounded times", t.workedMs / MINUTE, 8 * 60 + 25);

t = totalsByPerson([punch("a", "in", 3, 8), punch("a", "out", 3, 16)], 5).get("a")!;
eq("a punch already on the mark doesn't move", t.workedMs / HOUR, 8);

console.log("\nrounding to the nearest 10 minutes");
t = totalsByPerson([punch("a", "in", 3, 14), punch("a", "out", 3, 14, 23)], 10).get("a")!;
eq("2:23 reads 2:20", clock(t.days[0].spans[0].outAt), "14:20");
eq("and is paid to 2:20", t.workedMs / MINUTE, 20);

t = totalsByPerson([punch("a", "in", 3, 14), punch("a", "out", 3, 14, 26)], 10).get("a")!;
eq("2:26 reads 2:30", clock(t.days[0].spans[0].outAt), "14:30");

console.log("\nrounding and breaks");
t = totalsByPerson(
  [
    punch("a", "in", 3, 8, 2),
    punch("a", "break_start", 3, 12, 1, 30),
    punch("a", "break_end", 3, 12, 29),
    punch("a", "out", 3, 16, 23),
  ],
  5,
).get("a")!;
eq("the break rounds to half an hour", t.unpaidMs / MINUTE, 30);
eq("and comes off the rounded shift", t.workedMs / MINUTE, 8 * 60 + 25 - 30);

console.log("\nrounding never moves a punch onto another day");
// 11:58pm rounds to midnight, which belongs to the day it was punched.
t = totalsByPerson([punch("a", "in", 3, 20), punch("a", "out", 3, 23, 58)], 5).get("a")!;
eq("still one day", t.days.length, 1);
eq("still the 3rd", t.days[0].date.getDate(), 3);
eq("paid to midnight", t.workedMs / HOUR, 4);

console.log("");
console.log("a break that runs long counts as the length that was picked");
// 8:00 to 16:00 with a 30-minute break taken as 37: the shift pays 7.5 hours,
// not 7h23m, and the 7-minute overrun is reported rather than charged.
t = totalsByPerson([
  punch("a", "in", 3, 8),
  punch("a", "break_start", 3, 12, 0, 30),
  punch("a", "break_end", 3, 12, 37),
  punch("a", "out", 3, 16),
]).get("a")!;
eq("half an hour off the shift, not 37 minutes", t.unpaidMs / MINUTE, 30);
eq("seven and a half hours worked", t.workedMs / HOUR, 7.5);
eq("the overrun is reported", t.overBreakMs / MINUTE, 7);
eq("and nothing is flagged", t.incompleteBreaks, 0);

console.log("");
console.log("with the rule off, the clock time stands");
t = totalsByPerson(
  [
    punch("a", "in", 3, 8),
    punch("a", "break_start", 3, 12, 0, 30),
    punch("a", "break_end", 3, 12, 37),
    punch("a", "out", 3, 16),
  ],
  0,
  false,
).get("a")!;
eq("all 37 minutes come off", t.unpaidMs / MINUTE, 37);
eq("the overrun is still reported", t.overBreakMs / MINUTE, 7);

console.log("");
console.log("a break cut short counts as what it was, and is flagged");
t = totalsByPerson([
  punch("a", "in", 3, 8),
  punch("a", "break_start", 3, 12, 0, 30),
  punch("a", "break_end", 3, 12, 22),
  punch("a", "out", 3, 16),
]).get("a")!;
eq("only the 22 minutes come off", t.unpaidMs / MINUTE, 22);
eq("never rounded up to the full break", t.workedMs / MINUTE, 8 * 60 - 22);
eq("the day is flagged", t.days[0].incompleteBreaks, 1);
eq("and so is the period", t.incompleteBreaks, 1);

console.log("");
console.log("a paid ten is capped the same way, and stays paid");
t = totalsByPerson([
  punch("a", "in", 3, 8),
  punch("a", "break_start", 3, 10, 0, 10),
  punch("a", "break_end", 3, 10, 17),
  punch("a", "out", 3, 16),
]).get("a")!;
eq("ten minutes in the paid column", t.paidMs / MINUTE, 10);
eq("nothing deducted", t.unpaidMs, 0);
eq("the full eight hours", t.workedMs / HOUR, 8);

console.log("");
console.log("a break with no length picked is left alone");
const noLength = readBreak(37 * MINUTE, null);
eq("counted as the clock recorded it", noLength.countedMs / MINUTE, 37);
eq("nothing to be over", noLength.overMs, 0);
eq("and nothing to flag", noLength.incomplete, false);

console.log(
  failures === 0 ? "\nAll timecard checks passed.\n" : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
