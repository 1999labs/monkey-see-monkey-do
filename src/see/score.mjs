// Scoring for MONKEY SEE.
//
// Expected values are NEVER read from storage. They are derived at runtime by
// calling each task's reference, so the held-out inputs and the ground truth
// cannot drift apart. This module is the only other place allowed to reach
// ground truth, via the loader in tasks.mjs.
//
// PHASE 4 (suite 1.0.0): the eval runs at four sample levels (2, 4, 8, 16).
// The "seen" arm of the Generalization Index is the FIRST `samples` entries
// of task.shown (not the full list); the held-out arm is unchanged. Each
// level produces its own seen/held-out rates and its own Generalization Index
// (GZ), and the per-task total is a weighted average across levels. The
// robustness bonus accumulates throws across ALL levels, since a submission
// is robust only if it survives held-out cases in every level's run.

import { tasks } from "./tasks.mjs";

/** The four sample levels (frozen at Phase 1). */
export const SAMPLE_LEVELS = [2, 4, 8, 16];

/** Per-level weights for the per-task weighted score. Lower sample counts
 * are harder and more discriminating, so they get more weight. */
export const SAMPLE_WEIGHTS = { 2: 0.40, 4: 0.30, 8: 0.20, 16: 0.10 };

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

// Score every case exactly once. The first version ran each held-out case
// TWICE — once for the totals and once per bucket — so a nondeterministic
// submission (Math.random and Date are available to model code) could return
// a per-bucket breakdown that disagreed with its own totals. Each case is now
// scored once and bucketed from that single pass.
const scoreCases = (fn, cases, expectedFor) => {
  let correct = 0;
  let threw = 0;
  const failures = [];
  const perCase = [];
  for (const { bucket, input } of cases) {
    const r = attempt(fn, input);
    if (!r.ok) {
      threw++;
      perCase.push({ bucket, ok: false });
      failures.push({ input, expected: expectedFor(input), got: "<threw>" });
      continue;
    }
    const ok = isDeepEqual(r.value, expectedFor(input));
    perCase.push({ bucket, ok });
    if (ok) correct++;
    else failures.push({ input, expected: expectedFor(input), got: r.value });
  }
  return { total: cases.length, correct, threw, failures, perCase };
};

// Flatten a task's held-out buckets into an ordered case list.
export const heldOutCases = (task) =>
  BUCKETS.flatMap((bucket) => task.heldOut[bucket].map((input) => ({ bucket, input })));

