/**
 * Checks for the Edit member dropdown rules (src/lib/org-structure.ts).
 * Run with `bun scripts/org-structure.test.ts`.
 */
import {
  activeOrCurrent,
  diffIds,
  positionFitsDepartment,
  positionsForDepartment,
  type DeptPositionLink,
  type OrgItem,
} from "../src/lib/org-structure";

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

const item = (id: string, is_active = true): OrgItem => ({ id, name: id, is_active });
const positions = [
  item("traffic-controller"),
  item("traffic-supervisor"),
  item("parking-officer"),
  item("dispatcher"),
  item("retired-title", false),
];
const links: DeptPositionLink[] = [
  { department_id: "traffic", position_id: "traffic-controller" },
  { department_id: "traffic", position_id: "traffic-supervisor" },
  { department_id: "traffic", position_id: "parking-officer" },
  { department_id: "traffic", position_id: "retired-title" },
  { department_id: "dispatch", position_id: "dispatcher" },
];
const ids = (rows: OrgItem[]) => rows.map((r) => r.id);

console.log("does a position fit a department");
eq("listed position fits", positionFitsDepartment("traffic-controller", "traffic", links), true);
eq("unlisted position doesn't", positionFitsDepartment("dispatcher", "traffic", links), false);
eq(
  "department with no list takes any",
  positionFitsDepartment("dispatcher", "records", links),
  true,
);
eq("no department takes any", positionFitsDepartment("dispatcher", null, links), true);
eq("no position always fits", positionFitsDepartment(null, "traffic", links), true);

console.log("what the Position dropdown offers");
eq(
  "only the department's active positions",
  ids(positionsForDepartment("traffic", positions, links)),
  ["traffic-controller", "traffic-supervisor", "parking-officer"],
);
eq(
  "an inactive one they already hold stays",
  ids(positionsForDepartment("traffic", positions, links, "retired-title")),
  ["traffic-controller", "traffic-supervisor", "parking-officer", "retired-title"],
);
eq(
  "a held one from another department is not offered",
  ids(positionsForDepartment("traffic", positions, links, "dispatcher")),
  ["traffic-controller", "traffic-supervisor", "parking-officer"],
);
eq("no department: every active position", ids(positionsForDepartment(null, positions, links)), [
  "traffic-controller",
  "traffic-supervisor",
  "parking-officer",
  "dispatcher",
]);

console.log("active lists");
const locations = [item("hq"), item("old-yard", false)];
eq("inactive hidden", ids(activeOrCurrent(locations)), ["hq"]);
eq("inactive shown when current", ids(activeOrCurrent(locations, "old-yard")), ["hq", "old-yard"]);

console.log("link changes");
eq("adds and removes", diffIds(["a", "b"], ["b", "c"]), { add: ["c"], remove: ["a"] });
eq("nothing changed", diffIds(["a"], ["a"]), { add: [], remove: [] });

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
