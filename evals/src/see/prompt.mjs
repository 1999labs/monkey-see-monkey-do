// MONKEY SEE — prompt construction.
//
// INTEGRITY: this module builds what the model SEES. It must never import
// reference.mjs. It reads shown examples only, never held-out cases, and
// never states the rule. A self-test check enforces both properties.
//
// Every model must receive byte-identical text for a given task, so the
// prompt is hashed (SHA-256) and the digest is recorded in the report. Two
// scores are only comparable if the thing being scored was the same.

import { createHash } from "node:crypto";

import { tasks, formatExample } from "./tasks.mjs";

// The fixed preamble, byte-identical for every task and every model.
// Line breaks here are load-bearing: changing one changes every digest.
export const PREAMBLE = [
  "Below are input->output examples of a single function f. The rule is",
  "consistent across all examples. Write the function f in JavaScript.",
  "Output only the code, no explanation.",
].join("\n");

/**
 * Build the prompt for one task.
 *
 * Structure: PREAMBLE, blank line, signature hint, blank line, examples.
 * No trailing newline — the digest covers exactly what we send.
 */
export const buildPrompt = (task) => {
  const examples = task.shown.map(formatExample).join("\n");
  return [PREAMBLE, "", task.signatureHint, "", examples].join("\n");
};

/** SHA-256 of the exact prompt text, hex encoded. */
export const hashPrompt = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The digest recorded in a report so a score can be re-derived later. */
export const promptDigest = (task) => hashPrompt(buildPrompt(task));

/** All three SEE prompts with their digests, in task order. */
export const allPromptDigests = () =>
  tasks.map((task) => ({ taskId: task.id, digest: promptDigest(task), prompt: buildPrompt(task) }));

export const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
