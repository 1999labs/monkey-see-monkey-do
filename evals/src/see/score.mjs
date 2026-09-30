// Scoring for MONKEY SEE.
//
// Expected values are NEVER read from storage. They are derived at runtime by
// calling each task's reference, so the held-out inputs and the ground truth
// cannot drift apart. This module is the only other place allowed to reach
// ground truth, via the loader in tasks.mjs.

import { tasks } from "./tasks.mjs";

const BUCKETS = ["core", "boundary", "adversarial"];

// Deep equality that distinguishes null from undefined and [] from {}.
const isDeepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => isDeepEqual(v, b[i]));
  }
  if (typeof a !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && isDeepEqual(a[k], b[k]));
};

// Call a candidate function, treating ANY throw as a failed case rather than
// a harness error.
const attempt = (fn, input) => {
  try {
    return { ok: true, value: fn(input) };
  } catch (err) {
    return { ok: false, value: undefined, error: String(err && err.message) };
  }
};

const scoreCases = (fn, inputs, expectedFor) => {
  let correct = 0;
  let threw = 0;
  const failures = [];
  for (const input of inputs) {
    const r = attempt(fn, input);
    if (!r.ok) {
      threw++;
      failures.push({ input, expected: expectedFor(input), got: "<threw>" });
      continue;
    }
    if (isDeepEqual(r.value, expectedFor(input))) {
      correct++;
    } else {
      failures.push({ input, expected: expectedFor(input), got: r.value });
    }
  }
  return { total: inputs.length, correct, threw, failures };
};

// Flatten a task's held-out buckets into an ordered case list.
export const heldOutCases = (task) =>
  BUCKETS.flatMap((bucket) => task.heldOut[bucket].map((input) => ({ bucket, input })));

// Score one task with a candidate function. `fn` is the function a model wrote.
export const scoreTask = (task, fn) => {
  const cases = heldOutCases(task);
  const result = scoreCases(fn, cases.map((c) => c.input), task.reference);

  const perBucket = {};
  for (const bucket of BUCKETS) {
    const bucketCases = cases.filter((c) => c.bucket === bucket);
    const r = scoreCases(fn, bucketCases.map((c) => c.input), task.reference);
    perBucket[bucket] = { correct: r.correct, total: r.total };
  }

  return {
    taskId: task.id,
    name: task.name,
    total: result.total,
    correct: result.correct,
    threw: result.threw,
    rate: result.correct / result.total,
    perBucket,
    failures: result.failures,
  };
};

/**
 * The held-out result for a task whose response could not be used at all.
 *
 * Every one of its 50 cases counts as failed AND as thrown: a response with no
 * callable function cannot produce a non-throwing case. The first version left
 * such tasks out of the held-out arm and the robustness bonus entirely, while
 * the SEEN arm still counted their 8 shown examples as failures. With Task A
 * answered in prose and B and C perfect, that reported a Monkey Index of -33
 * (a number the interpretation table has no row for) and a full 5/5 robustness
 * bonus. guide.md 4.7 and 4.8 define both over all 150 cases.
 */
export const unusableResult = (task, reason = "unusable response") => ({
  ...scoreTask(task, () => {
    throw new Error(reason);
  }),
  unusable: true,
});

// The 8 shown examples, re-run through the returned function. This is the
// "SEEN" arm of the Monkey Index and pools all three tasks (24 examples).
export const scoreSeen = (fnByTask) => {
  let correct = 0;
  let total = 0;
  const perTask = [];
  for (const task of tasks) {
    let taskCorrect = 0;
    for (const { input, output } of task.shown) {
      const r = attempt(fnByTask[task.id], input);
      if (r.ok && isDeepEqual(r.value, output)) taskCorrect++;
    }
    correct += taskCorrect;
    total += task.shown.length;
    perTask.push({ taskId: task.id, correct: taskCorrect, total: task.shown.length });
  }
  return { correct, total, rate: correct / total, perTask };
};

