// MONKEY SEE / MONKEY DO: run both evals against one model.
//
//   node src/run-all.mjs --model openrouter/dots-3-note-preview:free
//
// WHY THIS EXISTS RATHER THAN TWO SEPARATE RUNS.
//
// The two evals share a model, a key and a reproducibility verdict, and they are
// only interesting TOGETHER: SEE scores rule induction from examples, DO scores
// the soundness of a solver's moves. Run separately, the two JSON files
// could legitimately disagree (different provider fallback, a different run
// count, one sampled at temperature 0 and one not), and there would be no way
// to tell a model difference from a setup difference.
//
// So this resolves the model and the key ONCE, runs both evals against that
// same config, and writes both reports plus a combined one.

import { runSee, printSeeRun } from "./see/run.mjs";
import { reproducibility, printVerdict } from "./fingerprint.mjs";
import { runDo, loadPool, printDoRun } from "./do/run.mjs";
import { randomBaseline, CONFIDENT_ERRORS } from "./do/score.mjs";
import { adjustedTotal } from "./adjusted.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import {
  buildReport,
  writeReport,
  buildDoReport,
  writeDoReport,
  buildCombinedReport,
  writeCombinedReport,
  LIMITATIONS,
} from "./report.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice, printLimitations } from "./cli.mjs";

const HELP = `
MONKEY SEE and MONKEY DO

  node src/run-all.mjs --model <provider/model>

  Runs BOTH evals against one resolved model and key, then writes three
  reports: SEE, DO, and a combined one. Cost is 3 model calls for SEE (one per
  task) plus 1 for DO, per run.

  --model, -m    the model to score (openrouter/..., openai/..., ollama/...,
                 or any id defined in config/models.json)
  --key,   -k    API key. Usually unnecessary: the tool looks in the provider's
                 environment variable, ~/.config/monkeydo, then .env.
  --runs,  -r    repeat both evals N times (default 1). Use 3 for the
                 stability check the acceptance gate requires: totals must agree
                 within 2 points.
  --per-tier N   DO: score only the first N boards per tier per pool (a quick,
                 non-comparable subset run)
  --out DIR      where to write results (default results/)
  --config FILE  model registry (default config/models.json)
  --i-cannot-control-temperature
                 required for a model configured supportsTemperatureZero: false
  --seed, -s          fixed RNG seed sent with every request
  --only-provider     pin to one OpenRouter provider
  --no-fallback       refuse to switch provider if the pinned one is down
  --order-provider    a,b,c   try providers in this order

  Examples
    node src/run-all.mjs -m openrouter/dots-3-note-preview:free
    node src/run-all.mjs -m ollama/qwen2.5-coder:7b -r 3
    node src/run-all.mjs -m openrouter/some-model -r 3 -s 42 --only-provider X --no-fallback
`;

const pct = (r) => `${Math.round(r * 100)}%`;

/**
 * The combined reading.
 *
 * The one comparison the suite exists to make, and deliberately blunt. Both
 * numbers are facts about what the model emitted: SEE's Generalization Index is the gap
 * between its score on the examples it was shown and on inputs it was not; DO's
 * confident-error rate is how often the solver it wrote moved without proof.
 *
 * High on both means the model scored well on what it was shown and then its
 * solver acted beyond what the position supported. That is a real pattern in
 * the artefacts and worth flagging. It is not evidence about how the model
 * reached either result; see the limitations, which every report carries.
 */