// Score one task with a candidate function. `fn` is the function a model wrote.
export const scoreTask = (task, fn) => {
  const cases = heldOutCases(task);
  const result = scoreCases(fn, cases, task.reference);

  const perBucket = {};
  for (const bucket of BUCKETS) {
    const rows = result.perCase.filter((c) => c.bucket === bucket);
    perBucket[bucket] = { correct: rows.filter((c) => c.ok).length, total: rows.length };
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
 * Phase 4: the seen arm at a specific sample level. Only the FIRST
 * `samples` shown entries of the task are scored against the model's
 * function. The held-out arm is unchanged.
 *
 * Returns { correct, total, rate, perTask }. The shape matches
 * `scoreSeen` so the existing GZ arithmetic can consume either.
 */
export const scoreSeenAtLevel = (fnByTask, samples) => {
  let correct = 0;
  let total = 0;
  const perTask = [];
  for (const task of tasks) {
    if (samples > task.shown.length) {
      continue;
    }
    if (typeof fnByTask[task.id] !== "function") {
      // The Phase 4 runner scores one (task, level) at a time. A missing
      // function means the caller is not interested in this task at this
      // level — skip silently rather than counting its iteration toward the
      // total, which would silently inflate the denominator.
      continue;
    }
    let taskCorrect = 0;
    const entries = task.shown.slice(0, samples);
    for (const { input, output } of entries) {
      const r = attempt(fnByTask[task.id], input);
      if (r.ok && isDeepEqual(r.value, output)) taskCorrect++;
    }
    correct += taskCorrect;
    total += entries.length;
    perTask.push({ taskId: task.id, correct: taskCorrect, total: entries.length });
  }
  return { correct, total, rate: total ? correct / total : 0, perTask };
};

/**
 * Phase 4: held-out arm of a task at a given sample level. The arm does
 * not depend on the sample level — only the seen arm does. This helper
 * is here so the level runner's structure stays consistent.
 */
export const scoreTaskAtLevel = (task, fn) => scoreTask(task, fn);

/**
 * Phase 4: per-task score across all sample levels.
 *
 *   - `perLevel`: { [level]: { seen: {correct,total,rate}, heldOut: {correct,total,rate}, gz } }
 *   - `weightedRate`: weighted sum of heldOut.rate across levels
 *   - `gzMean`: unweighted mean of per-level gz values (Phase 5 folds this
 *     into the adjusted formula)
 *
 * `fnByTask` is { taskId: function }. `levels` defaults to SAMPLE_LEVELS.
 *
 * Held-out score at every level uses the SAME 50 inputs and the SAME held-out
 * arm — the level only changes how many shown examples the model saw.
 */
export const scoreTaskAcrossLevels = (task, fn, levels = SAMPLE_LEVELS) => {
  const perLevel = {};
  // Compute held-out once: it doesn't depend on the level. Held-out rate
  // is the same number across levels, but the per-level structure is
  // uniform (seen + heldOut + gz) so the consumer code stays simple.
  const heldOutResult = scoreTask(task, fn);
  for (const level of levels) {
    // We need a synthetic scoreSeen result for this level: only the FIRST
    // `level` entries of task.shown. The model is invoked by the caller
    // via fnByTask; here we accept a function directly so the caller can
    // share one compiled candidate across levels.
    let seenCorrect = 0;
    const entries = task.shown.slice(0, level);
    for (const { input, output } of entries) {
      const r = attempt(fn, input);
      if (r.ok && isDeepEqual(r.value, output)) seenCorrect++;
    }
    const seenRate = entries.length ? seenCorrect / entries.length : 0;
    const gz = seenRate - heldOutResult.rate;
    perLevel[level] = {
      seen: { correct: seenCorrect, total: entries.length, rate: seenRate },
      heldOut: {
        correct: heldOutResult.correct,
        total: heldOutResult.total,
        rate: heldOutResult.rate,
      },
      gz,
      threw: heldOutResult.threw,
    };
  }
  const weightedRate = weightedSum(Object.fromEntries(
    Object.entries(perLevel).map(([l, r]) => [Number(l), r.heldOut.rate])
  ));
  return { taskId: task.id, name: task.name, perLevel, weightedRate };
};

/**
 * Phase 4: weighted sum of a level-keyed record using SAMPLE_WEIGHTS.
 * Missing levels contribute 0 (so a partially-run scoring path doesn't
 * silently promote missing levels).
 */
export const weightedSum = (ratesByLevel) => {
  let total = 0;
  for (const [level, rate] of Object.entries(ratesByLevel)) {
    total += (SAMPLE_WEIGHTS[Number(level)] ?? 0) * rate;
  }
  return total;
};

/**
 * Phase 4: accumulate throws across all levels' held-out arms.
 *
 * Held-out arms all use the SAME 50 cases, so naively summing throws
 * across levels would count the same throw 4 times. Instead, this
 * function reports (a) the count of cases that did not throw at any
 * level, and (b) the throw count from a single held-out arm (which
 * is the right number to subtract from the maximum bonus).
 *
 * Since the held-out arm is identical across levels, the answer is the
 * same single-level throw count. But the contract accepts per-level
 * results so future levels with different held-out sets stay right too.
 */
export function robustnessAcrossLevels(perLevel) {
  // The first level's held-out represents the run (every level hits the
  // same 50 cases). Future-proof the call: prefer the level with the
  // smallest heldOut.total so a partial subset doesn't double-count.
  let best = null;
  for (const v of Object.values(perLevel)) {
    if (!best || v.heldOut.total < best.heldOut.total) best = v;
  }
  const threw = best ? best.threw : 0;
  const total = best ? best.heldOut.total : 0;
  if (total === 0) return { points: 0, threw: 0, total: 0, rate: 0, crashed: true };
  const nonThrowing = Math.min(total, Math.max(0, total - threw));
  return {
    points: (ROBUSTNESS_POINTS * nonThrowing) / total,
    threw,
    total,
    rate: nonThrowing / total,
    crashed: threw > 0,
  };
}

/**
 * The held-out result for a task whose response could not be used at all.
 *
 * Every one of its 50 cases counts as failed AND as thrown: a response with no
 * callable function cannot produce a non-throwing case. The first version left
 * such tasks out of the held-out arm and the robustness bonus entirely, while
 * the SEEN arm still counted their 8 shown examples as failures. With Task A
 * answered in prose and B and C perfect, that reported a Generalization Index of -33
 * (a number the interpretation table has no row for) and a full 5/5 robustness
 * bonus. Both the task points and the index are defined over all 150 cases.
 */
export const unusableResult = (task, reason = "unusable response") => ({
  ...scoreTask(task, () => {
    throw new Error(reason);
  }),
  unusable: true,
});

// The 8 shown examples, re-run through the returned function. This is the
// "SEEN" arm of the Generalization Index and pools all three tasks (24 examples).
//
// `samples` defaults to 8 (the backward-compat slot; the level-8 SEE
// behavior). Pass a different value for the new sample-level axis.
export const scoreSeen = (fnByTask, samples = 8) => {
  let correct = 0;
  let total = 0;
  const perTask = [];
  for (const task of tasks) {
    let taskCorrect = 0;
    const entries = task.shown.slice(0, samples);
    for (const { input, output } of entries) {
      const r = attempt(fnByTask[task.id], input);
      if (r.ok && isDeepEqual(r.value, output)) taskCorrect++;
    }
    correct += taskCorrect;
    total += entries.length;
    perTask.push({ taskId: task.id, correct: taskCorrect, total: entries.length });
  }
  return { correct, total, rate: correct / total, perTask };
};

// MONKEY INDEX = (SEEN pass rate) - (HELD-OUT pass rate)
// Both sides pool all three tasks, so the subtraction is like-for-like.
//
// `samples` defaults to 8 for backward compat with the old single-level
// SEE path. The level-8 behavior must stay byte-identical to the old
// behavior, so callers that don't know about levels see the same
// `task.shown[0..7]` slice.
export const generalizationIndex = (seen, taskResults) => {
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
 * Read a Generalization Index as a statement about two score sets.
 *
 * Deliberately descriptive, never interpretive. The index is a difference in
 * pass rates, so the most it can support is a claim about how far performance
 * on the shown examples predicted performance on unseen inputs.
 *
 * What a LOW index does NOT establish: that the model induced a general rule.
 * A shallow heuristic fitted to this generator's held-out input shapes would
 * score identically to a principled induction. Telling those apart needs a
 * held-out task family (a task the model provably could not have seen), and
 * the suite does not have one.
 *
 * What a HIGH index does establish, and it is worth stating plainly: the shown
 * score carried no information about the held-out score. That much is arithmetic.
 */
export const readIndex = (index) => {
  // The label and its explanation are separated by a colon, not an em dash, to
  // match how the README quotes these bands.
  if (index <= 10) return "generalizes: held-out performance matches shown performance";
  if (index <= 30) return "mostly generalizes: held-out trails shown on some cases";
  if (index <= 60) return "partial: fits the shown examples better than new ones";
  return "SURFACE FIT: shown performance carried no information about held-out";
};

// --- Robustness bonus ----------------------------------------------------
//
// Worth 5 of the 50 points. It measures one thing only: whether the model's
// code THROWS on held-out inputs. It never measures whether the answers were
// right, which is what the 45 task points already do.
//
// Why proportional rather than all-or-nothing: an earlier version awarded the
// full 5 only if nothing threw at all, across all 150 cases. Measurement
// showed a model that had learned Task B perfectly, and simply missed the
// empty-string guard, scored an identical 49/50 either way but lost all 5
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
