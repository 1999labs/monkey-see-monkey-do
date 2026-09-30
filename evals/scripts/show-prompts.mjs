// Prints the exact prompt text and SHA-256 for every prompt: the three SEE
// tasks and the DO solver prompt. Compare against src/prompt-digests.mjs.
// Run: node scripts/show-prompts.mjs
import { allPromptDigests } from "../src/see/prompt.mjs";
import { allPromptDigests as doPromptDigests } from "../src/do/prompt.mjs";
import { RECORDED_DIGESTS } from "../src/prompt-digests.mjs";

for (const { taskId, prompt, digest } of [...allPromptDigests(), ...doPromptDigests()]) {
  console.log(`=== ${taskId === "DO" ? "MONKEY DO" : `TASK ${taskId}`} ===`);
  console.log(prompt);
  const pinned = RECORDED_DIGESTS[taskId] === digest ? "matches the recorded digest" : "DOES NOT MATCH the recorded digest";
  console.log(`--- sha256: ${digest}  (${pinned})`);
  console.log();
}