export const summarise = (see, doo) => {
  const index = Math.round(see.index.index * 100);
  const seeTotal = Math.round(see.points + see.noCrash);
  const total = Math.max(1, doo.boardResults.length);

  // A route failure is not a disagreement between the evals. The first version
  // fell through to the interpretive branches below and read a timeout as
  // "the two evals disagree", which is not what happened and hides the one
  // thing a reader of a zero must know.
  if (doo.callFailure) {
    const lines = [];
    lines.push(`  MONKEY SEE   ${seeTotal}/50`);
    lines.push(
      `  MONKEY DO    0/50   NO RESPONSE (${doo.callFailure.reason}). Every board is no_response:`
    );
    lines.push(`  the model call never returned, so this zero describes the route,`);
    lines.push(`  not the reasoning. SEE ran independently and is unaffected.`);
    lines.push(`  SEE ${seeTotal}/50  ·  DO 0/50  ·  combined ${seeTotal}/100`);
    return lines.join("\n");
  }

  const det = doo.boardResults.filter((r) => r.outcome === "detonation").length / total;
  const guess = doo.boardResults.filter((r) => r.outcome === "unproven_move").length / total;
  const unproven = doo.boardResults.filter((r) => CONFIDENT_ERRORS.has(r.outcome) && r.outcome !== "protocol_violation").length / total;
  const lines = [];
  lines.push(`  MONKEY SEE   ${seeTotal}/50   index ${index}  (${see.reading})`);
  lines.push(`  MONKEY DO    ${doo.score.total}/50   detonated ${pct(det)} of boards, guessed on ${pct(guess)}`);
  lines.push(`  SEE ${seeTotal}/50  ·  DO ${doo.score.total}/50  ·  combined ${seeTotal + doo.score.total}/100`);
  lines.push("");
  if (index >= 30 && unproven >= 0.1) {
    lines.push("  High Generalization Index with confident errors on DO: it scored well on the");
    lines.push("  examples it was shown, and the solver it wrote then moved without");
    lines.push("  proof. Both are properties of the output; neither names a cause.");
  } else if (index <= 10 && unproven === 0) {
    lines.push("  Generalizes on SEE, and the solver it wrote never moved without proof");
    lines.push("  on DO. Both results are also consistent with recall of a known approach");
    lines.push("  rather than derivation; check the run was reproducible first.");
  } else {
    lines.push("  Mixed: the two evals disagree. Worth reading the per-tier DO");
    lines.push("  breakdown, since a model that only handles small boards has learned");
    lines.push("  to look at small boards.");
  }
  return lines.join("\n");
};

const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

/**
 * Run both evals `runs` times against one resolved config.
 *
 * Exported so the acceptance gate (bin/acceptance.mjs) scores models through
 * exactly the same path as a normal run.
 *
 * @returns {{ runs: Array<{see, doo, seeTotal, doTotal}>, baseline, stability }}
 */
