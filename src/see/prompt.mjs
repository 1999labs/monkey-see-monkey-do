// MONKEY SEE — prompt construction.
//
// INTEGRITY: this module builds what the model SEES. It must never import
// reference.mjs. It reads shown examples only, never held-out cases, and
// never states the rule. A self-test check enforces both properties.
//
// Every model must receive byte-identical text for a given task, so the
// prompt is hashed (SHA-256) and the digest is recorded in the report. Two
// scores are only comparable if the thing being scored was the same.
//
// PHASE 4 (suite 1.0.0): the SEE eval now runs at four sample levels
// (2, 4, 8, 16). The prompt takes the FIRST `samples` shown examples of
// the task. Level 8 is the current behavior: all 8 shown examples go
// into the prompt. Levels 2, 4 and 16 are new slots; their digests are
// pinned alongside the level-8 digests in src/prompt-digests.mjs so a
// score can always be re-derived from the exact prompt that produced it.

import { createHash } from "node:crypto";

import { tasks, formatExample } from "./tasks.mjs";

/** The four sample levels (frozen at Phase 1). */
export const SAMPLE_LEVELS = [2, 4, 8, 16];

/** Default samples for backward compat — old code paths call
 * `buildPrompt(task)` with no second arg and expect all 8 shown examples. */
const DEFAULT_SAMPLES = 8;

// The fixed preamble, byte-identical for every task and every model.
// Line breaks here are load-bearing: changing one changes every digest.
export const PREAMBLE = [
  "Below are input->output examples of a single function f. The rule is",
  "consistent across all examples. Write the function f in JavaScript.",
  "Output only the code, no explanation.",
].join("\n");

/**
 * Build the prompt for one task at a given sample level.
 *
 * `samples` is the number of shown examples to render (the first `samples`
 * entries of `task.shown`). The full shown list always has 8; levels 2/4
 * render a prefix, level 8 renders all 8 (current behavior, byte-
 * identical to a no-arg call), level 16 is rejected by the validator in
 * tasks.mjs for tasks with only 8 shown examples.
 *
 * Tasks that ship fewer than `samples` shown examples throw — the prompt
 * is structurally invalid, not a soft error.
 *
 * @param {object} task  one entry from tasks.mjs
 * @param {number} [samples=8]  how many of task.shown to render
 * @returns {string} the prompt text, no trailing newline
 */
export const buildPrompt = (task, samples = DEFAULT_SAMPLES) => {
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(`buildPrompt: samples must be a positive integer, got ${samples}`);
  }
  if (samples > task.shown.length) {
    throw new Error(
      `buildPrompt: task ${task.id} has only ${task.shown.length} shown examples, ` +
        `cannot render ${samples}`
    );
  }
  const examples = task.shown.slice(0, samples).map(formatExample).join("\n");
  return [PREAMBLE, "", task.signatureHint, "", examples].join("\n");
};

/** SHA-256 of the exact prompt text, hex encoded. */
export const hashPrompt = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The digest recorded in a report so a score can be re-derived later.
 *
 * Default `samples = 8` keeps the old signature so callers that don't
 * know about levels still get the existing behavior. */
export const promptDigest = (task, samples = DEFAULT_SAMPLES) => hashPrompt(buildPrompt(task, samples));

/** All level-8 prompt digests — the backward-compat slot the rest of
 * the suite reads today. Two scores are only comparable if both were
 * recorded under the same level-8 digest. */
export const allPromptDigests = () =>
  tasks.map((task) => ({ taskId: task.id, level: 8, digest: promptDigest(task), prompt: buildPrompt(task) }));

/**
 * All prompt digests for ALL levels (2, 4, 8, 16) and ALL tasks. Used by
 * the self-test to pin the new digests alongside the existing ones.
 */
export const allLevelDigests = () =>
  tasks.flatMap((task) =>
    SAMPLE_LEVELS.map((level) => ({
      taskId: task.id,
      level,
      digest: promptDigest(task, level),
    }))
  );

export const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));