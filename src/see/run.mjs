// MONKEY SEE — run the eval against a model.
//
//   node src/see/run.mjs --model openrouter/dots-3-note-preview:free
//
// One call per task, temperature 0, no system prompt, no retry on a received
// answer. The prompt digest is recorded in the report so a score can always be
// traced back to the exact text that produced it.

import { complete } from "../adapters/registry.mjs";
import { tasks, taskById } from "./tasks.mjs";
import { buildPrompt, promptDigest, allPromptDigests } from "./prompt.mjs";
import { scoreTask, scoreSeen, generalizationIndex, readIndex, robustnessBonus, unusableResult } from "./score.mjs";
import { compileCandidate, runCandidate } from "../sandbox.mjs";
import { describeCallFailure } from "../call-failure.mjs";
import { reproducibility } from "../fingerprint.mjs";
import { buildSeeLevelsReport, writeSeeLevelsReport, LIMITATIONS } from "../report.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice, printLimitations } from "../cli.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const HELP = `
MONKEY SEE

  node src/see/run.mjs --model <provider/model>

  --model, -m    the model to score, e.g.
                   openrouter/dots-3-note-preview:free
                   ollama/qwen2.5-coder:7b
                 or any id defined in config/models.json
  --key,   -k    your API key. Usually unnecessary: the tool looks in the
                 provider's environment variable, ~/.config/monkeydo, then .env,
                 and prints setup instructions if none is found.
  --interactive, -i
                 paste the key at a prompt instead. Off by default, because a
                 prompt cannot be trusted to behave in every terminal.
  --runs,  -r    repeat the whole eval N times to check stability
                 (default 1; use 3 for a temperature-0 sanity check)
  --config FILE  model registry (default config/models.json)

  --i-cannot-control-temperature
                 required to score a model whose config says it cannot run at
                 temperature 0. The result is stamped as not comparable.

  REPRODUCIBILITY (optional, but strongly recommended)

  --seed, -s          fixed RNG seed sent with every request
  --only-provider     pin to one OpenRouter provider. Get the list with:
                      npm run providers -- -m <model>
  --no-fallback       refuse to switch provider if the pinned one is down.
                      Prefer this: a fallback is a different machine, and so
                      a different answer.
  --order-provider    a,b,c   try providers in this order.

  OUTPUT

  --out DIR   where to write the JSON result
              (default: results/, giving results/<model>-<date>.json)

  Examples
    node src/see/run.mjs -m openrouter/dots-3-note-preview:free
    node src/see/run.mjs -m ollama/qwen2.5-coder:7b -r 3
    node src/see/run.mjs -m openrouter/some-model --only-provider AtlasCloud --no-fallback
`;

