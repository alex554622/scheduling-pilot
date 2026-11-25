/** Today's dashboard punches, across midnight. Run with `bun scripts/today-punches.test.ts`. */
import { keepTodaysPunches } from "../src/lib/today-punches";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
};
const midnight = new Date("2026-11-25T00:00:00Z").getTime();
const P = (user_id: string, kind: string, at: string) => ({ user_id, kind, at: `2026-11-${at}:00Z` });
const ids = (list: { user_id: string; kind: string; at: string }[]) =>
  list.map((p) => `${p.user_id}:${p.kind}@${p.at.slice(8, 16)}`).join(" ");

const punches = [
  P("night", "in", "24T22:00"), // still on the overnight shift
  P("done", "in", "24T22:00"), P("done", "out", "25T06:00"), // finished overnight
  P("again", "in", "24T22:00"), P("again", "out", "25T06:00"), P("again", "in", "25T18:00"), // back in tonight
  P("yday", "in", "24T09:00"), P("yday", "out", "24T17:00"), // yesterday only
  P("day", "in", "25T09:00"), P("day", "out", "25T17:00"), // today
  P("brk", "in", "24T23:00"), P("brk", "break_start", "25T02:00"), // on break overnight
];
const kept = keepTodaysPunches(punches, midnight);
const users = new Set(kept.map((p) => p.user_id));
ok("still clocked in from last night stays", users.has("night"));
ok("on a break from last night stays", kept.filter((p) => p.user_id === "brk").length === 2);
ok("finished overnight shift drops off", !users.has("done"));
ok("back in later today shows only today's stretch",
  ids(kept.filter((p) => p.user_id === "again")) === "again:in@25T18:00", ids(kept.filter((p) => p.user_id === "again")));
ok("yesterday-only drops off", !users.has("yday"));
ok("today's shift stays", kept.filter((p) => p.user_id === "day").length === 2);
ok("stays oldest first", kept.every((p, i) => i === 0 || kept[i - 1].at <= p.at));

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
