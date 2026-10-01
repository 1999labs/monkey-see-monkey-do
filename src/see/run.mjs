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
import { scoreTask, scoreSeen, monkeyIndex, readIndex, robustnessBonus, unusableResult } from "./score.mjs";
import { compileCandidate, runCandidate } from "../sandbox.mjs";
import { reproducibility } from "../fingerprint.mjs";
import { buildReport, writeReport, LIMITATIONS } from "../report.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice, printLimitations } from "../cli.mjs";

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
  const completion = await complete(config, promptText);
  const compiled = compileCandidate(completion.text, { entry: "f" });

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
    compileError: null,
    fn,
    result: scoreTask(task, fn),
  };
};

/** Run all three tasks and assemble the Monkey Index. */
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
  // task in prose earned a negative Monkey Index and a full robustness bonus.
  const results = taskRuns.map((t) => t.result ?? unusableResult(taskById[t.taskId], t.compileError));
  const seen = scoreSeen(fnByTask);
  const index = monkeyIndex(seen, results);
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
    rep = reproducibility(
      runs.flatMap((r) => r.taskRuns.map((t) => ({ taskId: t.taskId, response: t.response })))
    );
    const indices = runs.map((r) => Math.round(r.index.index * 100));
    const spread = Math.max(...indices) - Math.min(...indices);

    console.log("\n  REPRODUCIBILITY");
    for (const [taskId, info] of Object.entries(rep.perTask)) {
      const verdict = info.distinct === 1 ? "same answer every run" : `${info.distinct} DIFFERENT answers`;
      console.log(`    task ${taskId}: ${verdict}  [${info.prints.join(" ")}]`);
    }
    console.log(`\n  Monkey Index across runs: ${indices.join(", ")}  (spread ${spread})`);

    if (!rep.reproducible) {
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
        `\n  REPRODUCIBLE. Same code every run, scores stable within ${spread}.\n` +
          `  This score is comparable to other models scored the same way.`
      );
    }
  }

  console.log("\n  Prompt digests (SHA-256):");
  for (const d of allPromptDigests()) console.log(`    ${d.taskId}  ${d.digest}`);
  temperatureNotice(config);

  // Persist every run, reproducible or not. A NOT_REPRODUCIBLE result is
  // especially worth keeping: it is the evidence for that verdict.
  const report = buildReport({
    model: args.model,
    indices: runs.map((r) => Math.round(r.index.index * 100)),
    last: runs[runs.length - 1],
    taskRuns: runs[runs.length - 1].taskRuns,
    reproducibility: rep,
    config,
    keySource,
    startedAt,
  });
  const path = writeReport(report, args.out);
  printLimitations(LIMITATIONS);
  console.log(`\n  Saved results to ${path}`);

  console.log("");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\n  Something went wrong: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}

