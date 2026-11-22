/**
 * Checks for the lateness rule (src/lib/lateness.ts). Run with `bun scripts/lateness.test.ts`.
 */
import {
  latenessByPunch,
  matchShift,
  unscheduledClockIns,
  type ClockIn,
  type ScheduledShift,
} from "../src/lib/lateness";

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

const at = (day: number, hour: number, min = 0) => new Date(2026, 10, day, hour, min).toISOString();
const shift = (
  id: string,
  day: number,
  from: number,
  to: number,
  opts: Partial<ScheduledShift> = {},
): ScheduledShift => ({
  id,
  employee_id: "ana",
  starts_at: at(day, from),
  ends_at: at(day, to),
  published: true,
  ...opts,
});
let n = 0;
const clockIn = (day: number, hour: number, min = 0, user = "ana"): ClockIn => ({
  id: `p${++n}`,
  user_id: user,
  kind: "in",
  at: at(day, hour, min),
});
const late = (punches: ClockIn[], shifts: ScheduledShift[], grace = 5) => {
  const m = latenessByPunch(punches, shifts, grace);
  return punches.map((p) => {
    const l = m.get(p.id);
    return l ? `${l.shiftId}:${l.minutesLate}${l.late ? " late" : ""}` : null;
  });
};

console.log("lateness");

const nine = shift("s1", 2, 9, 17);
eq("on the dot", late([clockIn(2, 9, 0)], [nine]), ["s1:0"]);
eq("early counts as 0", late([clockIn(2, 8, 40)], [nine]), ["s1:0"]);
eq("inside the grace period", late([clockIn(2, 9, 5)], [nine]), ["s1:5"]);
eq("one minute past grace", late([clockIn(2, 9, 6)], [nine]), ["s1:6 late"]);
eq("grace 0: one minute is late", late([clockIn(2, 9, 1)], [nine], 0), ["s1:1 late"]);
eq(
  "seconds do not count",
  late([{ ...clockIn(2, 9, 5), at: new Date(2026, 10, 2, 9, 5, 59).toISOString() }], [nine]),
  ["s1:5"],
);

eq(
  "draft shift is ignored",
  late([clockIn(2, 9, 30)], [shift("d", 2, 9, 17, { published: false })]),
  [null],
);
eq(
  "someone else's shift is ignored",
  late([clockIn(2, 9, 30)], [shift("o", 2, 9, 17, { employee_id: "ben" })]),
  [null],
);
eq(
  "open shift (no employee) is ignored",
  late([clockIn(2, 9, 30)], [shift("o", 2, 9, 17, { employee_id: null })]),
  [null],
);
eq("no shift that day", late([clockIn(3, 9, 30)], [nine]), [null]);
eq("clock-in after the shift ended", late([clockIn(2, 17, 0)], [nine]), [null]);
eq("too early to belong to the shift", late([clockIn(2, 4, 59)], [nine]), [null]);

eq(
  "second clock-in of a shift is not judged",
  late([clockIn(2, 9, 0), clockIn(2, 13, 0)], [nine]),
  ["s1:0", null],
);
eq("order of the input does not matter", late([clockIn(2, 13, 0), clockIn(2, 9, 20)], [nine]), [
  null,
  "s1:20 late",
]);

// A split day: 8-12 and 13-17. Arriving 12:50 is for the afternoon shift.
const morning = shift("am", 4, 8, 12);
const afternoon = shift("pm", 4, 13, 17);
eq(
  "split day: each shift judged on its own",
  late([clockIn(4, 8, 2), clockIn(4, 12, 50)], [morning, afternoon]),
  ["am:2", "pm:0"],
);
eq(
  "split day: late for the afternoon",
  late([clockIn(4, 8, 0), clockIn(4, 13, 15)], [morning, afternoon]),
  ["am:0", "pm:15 late"],
);
eq(
  "matchShift picks the nearest start",
  matchShift([morning, afternoon], "ana", new Date(at(4, 11, 59)).getTime())?.id,
  "am",
);

eq(
  "back from lunch is not the arrival for an evening shift",
  late(
    [clockIn(7, 9, 0), clockIn(7, 14, 30), clockIn(7, 18, 10)],
    [shift("day", 7, 9, 17), shift("eve", 7, 18, 22)],
  ),
  ["day:0", null, "eve:10 late"],
);
eq(
  "arrived hours late for the only shift",
  late([clockIn(8, 11, 58)], [shift("am8", 8, 8, 12), shift("pm8", 8, 12, 16)]),
  ["am8:238 late"],
);

// Overnight shift, 22:00 to 06:00.
eq("overnight shift", late([clockIn(5, 22, 12)], [shift("night", 5, 22, 30)]), ["night:12 late"]);

// Edited after the punch: the answer follows the schedule as it is now.
const punch = clockIn(6, 9, 30);
eq("before the edit (9:00 start)", late([punch], [shift("e", 6, 9, 17)]), ["e:30 late"]);
eq(
  "after the edit (moved to 9:30)",
  late([punch], [shift("e", 6, 9, 17, { starts_at: at(6, 9, 30) })]),
  ["e:0"],
);
eq("after unpublishing", late([punch], [shift("e", 6, 9, 17, { published: false })]), [null]);

console.log("unscheduled");
const unsched = (punches: ClockIn[], shifts: ScheduledShift[]) => {
  const s = unscheduledClockIns(punches, shifts);
  return punches.map((p) => s.has(p.id));
};
eq("no shift at all", unsched([clockIn(10, 9, 0)], []), [true]);
eq("on a shift", unsched([clockIn(10, 9, 3)], [shift("u1", 10, 9, 17)]), [false]);
eq(
  "arriving early still counts as scheduled",
  unsched([clockIn(10, 6, 0)], [shift("u1", 10, 9, 17)]),
  [false],
);
eq(
  "back from lunch is not unscheduled",
  unsched([clockIn(10, 9, 0), clockIn(10, 13, 0)], [shift("u1", 10, 9, 17)]),
  [false, false],
);
eq("after the shift ended", unsched([clockIn(10, 17, 30)], [shift("u1", 10, 9, 17)]), [true]);
eq(
  "only a draft shift",
  unsched([clockIn(10, 9, 0)], [shift("u1", 10, 9, 17, { published: false })]),
  [true],
);
eq(
  "someone else's shift",
  unsched([clockIn(10, 9, 0)], [shift("u1", 10, 9, 17, { employee_id: "ben" })]),
  [true],
);
eq("clock-outs are never marked", unsched([{ ...clockIn(10, 9, 0), kind: "out" }], []), [false]);

if (failures > 0) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
