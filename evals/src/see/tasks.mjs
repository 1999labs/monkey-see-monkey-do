// Task loading and validation.
//
// Reads tasks/*.json and joins each task to its ground truth. This is the only
// place the two are combined.
//
// WHY THE SPLIT EXISTS — the held-out data format, settled here deliberately:
//
//   tasks/*.json   shown examples (input + output) and held-out INPUTS only.
//                  No expected values are stored for held-out cases.
//   reference.mjs  the true rule. Never leaves the harness.
//
// Expected values for held-out cases are computed by calling the reference at
// runtime. Storing them would create two sources of truth that can disagree,
// and we have already shipped one instance of exactly that bug: Task C's shown
// example stated 0 where the rule gives -1. Deriving them makes drift
// structurally impossible rather than
// merely unlikely.
//
// Note the asymmetry, which is deliberate: the SHOWN examples do store their
// outputs, because those must be rendered into the prompt and the model has to
// see them. They are part of the task's definition, not the answer key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { groundTruth } from "./reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUCKETS = ["core", "boundary", "adversarial"];

const load = (file) => JSON.parse(readFileSync(join(HERE, "tasks", file), "utf8"));

// A task that does not match its shape is a harness bug, not a model failure.
// Fail loudly at load time rather than scoring against a malformed set.
const validate = (task) => {
  const problems = [];
  if (!groundTruth[task.id]) problems.push(`no ground truth registered for id "${task.id}"`);
  if (!Array.isArray(task.shown)) problems.push("shown must be an array");
  else if (task.shown.length !== 8) problems.push(`shown must have 8 examples, has ${task.shown.length}`);
  for (const entry of task.shown ?? []) {
    // Shown entries carry an output: they are rendered into the prompt.
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`shown entry must be an object, got ${JSON.stringify(entry)}`);
    } else if (!("input" in entry) || !("output" in entry)) {
      problems.push(`shown entry needs both input and output: ${JSON.stringify(entry)}`);
    }
  }
  if (!task.heldOut) problems.push("heldOut missing");
  else {
    for (const bucket of BUCKETS) {
      if (!Array.isArray(task.heldOut[bucket])) problems.push(`heldOut.${bucket} must be an array`);
    }
    const total = BUCKETS.reduce((n, b) => n + (task.heldOut[b]?.length ?? 0), 0);
    if (total !== 50) problems.push(`heldOut must total 50 cases, has ${total}`);
  }
  if (problems.length) {
    throw new Error(`task ${task.id} (${task.name}) is malformed:\n  - ${problems.join("\n  - ")}`);
  }
  return task;
};

const attach = (task) => ({
  ...task,
  reference: groundTruth[task.id].reference,
  naive: groundTruth[task.id].naive,
});

const raw = [load("taskA.json"), load("taskB.json"), load("taskC.json")];
raw.forEach(validate);

// Order matters: the Monkey Index and the console output assume A, B, C.
export const tasks = raw.map(attach);

export const [taskA, taskB, taskC] = tasks;

export const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));

/**
 * Render one value the way it appears in a prompt, e.g. f("apple") -> "apple"
 * or f([1, 2, 3]) -> 2. Kept here so the prompt and the docs cannot disagree
 * about formatting.
 */
export const formatValue = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
};

export const formatExample = ({ input, output }) => `f(${formatValue(input)}) -> ${formatValue(output)}`;