// MONKEY INDEX = (SEEN pass rate) - (HELD-OUT pass rate)
// Both sides pool all three tasks, so the subtraction is like-for-like.
export const monkeyIndex = (seen, taskResults) => {
  const heldOutCorrect = taskResults.reduce((sum, r) => sum + r.correct, 0);
  const heldOutTotal = taskResults.reduce((sum, r) => sum + r.total, 0);
  const heldOutRate = heldOutCorrect / heldOutTotal;
  return {
    seen: seen.rate,
    heldOut: heldOutRate,
    index: seen.rate - heldOutRate,
  };
};

/**
 * Read a Monkey Index as a statement about two score sets.
 *
 * Deliberately descriptive, never interpretive. The index is a difference in
 * pass rates, so the most it can support is a claim about how far performance
 * on the shown examples predicted performance on unseen inputs.
 *
 * What a LOW index does NOT establish: that the model induced a general rule.
 * A shallow heuristic fitted to this generator's held-out input shapes would
 * score identically to a principled induction. Telling those apart needs a
 * held-out task family — a task the model provably could not have seen — and
 * the suite does not have one.
 *
 * What a HIGH index does establish, and it is worth stating plainly: the shown
 * score carried no information about the held-out score. That much is arithmetic.
 */
export const readIndex = (index) => {
  if (index <= 10) return "generalizes — held-out performance matches shown performance";
  if (index <= 30) return "mostly generalizes — held-out trails shown on some cases";
  if (index <= 60) return "partial — fits the shown examples better than new ones";
  return "SURFACE FIT — shown performance carried no information about held-out";
};

// --- Robustness bonus ----------------------------------------------------
//
// Worth 5 of the 50 points. It measures one thing only: whether the model's
// code THROWS on held-out inputs. It never measures whether the answers were
// right — that is what the 45 task points already do.
//
// Why proportional rather than all-or-nothing: an earlier version awarded the
// full 5 only if nothing threw at all, across all 150 cases. Measurement
// showed a model that had learned Task B perfectly, and simply missed the
// empty-string guard, scored an identical 49/50 either way — but lost all 5
// points. One input out of 150 was silently worth 10% of the score.
//
// Proportional removes the cliff. A single missed guard costs 5/150 of a
// point, which is the right magnitude for a single missed guard. A model that
// throws on everything still scores zero, and the naive baseline (which never
// throws) keeps its full bonus, so the calibrated bands do not move.
//
// The categorical question "did this submission crash at all?" is still worth
// answering, but it is a different question from "how robust is this code?".
// It is reported separately as `crashed` rather than being priced into the
// score.

/** Maximum points available from the robustness bonus. */
export const ROBUSTNESS_POINTS = 5;

/**
 * Award the robustness bonus in proportion to the held-out cases that did not
 * throw.
 *
 * @param {Array<{threw: number, total: number}>} taskResults
 * @returns {{ points: number, threw: number, total: number, rate: number, crashed: boolean }}
 */
export const robustnessBonus = (taskResults) => {
  const threw = taskResults.reduce((sum, r) => sum + r.threw, 0);
  const total = taskResults.reduce((sum, r) => sum + r.total, 0);
  // With nothing scored there is nothing to reward, and awarding 5/5 for an
  // empty result set would be a free bonus for a total failure.
  if (total === 0) return { points: 0, threw: 0, total: 0, rate: 0, crashed: true };
  // The scorer can never report more throws than cases, but a negative bonus
  // would be a silent scoring bug, so the result is clamped rather than
  // trusted. A clamp cannot mask a real error: `threw` and `total` are both
  // reported, so an impossible pair is still visible in the output.
  const nonThrowing = Math.min(total, Math.max(0, total - threw));
  return {
    points: (ROBUSTNESS_POINTS * nonThrowing) / total,
    threw,
    total,
    rate: nonThrowing / total,
    crashed: threw > 0,
  };
};
