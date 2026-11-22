/**
 * Checks for position pay rules (src/lib/pay-rules.ts) and paid meal breaks.
 * Run with `bun scripts/pay-rules.test.ts`.
 */
import {
  clockMinutes,
  differentialMs,
  rulesForPerson,
  rulesForPosition,
  type PositionPayRules,
} from "../src/lib/pay-rules";
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
const MIN = 60_000;
const at = (day: number, hour: number, min = 0) => new Date(2026, 10, day, hour, min).getTime();
const hours = (ms: number) => Math.round((ms / HOUR) * 100) / 100;

const position = (id: string, over: Partial<PositionPayRules> = {}): PositionPayRules => ({
  id,
  name: id,
  paid_meal_breaks: false,
  diff_enabled: false,
  diff_label: "Night differential",
  diff_start: "18:00:00",
  diff_end: "06:00:00",
  ...over,
});

console.log("which position rules apply");
const positions = [
  position("officer", { paid_meal_breaks: true, diff_enabled: true }),
  position("dispatcher", { diff_enabled: true }),
  position("clerk"),
];
const ruleOf = (id: string | null) => rulesForPosition(id, positions)?.id ?? null;
eq("officer has rules", ruleOf("officer"), "officer");
eq("dispatcher has rules", ruleOf("dispatcher"), "dispatcher");
eq("position with nothing set keeps company rules", ruleOf("clerk"), null);
eq("unknown position", ruleOf("ghost"), null);
eq("no position", ruleOf(null), null);

console.log("which of someone's positions applies");
const held = (...ids: string[]) => ids.map((id) => ({ position_id: id, is_primary: false }));
const forPerson = (assigned: { position_id: string; is_primary: boolean }[]) =>
  rulesForPerson(assigned, positions)?.id ?? null;
eq("one position with rules", forPerson(held("dispatcher")), "dispatcher");
eq("skips a position without rules", forPerson(held("clerk", "dispatcher")), "dispatcher");
eq("first in list order wins", forPerson(held("dispatcher", "officer")), "officer");
eq(
  "primary decides, even without rules",
  forPerson([
    { position_id: "officer", is_primary: false },
    { position_id: "clerk", is_primary: true },
  ]),
  null,
);
eq("no positions", forPerson([]), null);

console.log("clock times");
eq("18:00:00", clockMinutes("18:00:00"), 1080);
eq("06:30", clockMinutes("06:30"), 390);

console.log("differential, 18:00–06:00");
const diff = (
  inMs: number,
  outMs: number,
  breaks: { startMs: number; ms: number }[] = [],
  s = "18:00",
  e = "06:00",
) => hours(differentialMs({ inMs, outMs, unpaidBreaks: breaks }, s, e));
eq("6 PM to 6 AM is all differential", diff(at(16, 18), at(17, 6)), 12);
eq("6 AM to 6 PM has none", diff(at(16, 6), at(16, 18)), 0);
eq("2 PM to 10 PM: 4 hours after 6", diff(at(16, 14), at(16, 22)), 4);
eq("4 AM to 8 AM: 2 hours before 6", diff(at(16, 4), at(16, 8)), 2);
eq("noon to 2 AM: 8 hours", diff(at(16, 12), at(17, 2)), 8);
eq(
  "unpaid 30 at 11 PM comes off",
  diff(at(16, 18), at(17, 6), [{ startMs: at(16, 23), ms: 30 * MIN }]),
  11.5,
);
eq(
  "unpaid 30 at 3 PM is outside the window",
  diff(at(16, 14), at(16, 22), [{ startMs: at(16, 15), ms: 30 * MIN }]),
  4,
);
eq(
  "unpaid break straddling 6 PM: only the part after counts",
  diff(at(16, 14), at(16, 22), [{ startMs: at(16, 17, 45), ms: 30 * MIN }]),
  3.75,
);
eq("daytime window 08:00–17:00", diff(at(16, 7), at(16, 12), [], "08:00", "17:00"), 4);
eq("clock-out before clock-in is nothing", diff(at(16, 22), at(16, 20)), 0);
eq("a 36-hour stretch counts each night once", diff(at(16, 6), at(17, 18)), 12);

console.log("paid meal breaks");
eq("30 is unpaid by default", readBreak(30 * MIN, 30).paid, false);
eq("30 is paid with the position rule", readBreak(30 * MIN, 30, true, true).paid, true);
eq("60 is paid with the position rule", readBreak(60 * MIN, 60, true, true).paid, true);
eq("10 is always paid", readBreak(10 * MIN, 10).paid, true);
eq("a break with no length stays unpaid", readBreak(30 * MIN, null, true, true).paid, false);

const iso = (ms: number) => new Date(ms).toISOString();
const shift: SimplePunch[] = [
  { user_id: "u", kind: "in", at: iso(at(16, 18)), break_minutes: null },
  { user_id: "u", kind: "break_start", at: iso(at(16, 23)), break_minutes: 30 },
  { user_id: "u", kind: "break_end", at: iso(at(16, 23, 30)), break_minutes: 30 },
  { user_id: "u", kind: "out", at: iso(at(17, 6)), break_minutes: null },
];
eq(
  "12-hour shift, unpaid lunch: 11.5 worked",
  hours(totalsByPerson(shift).get("u")!.workedMs),
  11.5,
);
eq(
  "12-hour shift, paid lunch: 12 worked",
  hours(totalsByPerson(shift, 0, true, [], () => true).get("u")!.workedMs),
  12,
);

if (failures > 0) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
