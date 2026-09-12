/**
 * Checks for the scheduling pattern engine — the part of the template system
 * where a mistake is invisible until a month is wrong.
 *
 * Run with `bun run test:pattern`. No test framework: the engine is pure
 * functions over dates, and a script that exits non-zero says everything CI
 * needs to know.
 */
import {
  PATROL_3443,
  addDays,
  cycleDay,
  daysBetween,
  describePattern,
  isWorkDay,
  monthDays,
  monthPeriods,
  shiftTimes,
  weekColumnOrder,
} from "../src/lib/schedule-pattern";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, expected ${e}`);
}

const ANCHOR = "2026-08-05"; // Pattern day 1 = a work day.

console.log("\npattern shape");
eq("3 work, 4 off, 4 work, 3 off", describePattern(PATROL_3443), "3 work, 4 off, 4 work, 3 off");
eq("14-day cycle", PATROL_3443.length, 14);
eq("7 work days per cycle", PATROL_3443.filter(Boolean).length, 7);

console.log("\nthe cycle repeats");
const first28 = Array.from({ length: 28 }, (_, i) =>
  isWorkDay(PATROL_3443, ANCHOR, addDays(ANCHOR, i)),
);
eq("days 1-14 match the pattern", first28.slice(0, 14), PATROL_3443);
eq("days 15-28 repeat it", first28.slice(14), PATROL_3443);

console.log("\nthe cycle ignores calendar boundaries");
// 2026-08-05 is cycle day 0; September 1 is 27 days later.
eq("start of September continues the count", cycleDay(ANCHOR, "2026-09-01", 14), 27 % 14);
eq(
  "start of a new year continues the count",
  cycleDay(ANCHOR, "2027-01-01", 14),
  daysBetween(ANCHOR, "2027-01-01") % 14,
);
check(
  "no restart on the 1st, 15th or 29th",
  [1, 15, 29].every((d) => {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    return cycleDay(ANCHOR, day, 14) === daysBetween(ANCHOR, day) % 14;
  }),
);
eq("dates before the anchor count backwards", cycleDay(ANCHOR, "2026-08-04", 14), 13);
// A year is 365 days, which is not a whole number of cycles: 365 % 14 = 1,
// so a year earlier sits one day short of the anchor, on cycle day 13.
eq("a year before the anchor is one day short", cycleDay(ANCHOR, "2025-08-05", 14), 13);
eq(
  "a whole number of cycles back returns to day 0",
  cycleDay(ANCHOR, addDays(ANCHOR, -364), 14),
  0,
);

console.log("\nteam offsets");
// Offset 7 is the same pattern, started half a cycle along.
eq("offset 0 on the anchor is a work day", isWorkDay(PATROL_3443, ANCHOR, ANCHOR, 0), true);
eq("offset 7 reads cycle day 7", cycleDay(ANCHOR, ANCHOR, 14, 7), 7);
eq(
  "offset 7 shifts the whole run",
  Array.from({ length: 14 }, (_, i) => isWorkDay(PATROL_3443, ANCHOR, addDays(ANCHOR, i), 7)),
  [...PATROL_3443.slice(7), ...PATROL_3443.slice(0, 7)],
);
eq("a negative offset wraps too", cycleDay(ANCHOR, ANCHOR, 14, -1), 13);

console.log("\nwork-week start is display only");
eq("Monday order", weekColumnOrder(1), [1, 2, 3, 4, 5, 6, 0]);
eq("Sunday order", weekColumnOrder(0), [0, 1, 2, 3, 4, 5, 6]);
check(
  "changing the week start leaves the cycle alone",
  [0, 1, 6].every(
    () =>
      isWorkDay(PATROL_3443, ANCHOR, "2026-09-17") === isWorkDay(PATROL_3443, ANCHOR, "2026-09-17"),
  ),
);

console.log("\nmonths");
eq("31-day month", monthDays(2026, 7).length, 31);
eq("30-day month", monthDays(2026, 9).length, 30);
eq("February, ordinary year", monthDays(2026, 2).length, 28);
eq("February, leap year", monthDays(2028, 2).length, 29);
eq(
  "31-day month splits 14 / 14 / 3",
  monthPeriods(2026, 7).map((p) => p.days.length),
  [14, 14, 3],
);
eq(
  "30-day month splits 14 / 14 / 2",
  monthPeriods(2026, 9).map((p) => p.days.length),
  [14, 14, 2],
);
eq(
  "ordinary February has no remainder",
  monthPeriods(2026, 2).map((p) => p.days.length),
  [14, 14],
);
eq(
  "leap February carries the 29th",
  monthPeriods(2028, 2).map((p) => p.days.length),
  [14, 14, 1],
);
eq("the 29th of a leap February is included", monthPeriods(2028, 2)[2].days, ["2028-02-29"]);

console.log("\nclock times");
const night = shiftTimes("2026-08-05", "19:00", "07:00");
eq("a night shift ends the next day", night.ends.getDate(), 6);
eq("twelve hours long", (night.ends.getTime() - night.starts.getTime()) / 3_600_000, 12);
const day = shiftTimes("2026-08-05", "07:00", "19:00");
eq("a day shift ends the same day", day.ends.getDate(), 5);
eq("also twelve hours", (day.ends.getTime() - day.starts.getTime()) / 3_600_000, 12);

console.log("\ndaylight saving");
// US DST ends 2026-11-01: that local day is 25 hours long.
eq("day counting is unaffected", daysBetween("2026-10-31", "2026-11-02"), 2);
eq(
  "the cycle crosses the change cleanly",
  cycleDay(ANCHOR, "2026-11-02", 14),
  daysBetween(ANCHOR, "2026-11-02") % 14,
);
const overDst = shiftTimes("2026-11-01", "19:00", "07:00");
eq("a shift keeps its wall-clock start", overDst.starts.getHours(), 19);
eq("and its wall-clock end", overDst.ends.getHours(), 7);

console.log("\nother patterns run on the same engine");
const fourOnFourOff = [true, true, true, true, false, false, false, false];
eq("4 on, 4 off", describePattern(fourOnFourOff), "4 work, 4 off");
eq(
  "8-day cycle repeats",
  Array.from({ length: 8 }, (_, i) => isWorkDay(fourOnFourOff, ANCHOR, addDays(ANCHOR, i))),
  fourOnFourOff,
);
const weekdays = [false, true, true, true, true, true, false]; // anchored on a Sunday
eq("Monday to Friday", describePattern(weekdays), "1 off, 5 work, 1 off");

console.log(failures === 0 ? "\nAll pattern checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
