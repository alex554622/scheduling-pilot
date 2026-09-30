/**
 * CSV export: `bun scripts/admin-export.test.ts`.
 */
import { ago, slug, toCsv } from "../src/lib/admin-export";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`,
  );
}

eq("plain fields", toCsv(["a", "b"], [["x", 1]]), "a,b\r\nx,1");
eq("empty for null", toCsv(["a", "b"], [[null, undefined]]), "a,b\r\n,");
eq("comma is quoted", toCsv(["a"], [["Smith, Jones & Co"]]), 'a\r\n"Smith, Jones & Co"');
eq("quote is doubled", toCsv(["a"], [['The "Best" Diner']]), 'a\r\n"The ""Best"" Diner"');
eq("newline is quoted", toCsv(["a"], [["1 Main St\nSuite 2"]]), 'a\r\n"1 Main St\nSuite 2"');
eq("formula is defused", toCsv(["a"], [['=HYPERLINK("x")']]), 'a\r\n"\'=HYPERLINK(""x"")"');
eq("minus is defused", toCsv(["a"], [["-5"]]), "a\r\n'-5");
eq("numbers are not defused", toCsv(["a"], [[-5]]), "a\r\n-5");

eq("slug", slug("Joe's Diner & Grill"), "joe-s-diner-grill");
eq("slug of nothing", slug("!!!"), "export");

const now = Date.parse("2026-09-30T12:00:00Z");
eq("ago never", ago(null, now), "never");
eq("ago just now", ago("2026-09-30T11:59:40Z", now), "just now");
eq("ago minutes", ago("2026-09-30T11:48:00Z", now), "12 min ago");
eq("ago hours", ago("2026-09-30T07:00:00Z", now), "5 h ago");
eq("ago days", ago("2026-09-27T12:00:00Z", now), "3 d ago");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
