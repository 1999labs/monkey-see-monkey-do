// Prints the exact prompt text and SHA-256 for every prompt: the three SEE
// tasks and the DO chain prompt. Compare against src/prompt-digests.mjs.
//
// Exits 1 when any digest does not match, so the check is usable as a gate by
// anything that reads exit codes; a mismatch used to be a printed line and a
// 0, indistinguishable from a match to any script. The runtime self-test
// enforces the same comparison before any model runs.
import { allPromptDigests } from "../src/see/prompt.mjs";
import { allPromptDigests as doPromptDigests, POOL_SEED_HEX } from "../src/do/chain/prompt.mjs";
import { SUITE_VERSION as DIGESTS_SUITE_VERSION } from "../src/prompt-digests.mjs";
import { RECORDED_DIGESTS } from "../src/prompt-digests.mjs";

let mismatches = 0;
const all = [...allPromptDigests(), ...doPromptDigests()];
for (const { taskId, prompt, digest } of all) {
  console.log(`=== ${taskId === "DO" ? "MONKEY DO (chain eval)" : `TASK ${taskId}`} ===`);
  console.log(prompt);
  const ok = RECORDED_DIGESTS[taskId] === digest;
  if (!ok) mismatches++;
  console.log(`--- sha256: ${digest}  (${ok ? "matches the recorded digest" : "DOES NOT MATCH the recorded digest"})`);
  console.log();
}
console.log(`${all.length - mismatches}/${all.length} digests match src/prompt-digests.mjs`);
// POOL_SEED_HEX is the hex with a "0x" prefix (e.g. "0xC0FFEE"). Strip it
// here so we don't double-prefix and print "0x0XC0FFEE".
console.log(`(suite seed 0x${POOL_SEED_HEX.toUpperCase().replace(/^0X/, "")}; suite version ${DIGESTS_SUITE_VERSION})`);
if (mismatches > 0) process.exit(1);