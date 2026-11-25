/** Last-name ordering. Run with `bun scripts/names.test.ts`. */
import { compareByLastName, splitName, sortByLastName } from "../src/lib/names";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
};

ok("last word is the last name", splitName("Ana María López").last === "López");
ok("a suffix is skipped", splitName("John Smith Jr.").last === "Smith");
ok("particles stay with the last name", splitName("Lorena De la torre").last === "De la torre");
ok("a particle-looking first name stays the first name", splitName("De Smith").last === "Smith");
ok("one word is the last name", splitName("Cher").last === "Cher");
const names = ["MARTHA GUTIERREZ", "Ben Avila", "camila gutierrez", "Ángel Zamora", "Luis Ávila", "", "Sam Brown III"];
const got = sortByLastName(names, (n) => n);
const want = ["Ben Avila", "Luis Ávila", "Sam Brown III", "camila gutierrez", "MARTHA GUTIERREZ", "Ángel Zamora", ""];
ok("sorted by last name, then first, case and accents ignored, blank last", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
ok("null sorts after a name", compareByLastName(null, "A B") > 0);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