/** Score one task: prompt the model, compile what came back, run the cases. */
export const runTask = async (config, task) => {
  const promptText = buildPrompt(task);
  const startedAt = Date.now();

  // A call that never returns must not abort the run. SEE already scores an
  // unusable RESPONSE as zero, so a call that fails outright is the same kind
  // of event: the model failed this task, and the other two tasks are
  // unaffected. Recorded as `callFailure` so a report reader can tell "answered
  // wrongly" from "never answered".
  let completion = null;
  let callFailure = null;
  try {
    completion = await complete(config, promptText);
  } catch (err) {
    // The shared taxonomy, not a local collapse: the first version here turned
    // every 401, 429, 500 and connection refusal into "provider_error", so a
    // SEE report could not tell quota exhaustion from a broken endpoint.
    callFailure = describeCallFailure(err, { startedAt, timeoutMs: config?.timeoutMs ?? null });
    return {
      taskId: task.id,
      name: task.name,
      prompt: promptText,
      digest: promptDigest(task),
      response: "",
      providerModel: null,
      finishReason: null,
      callFailure,
      callElapsedMs: Date.now() - startedAt,
      compileError: "the model returned no response",
      fn: null,
      result: null,
    };
  }

  // isolateCalls: one compiled candidate answers every held-out and seen case,
  // so no state may cross between cases. See sandbox.mjs for why this flag is
  // SEE's and not DO's.
  const compiled = compileCandidate(completion.text, { entry: "f", isolateCalls: true });

  if (!compiled.ok) {
    // An unusable response scores zero rather than aborting the run: a model
    // that returns prose instead of code has failed the task, not the harness.
    return {
      taskId: task.id,
      name: task.name,
      prompt: promptText,
      digest: promptDigest(task),
      response: completion.text,
      providerModel: completion.providerModel ?? null,
      finishReason: completion.finishReason ?? null,
      compileError: compiled.error,
      fn: null,
      result: null,
    };
  }

  // Bridge the sandbox to the scorer: each call is timed and isolated, and a
  // throw is surfaced as a failed case rather than a harness crash.
  const fn = (input) => {
    const r = runCandidate(compiled, input);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  return {
    taskId: task.id,
    name: task.name,
    prompt: promptText,
    digest: promptDigest(task),
    response: completion.text,
    providerModel: completion.providerModel ?? null,
    finishReason: completion.finishReason ?? null,
    compileError: null,
    fn,
    result: scoreTask(task, fn),
  };
};

/** Run all three tasks and assemble the Generalization Index. */
export const runSee = async (config, { onProgress } = {}) => {
  const taskRuns = [];
  for (const [i, task] of tasks.entries()) {
    onProgress?.(`asking the model for task ${task.id} (${i + 1} of ${tasks.length})...`);
    taskRuns.push(await runTask(config, task));
  }

  const fnByTask = Object.fromEntries(taskRuns.filter((t) => t.fn).map((t) => [t.taskId, t.fn]));
  // EVERY task is scored, including one whose response was unusable: it counts
  // as 50 failed, thrown cases. Leaving it out made the held-out arm cover 100
  // cases while the seen arm covered 24, which is how a model that answered one
  // task in prose earned a negative Generalization Index and a full robustness bonus.
  const results = taskRuns.map((t) => t.result ?? unusableResult(taskById[t.taskId], t.compileError));
  const seen = scoreSeen(fnByTask);
  const index = generalizationIndex(seen, results);
  const robustness = robustnessBonus(results);

  return {
    taskRuns,
    seen,
    index,
    reading: readIndex(index.index * 100),
    points: results.reduce((sum, r) => sum + r.rate * 15, 0),
    // Proportional: see the long note in score.mjs for why this is not a cliff.
    noCrash: robustness.points,
    robustness,
  };
};

/**
 * Adapt a legacy level-8 `runSee` result into the perLevel/perTask shape
 * that buildSeeLevelsReport expects. Used by the SEE entry point when
 * `npm run see` is invoked: it still does one call per task (level 8),
 * and the report carries the level-8 numbers under the L2/L8 slot.
 */
const adaptLegacyRun = (run) => {
  const perTask = {};
  for (const t of run.taskRuns) {
    perTask[t.taskId] = {
      taskId: t.taskId,
      name: t.taskId,
      weightedRate: t.result ? t.result.rate : 0,
      gzMean: 0,
      levels: {
        8: t.result
          ? {
              seen: t.result.seen ?? { correct: 0, total: 0 },
              heldOut: { correct: t.result.correct, total: t.result.total, rate: t.result.rate },
            }
          : null,
      },
    };
  }
  // Pool perLevel across all tasks at level 8.
  let correct = 0;
  let total = 0;
  let heldCorrect = 0;
  for (const t of run.taskRuns) {
    if (!t.result) continue;
    if (t.result.seen) { correct += t.result.seen.correct; total += t.result.seen.total; }
    heldCorrect += t.result.correct;
  }
  const heldOut = {
    correct: heldCorrect,
    total,
    rate: total > 0 ? heldCorrect / total : 0,
  };
  return {
    taskRuns: run.taskRuns,
    perTask,
    perLevel: {
      8: {
        seen: { correct, total, rate: total > 0 ? correct / total : 0 },
        heldOut,
        gz: total > 0 ? (correct / total) - (heldOut.rate ?? 0) : 0,
      },
    },
    robustness: run.robustness,
  };
};

const bar = (rate, width = 20) => {
  const filled = Math.round(rate * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
};

const pct = (r) => `${Math.round(r * 100)}%`;

export const printSeeRun = (model, out, runIndex = 0, total = 1) => {
  const label = total > 1 ? ` (run ${runIndex + 1}/${total})` : "";
  console.log(`\nMONKEY SEE · ${model}${label}`);
  for (const t of out.taskRuns) {
    if (!t.result) {
      console.log(`  Task ${t.taskId}    unusable response — ${t.compileError}`);
      continue;
    }
    const r = t.result;
    console.log(
      `  Task ${t.taskId}    held-out ${String(r.correct).padStart(2)}/50  ${pct(r.rate).padStart(4)}  ${bar(r.rate)}` +
        // Showing the throw count per task keeps a robustness deduction
        // explainable: you can see exactly which task cost the points.
        (r.threw ? `  (threw on ${r.threw})` : "")
    );
  }
  // Proportional, so it needs the count to be interpretable. "+5" alone would
  // hide both the size of a deduction and why it happened.
  const rb = out.robustness;
  const bonusLine =
    rb.threw === 0
      ? `robustness  +5.0   (no throws in ${rb.total})`
      : `robustness  +${rb.points.toFixed(2).padStart(4)}   (threw on ${rb.threw}/${rb.total} — ` +
        `${((rb.points - 5) * -1).toFixed(2)} vs a clean run)`;
  console.log(`\n  ${bonusLine}`);
  console.log(`\n  SEEN ${pct(out.seen.rate)}   HELD-OUT ${pct(out.index.heldOut)}`);
  console.log(`  MONKEY INDEX  ${Math.round(out.index.index * 100)}   (${out.reading})`);
  console.log(`\n  ${Math.round(out.points + out.noCrash)}/50`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  // Print something immediately. A silent start looks like a hang, and the
  // first thing anyone does when something looks hung is press Ctrl+C.
  console.log(`\nMONKEY SEE · ${args.model}`);
  await selfTestGate();
  const { config, keySource } = await prepareModel(args);
  console.log("  contacting the model (3 calls, usually a few seconds)...");

  const startedAt = new Date().toISOString();
  const runs = [];
  for (let i = 0; i < args.runs; i++) {
    const out = await runSee(config, {
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    printSeeRun(args.model, out, i, args.runs);
    runs.push(out);
  }

  let rep = null;
  if (runs.length > 1) {
    // Failed runs are marked and excluded: their empty responses all share one
    // constant fingerprint, so counting them certified two timeouts as
    // "same answer every run". A task with fewer than two ANSWERED runs gets no
    // verdict at all.
    rep = reproducibility(
      runs.flatMap((r) =>
        r.taskRuns.map((t) => ({ taskId: t.taskId, response: t.response, failed: Boolean(t.callFailure) }))
      )
    );
    const indices = runs.map((r) => Math.round(r.index.index * 100));
    const spread = Math.max(...indices) - Math.min(...indices);

    console.log("\n  REPRODUCIBILITY");
    for (const [taskId, info] of Object.entries(rep.perTask)) {
      const verdict =
        info.runs < 2
          ? `no answered pair to compare (${info.failedRuns} failed)`
          : info.distinct === 1
            ? `same answer every answered run`
            : `${info.distinct} DIFFERENT answers`;
      console.log(`    task ${taskId}: ${verdict}  [${info.prints.join(" ")}]`);
    }
    console.log(`\n  Generalization Index across runs: ${indices.join(", ")}  (spread ${spread})`);

    if (rep.verdict === null) {
      console.log(
        `\n  NO VERDICT. Too few answered runs to compare: every task failed in\n` +
          `  all but one run. Nothing here says the endpoint is deterministic or\n` +
          `  otherwise — the calls never came back. Fix the route, then re-run.`
      );
    } else if (!rep.reproducible) {
      console.log(
        `\n  NOT REPRODUCIBLE. The endpoint returned different code for the same\n` +
          `  prompt, so the model is guessing afresh each time. That is a property of\n` +
          `  the MODEL or its HOSTING, not of this harness.\n` +
          `\n  Read the score above as one sample from a range, not a measurement.\n` +
          `  Do not compare it to another model, or to a future run of this one.\n` +
          `\n  For repeatable numbers, use a deterministic endpoint:\n` +
          `    - a model running on your own machine (Ollama), or\n` +
          `    - a paid hosted model pinned to a fixed provider.`
      );
    } else if (spread > 2) {
      console.log(
        `\n  Responses were identical but scores moved by ${spread}.\n` +
          `  That would be a bug in the scoring path — please report it.`
      );
    } else {
      console.log(
        `\n  REPRODUCIBLE. Same code every answered run, scores stable within ${spread}.\n` +
          `  This score is comparable to other models scored the same way.`
      );
    }
  }

  console.log("\n  Prompt digests (SHA-256):");
  for (const d of allPromptDigests()) console.log(`    ${d.taskId}  ${d.digest}`);
  temperatureNotice(config);

  // Persist every run, reproducible or not. A NOT_REPRODUCIBLE result is
  // especially worth keeping: it is the evidence for that verdict.
  const last = runs[runs.length - 1];
  // The legacy single-shot runSee returns the level-8 shape (taskRuns, points,
  // noCrash, robustness, index). buildSeeLevelsReport wants perLevel/perTask
  // — adapt it on the fly so this entry point still emits the new schema.
  const adapted = adaptLegacyRun(last);
  const report = buildSeeLevelsReport({
    model: args.model,
    last: adapted,
    runs: adapted.taskRuns,
    reproducibility: rep,
    config,
    keySource,
  });
  const path = writeSeeLevelsReport(report, args.out);
  printLimitations(LIMITATIONS);
  console.log(`\n  Saved results to ${path}`);

  console.log("");
};

// True when this module is the process's entry script. pathToFileURL, not a
// template: a repo path containing a space (or any character that needs
// percent-encoding) makes `file://${argv[1]}` a different string from
// import.meta.url, the guard read false, and the script printed nothing and
// exited 0. realpath, because argv[1] may be a symlinked path (macOS /var ->
// /private/var) while import.meta.url always carries the real one.
// The imports live at the top of the file with the others.
const isMain = (() => {
  try {
    return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`\n  Something went wrong: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

