// Self-test for MONKEY SEE and MONKEY DO — the command-line entry point.
//
//   node scripts/self-test.mjs           every check (a few seconds)
//   node scripts/self-test.mjs --full    also regenerate the whole board pool
//                                        and compare it byte for byte (minutes)
//
// A failing self-test blocks scoring — there is no override. The checks live in
// src/self-test.mjs so the runners can gate on them. See guide.md 8.3.

import { runSelfTest } from "../src/self-test.mjs";

const full = process.argv.includes("--full");
const { ok, passed, failures } = await runSelfTest({ full });

if (ok) {
  console.log(`\n\x1b[1mMONKEY SEE and MONKEY DO are calibrated and safe to score.\x1b[0m`);
  console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m${full ? "" : "  (Add --full to regenerate the whole pool as well.)"}\n`);
  process.exit(0);
}
// Printed ONLY on success now. It used to print "calibrated and safe to score"
// unconditionally, directly above the line reporting failed checks.
console.log(`\n\x1b[31m\x1b[1m${failures.length} check(s) failed.\x1b[0m Scoring is blocked. Do not trust any score until these pass.\n`);
for (const f of failures) console.log(`  - ${f}`);
console.log("");
process.exit(1);