export const runAll = async (config, { runs = 1, pool, onProgress = () => {} } = {}) => {
  const baseline = randomBaseline({ boards: pool.boards, seed: pool.seed });
  const out = [];
  for (let i = 0; i < runs; i++) {
    onProgress(`run ${i + 1}/${runs}: SEE (3 calls)...`);
    const see = await runSee(config, { onProgress });
    onProgress(`run ${i + 1}/${runs}: DO (1 call, ${pool.boards.length} boards)...`);
    const doo = await runDo(config, { boards: pool.boards, seed: pool.seed, baseline });
    out.push({ see, doo, seeTotal: Math.round(see.points + see.noCrash), doTotal: doo.score.total });
  }

  let stability = null;
  if (runs > 1) {
    const seeTotals = out.map((r) => r.seeTotal);
    const doTotals = out.map((r) => r.doTotal);
    const combinedTotals = out.map((r) => r.seeTotal + r.doTotal);
    // Only ANSWERED runs are evidence of determinism. A run whose call failed
    // records an empty response, whose fingerprint is the same constant for
    // every failure mode: counting it certified two timeouts as "identical
    // code every run" and claimed temperature 0 was honoured by a model that
    // never answered. `failed: true` marks those entries for exclusion.
    const seeRep = reproducibility(
      out.flatMap((r) =>
        r.see.taskRuns.map((t) => ({ taskId: t.taskId, response: t.response, failed: Boolean(t.callFailure) }))
      )
    );
    // DO prints from answered runs only: a mixed failure/success set is a
    // verdict over the successes, not a false NOT_REPRODUCIBLE over the empty
    // constant. Fewer than two answered runs is NO_VERDICT, not REPRODUCIBLE.
    const doPrints = out.filter((r) => !r.doo.callFailure).map((r) => r.doo.responseFingerprint);
    stability = {
      runs,
      seeTotals,
      doTotals,
      combinedTotals,
      seeSpread: spread(seeTotals),
      doSpread: spread(doTotals),
      // The gate: three runs at temperature 0 must differ by <= 2 points.
      withinTwoPoints: spread(seeTotals) <= 2 && spread(doTotals) <= 2,
      seeReproducible: seeRep.reproducible,
      seeVerdict: seeRep.verdict ?? "NO_VERDICT",
      seeReproducibility: seeRep,
      doReproducible: doPrints.length >= 2 && new Set(doPrints).size === 1,
      doVerdict: printVerdict(doPrints) ?? "NO_VERDICT",
      doPrints,
      // Per-run route failures, so a spread can be explained from this file alone.
      doCallFailures: out.map((r) => Boolean(r.doo.callFailure)),
      seeCallFailures: out.map((r) => r.see.taskRuns.filter((t) => t.callFailure).map((t) => t.taskId)),
    };
  }
  return { runs: out, baseline, stability };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  console.log(`\nMONKEY SEE / MONKEY DO · ${args.model}`);
  await selfTestGate();
  // Resolve the model and the key ONCE. Both evals then use the identical
  // config, which is the entire point of this script.
  const { config, keySource } = await prepareModel(args);

  const pool = loadPool({ perTier: args.perTier });
  console.log(
    `  DO board pool: ${pool.boards.length} boards${pool.full ? "" : " (a SUBSET, not comparable with a full run)"}`
  );

  const { runs, baseline, stability } = await runAll(config, {
    runs: args.runs,
    pool,
    onProgress: (m) => console.log(`  ${m}`),
  });

  for (const [i, r] of runs.entries()) {
    console.log(`\n\n=== MONKEY SEE ===`);
    printSeeRun(args.model, r.see, i, runs.length);
    console.log(`\n\n=== MONKEY DO ===`);
    printDoRun(args.model + (runs.length > 1 ? ` (run ${i + 1}/${runs.length})` : ""), r.doo);
  }

  const last = runs[runs.length - 1];
  console.log(`\n\n=== COMBINED ===`);
  const reading = summarise(last.see, last.doo);
  console.log(reading);

  // The one number to plot. Reported, never scored — SEE + DO above is
  // unchanged. See src/adjusted.mjs.
  {
    const seeTotal = Math.round(last.see.points + last.see.noCrash);
    const adj = adjustedTotal({
      seeTotal,
      doTotal: last.doo.score.total,
      generalizationIndex: Math.round(last.see.index.index * 100),
      initiationRate: last.doo.progressIndex?.initiationRate ?? 1,
    });
    console.log(`\n  ADJUSTED (see + do, less Generalization Index and unearned points)`);
    console.log(`    ${adj.base}  -  ${adj.generalizationIndexPenalty} (index)  -  ${adj.unearnedPenalty} (unearned)  =  \x1b[1m${adj.total}/100\x1b[0m`);
  }

  if (stability) {
    console.log(`\n  STABILITY over ${stability.runs} runs`);
    console.log(`    SEE totals ${stability.seeTotals.join(", ")}  (spread ${stability.seeSpread})`);
    console.log(`    DO  totals ${stability.doTotals.join(", ")}  (spread ${stability.doSpread})`);
    console.log(
      stability.withinTwoPoints
        ? `    within 2 points, stable enough to compare`
        : `    MORE THAN 2 POINTS apart: these are samples, not a measurement`
    );
    // Verdict-aware wording: a task or eval with no answered pair is UNKNOWN,
    // not "DIFFERED" (it never claimed determinism to begin with).
    const seeWord = { REPRODUCIBLE: "identical", NOT_REPRODUCIBLE: "DIFFERED" }[stability.seeVerdict] ?? "no answered pair";
    const doWord = { REPRODUCIBLE: "identical", NOT_REPRODUCIBLE: "DIFFERED" }[stability.doVerdict] ?? "no answered pair";
    console.log(`    responses: SEE ${seeWord}, DO ${doWord} across runs`);
  }
  temperatureNotice(config);

  const seePath = writeReport(
    buildReport({
      model: args.model,
      taskRuns: last.see.taskRuns,
      last: last.see,
      indices: runs.map((r) => Math.round(r.see.index.index * 100)),
      reproducibility: stability?.seeReproducibility ?? null,
      config,
      keySource,
    }),
    args.out
  );
  const doPath = writeDoReport(
    buildDoReport({
      model: args.model,
      result: last.doo,
      config,
      keySource,
      pool,
      baseline,
      reproducibility: stability
        ? {
            // Answered runs only. buildDoReport derives the verdict and the
            // temperatureHonoured claim from these, and a failed run's constant
            // empty fingerprint would certify failures as identical code.
            prints: stability.doPrints,
            totals: stability.doTotals,
            failedRuns: stability.runs - stability.doPrints.length,
          }
        : null,
    }),
    args.out
  );
  const combinedPath = writeCombinedReport(
    buildCombinedReport({
      model: args.model,
      config,
      keySource,
      see: last.see,
      doo: last.doo,
      pool,
      reading: reading.split("\n").map((l) => l.trim()).filter(Boolean),
      stability: stability && { ...stability, seeReproducibility: undefined },
      paths: { see: seePath, do: doPath },
    }),
    args.out
  );
  printLimitations(LIMITATIONS);
  console.log(`\n  SEE report:      ${seePath}`);
  console.log(`  DO  report:      ${doPath}`);
  console.log(`  combined report: ${combinedPath}\n`);
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
