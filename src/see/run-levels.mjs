// MONKEY SEE — sample-efficiency runner.
//
//   node src/see/run-levels.mjs [--model <provider/model>]
//
// Loops the SEE eval across the four sample levels (2, 4, 8, 16). For each
// level, the model is asked to write f once; that function is replayed on
// the same 50 held-out inputs (held-out does not depend on the level) and
// on the FIRST `level` entries of each task's shown list. Per-task score is
// a weighted average of held-out pass rate at each level, with weights
// 0.40 / 0.30 / 0.20 / 0.10 for 2 / 4 / 8 / 16. The GZ per level is the
// seen pass rate minus the held-out pass rate at that level; the runner
// reports GZ_mean (unweighted mean across levels) which Phase 5 folds into
// the adjusted total.
//
// ONE model call per (task, level) pair = 12 calls (3 tasks × 4 levels).
// Phase 5 will fold this into the combined report; for now this module
// is a stand-alone runner that prints per-task weighted scores and per-
// level GZ.
//
// A non-network "synthetic" path runs the same scoring against each task's
// reference oracle: that path costs no calls and is what the self-test
// uses to verify the level-8 backward-compat gate (the level-8 prompt
// must produce byte-identical results).

import { tasks } from "./tasks.mjs";
import {
  scoreTaskAcrossLevels,
  scoreSeenAtLevel,
  scoreTask,
  robustnessAcrossLevels,
  SAMPLE_LEVELS,
  SAMPLE_WEIGHTS,
  weightedSum,
} from "./score.mjs";
import { buildPrompt, promptDigest } from "./prompt.mjs";
import { complete } from "../adapters/registry.mjs";
import { compileCandidate, runCandidate } from "../sandbox.mjs";
import { fingerprint } from "../fingerprint.mjs";
import { describeCallFailure } from "../call-failure.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice } from "../cli.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Render a reference oracle as inline JavaScript suitable for a sandbox
 * compile. Reference oracles in this suite are arrow functions; we bind
 * the body to a local variable so the inlined text reads:
 *
 *     (() => { const _ref = (n) => ...; return _ref(input); })()
 *
 * The IIFE pattern keeps the reference bound to `_ref` (not leaked into
 * the outer scope). The caller wraps the result in `return ...` because
 * the surrounding function body's trailing expression is NOT auto-returned
 * (that's an arrow-function shorthand, not a function-body rule).
 */
const nameOrFunction = (ref) => {
  const body = ref.toString();
  return `(() => { const _ref = ${body}; return _ref(input); })()`;
};

const HELP = `
MONKEY SEE — sample levels

  node src/see/run-levels.mjs [--model <provider/model>]
                              [--dry-run]

  --model, -m    the model to score (one call per task per level, 12 calls)
  --key,   -k    your API key
  --dry-run      play the reference oracle as the "model" — no API call,
                 prints the per-task weighted scores and per-level GZ
                 so a future audit can compare real runs against this
                 saturation ceiling.
  --runs, -r     repeat the whole eval N times (default 1)
  --config FILE  model registry

  Examples
    node src/see/run-levels.mjs --dry-run
    node src/see/run-levels.mjs -m ollama/qwen2.5-coder:7b -r 3
`;

/**
 * One (task, level) scoring unit: a compiled candidate, a level, and the
 * subset of held-out cases to score (Phase 4 uses the same 50 cases at
 * every level, but the structure mirrors what a future held-out
 * extension would look like).
 *
 * @param {Function} fn   the compiled model's f
 * @param {object} task
 * @param {number} level
 * @returns {{ seen: number, heldOut: number, threw: number }}
 */
export const scoreAt = (task, fn, level) => {
  const seenEntries = task.shown.slice(0, level);
  let seenCorrect = 0;
  for (const { input, output } of seenEntries) {
    const r = (() => {
      try { return { ok: true, value: fn(input) }; }
      catch (err) { return { ok: false, error: err }; }
    })();
    if (r.ok && r.value === output) seenCorrect++;
  }
  const held = scoreTask(task, fn);
  return { seen: seenCorrect, seenTotal: seenEntries.length, heldOut: held };
};

/**
 * Run one (task, level): compile a response if needed, score, return
 * per-level metrics. Reused by both the model path and the dry-run.
 *
 * `dryRun` skips the compile/sandbox path entirely and uses the task's
 * reference oracle directly as the model's function. That lets the
 * gate prove the scoring path is sound (no model call required) and
 * lets the audit compare a real run against this saturation ceiling.
 */
export const runLevel = async (config, { task, level, dryRun = false, modelText = null } = {}) => {
  const startedAt = Date.now();
  const promptText = buildPrompt(task, level);
  const promptDigest_ = promptDigest(task, level);

  let completion = null;
  let callFailure = null;
  let compiled = null;

  if (modelText !== null) {
    // Synthetic path: caller supplies the model's text directly. Used by
    // the self-test to exercise the scoring path with no network.
    completion = { text: modelText };
    compiled = compileCandidate(completion.text, { entry: "f", isolateCalls: true });
  } else if (dryRun) {
    // No network. Use the task's reference oracle directly as the "model"
    // — a literal `function f(input) { return task.reference(input); }`
    // source string is built, compiled, and replayed through the sandbox.
    // This proves the scoring path works end-to-end without any model call.
    const refSrc = `function f(input) {\n  // dry-run reference oracle for task ${task.id}\n  // (no network; the model is the reference itself)\n  ${task.reference.toString()}\n  return ${nameOrFunction(task.reference)};\n}`;
    completion = { text: refSrc, providerModel: "dry-run/reference" };
    compiled = compileCandidate(completion.text, { entry: "f", isolateCalls: true });
  } else {
    try {
      completion = await complete(config, promptText);
    } catch (err) {
      callFailure = describeCallFailure(err, { startedAt, timeoutMs: config?.timeoutMs ?? null });
    }
    if (!callFailure) {
      compiled = compileCandidate(completion.text, { entry: "f", isolateCalls: true });
    }
  }

  if (callFailure || !compiled) {
    return {
      taskId: task.id, level, promptText, promptDigest_,
      usable: false,
      callFailure: callFailure || null,
      compileError: compiled ? null : "compile failed",
      response: completion?.text ?? "",
    };
  }

  if (!compiled.ok) {
    return {
      taskId: task.id, level, promptText, promptDigest_,
      usable: false, compileError: compiled.error, response: completion.text,
    };
  }

  const fn = (input) => {
    const r = runCandidate(compiled, input);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const seenAtLevel = scoreSeenAtLevel({ [task.id]: fn }, level);
  const heldOut = scoreTask(task, fn);
  return {
    taskId: task.id,
    level,
    promptText,
    promptDigest_,
    usable: true,
    seen: seenAtLevel,
    heldOut: { correct: heldOut.correct, total: heldOut.total, threw: heldOut.threw },
    responseFingerprint: fingerprint(completion.text),
    callElapsedMs: Date.now() - startedAt,
    // Token usage from the adapter, surfaced per-call so the combined
    // report's per-level totals roll up cleanly. Null when the adapter
    // didn't report it (e.g. dry-run path).
    usage: completion.usage ?? null,
  };
};

/**
 * Run all 12 (task, level) combinations for a single model (or the dry-run).
 * Records per-task weighted scores plus per-level GZ, the two numbers the
 * plan pins.
 */
export const runAllLevels = async (config, { dryRun = false } = {}) => {
  const runs = [];
  for (const level of SAMPLE_LEVELS) {
    for (const task of tasks) {
      runs.push({ level, task, out: await runLevel(config, { task, level, dryRun }) });
    }
  }

  // Per-task aggregation. Each (task, level) gives a held-out rate; the
  // per-task weighted score is the held-out-rate-weighted sum across levels.
  // Held-out is the same across levels (same 50 cases), but the contract
  // allows per-level different held-out counts in the future.
  const perTask = {};
  for (const task of tasks) perTask[task.id] = { taskId: task.id, name: task.name, levels: {}, weightedRate: 0, gzMean: 0 };
  const perLevel = {};
  for (const level of SAMPLE_LEVELS) perLevel[level] = { seen: { correct: 0, total: 0 }, heldOut: { correct: 0, total: 0 }, gz: null };

  for (const r of runs) {
    const { task, level, out } = r;
    const entry = perTask[task.id];
    entry.levels[level] = out;
    if (out.usable) {
      const seen = out.seen;
      const held = out.heldOut;
      perLevel[level].seen.correct += seen.correct;
      perLevel[level].seen.total += seen.total;
      perLevel[level].heldOut.correct += held.correct;
      perLevel[level].heldOut.total += held.total;
      // Roll per-call usage up to per-level (sum across the 3 tasks at
      // this level) so the combined report's per-level usage rolls up
      // cleanly. Token totals are summed; null fields stay null.
      const u = out.usage;
      if (u) {
        const lvl = perLevel[level];
        lvl.usageIn = (lvl.usageIn ?? 0) + (u.prompt_tokens ?? 0);
        lvl.usageOut = (lvl.usageOut ?? 0) + (u.completion_tokens ?? 0);
      }
    }
  }
  for (const id of Object.keys(perTask)) {
    const e = perTask[id];
    const rates = {};
    for (const level of SAMPLE_LEVELS) {
      const r = e.levels[level];
      if (r && r.usable) rates[level] = r.heldOut.correct / r.heldOut.total;
    }
    e.weightedRate = weightedSum(rates);
    const gzByLevel = {};
    for (const level of SAMPLE_LEVELS) {
      const r = e.levels[level];
      if (r && r.usable) {
        const seenRate = r.seen.correct / r.seen.total;
        const heldRate = r.heldOut.correct / r.heldOut.total;
        gzByLevel[level] = seenRate - heldRate;
      }
    }
    const gzList = Object.values(gzByLevel);
    e.gzMean = gzList.length ? gzList.reduce((s, x) => s + x, 0) / gzList.length : 0;
    e.gzByLevel = gzByLevel;
  }
  for (const level of SAMPLE_LEVELS) {
    const e = perLevel[level];
    if (e.heldOut.total > 0) {
      const seenRate = e.seen.correct / e.seen.total;
      const heldRate = e.heldOut.correct / e.heldOut.total;
      e.gz = seenRate - heldRate;
      e.seen.rate = seenRate;
      e.heldOut.rate = heldRate;
    }
  }

  // Per-level robustness: total throws across all tasks at that level
  // (each task's held-out arm is the same 50 cases, so accumulating
  // across all levels would double-count; we use a single level's count).
  const firstLevelKey = SAMPLE_LEVELS[0];
  const firstLevelPerTask = Object.values(perTask).map((t) => t.levels[firstLevelKey]);
  const totalThrows = firstLevelPerTask.reduce((s, n) => s + (n?.heldOut?.threw ?? 0), 0);
  const totalHeldOut = firstLevelPerTask.reduce((s, n) => s + (n?.heldOut?.total ?? 0), 0);
  const robustness = {
    points: totalHeldOut ? 5 * (1 - totalThrows / totalHeldOut) : 0,
    threw: totalThrows,
    total: totalHeldOut,
    rate: totalHeldOut ? 1 - totalThrows / totalHeldOut : 0,
    crashed: totalThrows > 0,
  };

  // Total usage across all 12 calls — sum of per-level rollups.
  const usage = {
    prompt_tokens: SAMPLE_LEVELS.reduce((s, l) => s + (perLevel[l].usageIn ?? 0), 0),
    completion_tokens: SAMPLE_LEVELS.reduce((s, l) => s + (perLevel[l].usageOut ?? 0), 0),
  };

  return {
    perTask,
    perLevel,
    robustness,
    runs,
    weights: SAMPLE_WEIGHTS,
    levels: SAMPLE_LEVELS,
    usage,
  };
};

export const printLevelsRun = (label, out) => {
  console.log(`\nMONKEY SEE — sample levels · ${label}`);
  console.log(`\n  per-task weighted score (held-out pass rate × weight):`);
  for (const task of Object.values(out.perTask)) {
    const rates = Object.entries(task.levels)
      .filter(([, r]) => r && r.usable)
      .map(([l, r]) => `L${l}=${(r.heldOut.correct / r.heldOut.total * 100).toFixed(1)}%`)
      .join(" ");
    console.log(`    ${task.taskId}  weightedRate=${(task.weightedRate * 100).toFixed(2)}%  GZ_mean=${(task.gzMean * 100).toFixed(2)}  ${rates}`);
  }
  console.log(`\n  per-level GZ (pooled across all 3 tasks):`);
  for (const [level, e] of Object.entries(out.perLevel)) {
    if (e.heldOut.total > 0) {
      console.log(`    L${level}  seen=${(e.seen.rate * 100).toFixed(2)}%  heldOut=${(e.heldOut.rate * 100).toFixed(2)}%  GZ=${(e.gz * 100).toFixed(2)}`);
    } else {
      console.log(`    L${level}  (no usable runs)`);
    }
  }
  const points = Object.values(out.perTask).reduce((s, t) => s + t.weightedRate * 15, 0);
  console.log(`\n  SEE points: ${points.toFixed(2)} / 45`);
  console.log(`  Robustness: +${out.robustness.points.toFixed(2)} (${out.robustness.threw}/${out.robustness.total} threw)`);
  console.log(`  Total: ${(points + out.robustness.points).toFixed(2)} / 50`);
};

const isMain = (() => {
  try {
    return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href);
  } catch { return false; }
})();

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!args.model && !args.dryRun) {
    console.log(HELP);
    process.exit(1);
  }
  const label = args.dryRun ? "dry-run" : args.model;
  console.log(`\nMONKEY SEE — sample levels · ${label}`);
  await selfTestGate();
  let config = null;
  if (!args.dryRun) ({ config } = await prepareModel(args));
  const runs = [];
  for (let i = 0; i < args.runs; i++) {
    const out = await runAllLevels(config, { dryRun: args.dryRun });
    printLevelsRun(label, out);
    runs.push(out);
  }
  if (config) temperatureNotice(config);
}