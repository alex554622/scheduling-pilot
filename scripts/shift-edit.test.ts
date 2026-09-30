/**
 * Checks for the shift-based punch editor. Run with `bun run test:shift-edit`.
 */
import {
  diffDay,
  resolveShift,
  shiftHours,
  toShifts,
  validateDay,
  type DayPunch,
  type DraftShift,
} from "../src/lib/shift-edit";

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
const DAY = new Date(2026, 8, 30);
const at = (day: number, hour: number, min = 0) => new Date(2026, 8, day, hour, min).toISOString();
const p = (id: string, kind: DayPunch["kind"], day: number, hour: number, min = 0, m: number | null = null): DayPunch => ({
  id,
  kind,
  at: at(day, hour, min),
  break_minutes: m,
});
const clone = (s: DraftShift[]) => JSON.parse(JSON.stringify(s)) as DraftShift[];

console.log("\nreading punches into shifts");
const plain = [
  p("i", "in", 30, 9),
  p("bs", "break_start", 30, 12, 0, 30),
  p("be", "break_end", 30, 12, 30, 30),
  p("o", "out", 30, 17, 30),
];
let shifts = toShifts(plain);
eq("one shift", shifts.length, 1);
eq("its times", [shifts[0].inTime, shifts[0].outTime], ["09:00", "17:30"]);
eq("its break", shifts[0].breaks.map((b) => [b.start, b.end, b.minutes]), [["12:00", "12:30", 30]]);
eq("nothing to fix", validateDay(shifts, DAY).size, 0);
eq("eight hours worked", shiftHours(resolveShift(shifts[0], DAY), true).workedMs / HOUR, 8);
eq("no changes when untouched", diffDay(plain, shifts, DAY), []);

console.log("\nan overnight shift");
const night = [p("i", "in", 30, 20), p("bs", "break_start", 1, 0, 30, 30), p("be", "break_end", 1, 1, 0), p("o", "out", 1, 2)];
// Oct 1 is day 1 of the next month; build it explicitly.
night[1].at = new Date(2026, 9, 1, 0, 30).toISOString();
night[2].at = new Date(2026, 9, 1, 1, 0).toISOString();
night[3].at = new Date(2026, 9, 1, 2, 0).toISOString();
shifts = toShifts(night);
eq("typed as 20:00 to 02:00", [shifts[0].inTime, shifts[0].outTime], ["20:00", "02:00"]);
const r = resolveShift(shifts[0], DAY);
eq("clock-out lands the next morning", r.outAt!.toISOString(), night[3].at);
eq("five and a half hours", shiftHours(r, true).workedMs / HOUR, 5.5);
eq("valid", validateDay(shifts, DAY).size, 0);
eq("untouched means no calls", diffDay(night, shifts, DAY), []);

console.log("\nretiming a clock-out");
shifts = toShifts(plain);
let edited = clone(shifts);
edited[0].outTime = "18:00";
eq("one update, to 18:00", diffDay(plain, edited, DAY), [
  { op: "update", id: "o", kind: "out", at: at(30, 18), minutes: null },
]);

console.log("\nchanging a break's length updates only its start");
edited = clone(shifts);
edited[0].breaks[0].minutes = 60;
eq("one update", diffDay(plain, edited, DAY).map((c) => [c.op, "id" in c ? c.id : null]), [["update", "bs"]]);

console.log("\nremoving a break deletes both of its punches");
edited = clone(shifts);
edited[0].breaks = [];
eq("two deletes", diffDay(plain, edited, DAY), [
  { op: "delete", id: "bs" },
  { op: "delete", id: "be" },
]);

console.log("\nadding a whole shift");
const empty: DraftShift[] = [
  { key: "n", inTime: "08:00", outTime: "16:00", breaks: [{ key: "b", minutes: 10, start: "10:00", end: "10:10" }] },
];
eq("valid", validateDay(empty, DAY).size, 0);
eq(
  "four inserts in order",
  diffDay([], empty, DAY).map((c) => (c.op === "insert" ? `${c.kind}@${new Date(c.at).getHours()}` : c.op)),
  ["in@8", "break_start@10", "break_end@10", "out@16"],
);
eq("a paid ten stays in the hours", shiftHours(resolveShift(empty[0], DAY), true).workedMs / HOUR, 8);

console.log("\na forgotten clock-out, filled in");
const open = [p("i", "in", 30, 9)];
shifts = toShifts(open);
eq("reads as open", shiftHours(resolveShift(shifts[0], DAY), true).open, true);
edited = clone(shifts);
edited[0].outTime = "17:00";
eq("inserts the clock-out", diffDay(open, edited, DAY), [
  { op: "insert", kind: "out", at: at(30, 17), minutes: null },
]);

console.log("\na clock-out with no clock-in is shown, not hidden");
shifts = toShifts([p("o", "out", 30, 17)]);
eq("as a shift missing its clock-in", [shifts[0].inTime, shifts[0].outTime], ["", "17:00"]);
eq("which has to be filled in", validateDay(shifts, DAY).get(shifts[0].key), ["Enter a clock-in time."]);

console.log("\nmistakes are caught before saving");
const bad: DraftShift[] = [
  { key: "a", inTime: "09:00", outTime: "17:00", breaks: [{ key: "b", minutes: 30, start: "18:00", end: "18:30" }] },
  { key: "c", inTime: "16:00", outTime: "20:00", breaks: [] },
];
const probs = validateDay(bad, DAY);
eq("a break after the clock-out", probs.get("a"), ["Break: has to end by the clock-out."]);
eq("overlapping shifts", probs.get("c"), ["Starts before the shift above it has ended."]);
const noEnd: DraftShift[] = [
  { key: "a", inTime: "09:00", outTime: "17:00", breaks: [{ key: "b", minutes: 30, start: "12:00", end: "" }] },
];
eq("a closed shift needs its break ended", validateDay(noEnd, DAY).get("a"), [
  "Break: enter an end time, or clear the clock-out.",
]);

console.log(failures === 0 ? "\nAll shift-edit checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
