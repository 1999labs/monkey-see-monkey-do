// Prints the exact prompt text and SHA-256 for every prompt: the three SEE
// tasks and the DO solver prompt. Compare against src/prompt-digests.mjs.
//
// Exits 1 when any digest does not match, so the check is usable as a gate by
// anything that reads exit codes; a mismatch used to be a printed line and a
// 0, indistinguishable from a match to any script. The runtime self-test
// enforces the same comparison before any model runs.
import { allPromptDigests } from "../src/see/prompt.mjs";
import { allPromptDigests as doPromptDigests } from "../src/do/prompt.mjs";
import { RECORDED_DIGESTS } from "../src/prompt-digests.mjs";

let mismatches = 0;
const all = [...allPromptDigests(), ...doPromptDigests()];
for (const { taskId, prompt, digest } of all) {
  console.log(`=== ${taskId === "DO" ? "MONKEY DO" : `TASK ${taskId}`} ===`);
  console.log(prompt);
  const ok = RECORDED_DIGESTS[taskId] === digest;
  if (!ok) mismatches++;
  console.log(`--- sha256: ${digest}  (${ok ? "matches the recorded digest" : "DOES NOT MATCH the recorded digest"})`);
  console.log();
}
console.log(`${all.length - mismatches}/${all.length} digests match src/prompt-digests.mjs`);
if (mismatches > 0) process.exit(1);
