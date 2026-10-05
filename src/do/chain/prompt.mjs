// MONKEY DO — the prompt.
//
// INTEGRIty, mirroring prompt.mjs in see/: this module builds what the model
// SEES and must never import the chain pool, the reference solver, or the
// scorer. The model is told the rules of the formal system and asked to
// produce a function; it is never shown the chains it will be scored on.
//
// The prompt is committed text. The digest is recorded in
// src/prompt-digests.mjs so two scores are comparable only if every model
// saw byte-identical bytes. Any change to this file is a deliberate bump
// of SUITE_VERSION (see package.json).

import { createHash } from "node:crypto";
import { rulesForPrompt } from "./rules.mjs";

/** The pool's seed. Carried in the prompt so a model whose training data
 * already contains an older version of this prompt (with a different seed)
 * can be detected by a parity check at run time. See the canary note. */
export const POOL_SEED_HEX = "0xC0FFEE";

/** The committed canary string. Two distinct slots:
 *
 *   - "monkey-do-chain@1.0.0"  the suite version + DO marker. A model
 *     whose training data has this prompt verbatim can be flagged by the
 *     harness: the response either echoes it back or reproduces the exact
 *     comment line near the function, and either is detectable.
 *
 *   - "monkey-do-chain-seed:0xC0FFEE"  the seed. If the prompt changes the
 *     seed and a model already knows the old seed, the run is stale and
 *     should not be scored against the published pool.
 *
 * Both are deliberately unlike prose, so a paraphrase round in a model
 * fails the parity check.
 */
export const CANARY = "monkey-do-chain@1.0.0";
export const SEED_CANARY = `monkey-do-chain-seed:${POOL_SEED_HEX}`;

/**
 * The fixed preamble, byte-identical for every run and every model.
 *
 * Lines here are load-bearing: editing one changes the digest. See
 * src/prompt-digests.mjs for the recorded hash.
 *
 * Structure:
 *   - one-paragraph frame
 *   - the formal system, committed by rulesForPrompt()
 *   - the function contract
 *   - the validity contract
 *   - the scoring contract
 *   - the bands and seed
 *   - the canary (deliberately unlike prose)
 *   - the output instruction
 */
export const PREAMBLE = [
  `You are given a string-rewrite formal system. You will be shown the rules,`,
  `a starting string, and a target string. Your job is to produce a function`,
  `"solve(start, target)" that returns a derivation from start to target as a`,
  `JavaScript array of step objects. Each step has the shape {rule, start, next}:`,
  ``,
  `  rule   one of the rule ids below ("R1" .. "R5")`,
  `  start  the integer position the rule was applied at`,
  `  next   the resulting string after applying the rule`,
  ``,
  `RULES:`,
  rulesForPrompt(),
  ``,
  `SYMBOLS (the alphabet): A B C D X Y Z  (no others appear in any chain)`,
  ``,
  `VALIDITY — every step you emit must be legal under the rules above.`,
  `Specifically, for each step (rule, start, next) in your array:`,
  ``,
  `  - the rule must be APPLICABLE at "start" in the current state`,
  `    (i.e. the rule's trigger must match starting at "start"), AND`,
  `  - "next" must be EXACTLY the state you get by applying that rule at`,
  `    "start" to the current state.`,
  ``,
  `A step that violates either condition is invalid: the derivation is`,
  `scored from step 1 up to (but not including) the first invalid step,`,
  `and the score for the chain is the fraction of valid steps. A wrong`,
  `step at position k zeros everything from k+1 onward.`,
  ``,
  `The derivation does NOT have to be the shortest. Any valid derivation`,
  `that ends with the state equal to "target" is a full-score derivation`,
  `for that chain. A shorter derivation (one whose path happens to be`,
  `shorter than the pool's nominal length for that band) is also full credit`,
  `— the scorer grades "did you reach the target by legal moves", not`,
  `"how many moves did you take".`,
  ``,
  `If no chain is solvable from your function's perspective (for example,`,
  `because you could not find any derivation), return an empty array [].`,
  `An empty array is a scored 0 on that chain, not an error.`,
  ``,
  `POOL — 50 chains across 5 length bands. Each chain is a (start, target)`,
  `pair and your function is asked once per chain. The bands are`,
  `deterministic from seed ${POOL_SEED_HEX}:`,
  ``,
  `  L5   10 chains,  5-step derivations each  (easiest band)`,
  `  L10  10 chains,  10-step derivations each`,
  `  L20  10 chains,  20-step derivations each`,
  `  L30  10 chains,  30-step derivations each`,
  `  L50  10 chains,  50-step derivations each`,
  ``,
  `Scoring: each chain is worth 10 points in its band; band score is the`,
  `mean chain score across that band; the total is the sum of band scores`,
  `(out of 50). Full credit requires a valid derivation reaching target.`,
  ``,
  `CANARY — this prompt carries a canary string. Reproduce it verbatim`,
  `in a comment block at the top of your answer, so a stale prompt (one`,
  `whose seed differs from the published pool's) is detectable:`,
  ``,
  `  // ${CANARY}`,
  `  // ${SEED_CANARY}`,
  ``,
  `Output only the code (no explanation), and include the canary as the`,
  `first two lines of your response.`,
].join("\n");

/** SHA-256 of the exact prompt text, hex encoded. */
export const hashPrompt = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The prompt, and its digest. Identical on every call — the model is called once. */
export const buildPrompt = () => PREAMBLE;
export const promptDigest = () => hashPrompt(PREAMBLE);

/** All DO prompt digests in the form the self-test expects. The key
 * is the canary version (used by self-test pins) and the value is the
 * recorded SHA-256. */
export const allPromptDigests = () => [
  { taskId: "DO", digest: promptDigest(), prompt: PREAMBLE, canary: CANARY },
];

/**
 * Detect a model that returns an answer mentioning a different prompt's
 * canary (for example, a signature from a prompt other than this suite's).
 * The check is a substring match on the response — a paraphrase round will
 * not reproduce the canary verbatim.
 *
 * @returns {{ ok: boolean, missingCanary: boolean, missingSeedCanary: boolean }}
 */
export const checkCanary = (response) => {
  const text = String(response ?? "");
  return {
    ok: text.includes(CANARY) && text.includes(SEED_CANARY),
    missingCanary: !text.includes(CANARY),
    missingSeedCanary: !text.includes(SEED_CANARY),
  };
};