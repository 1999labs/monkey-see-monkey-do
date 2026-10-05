// MONKEY SEE / MONKEY DO: run both evals against one model.
//
//   node src/run-all.mjs --model openrouter/dots-3-note-preview:free
//
// Suite 1.0.0: this runner executes the DO chain eval.
//
// WHY THIS EXISTS RATHER THAN TWO SEPARATE RUNS.
//
// The two evals share a model, a key and a reproducibility verdict, and they are
// only interesting TOGETHER: SEE scores rule induction from examples, DO scores
// the soundness of a chain-rewrite derivation. Run separately, the two JSON files
// could legitimately disagree (different provider fallback, a different run
// count, one sampled at temperature 0 and one not), and there would be no way
// to tell a model difference from a setup difference.
//
// So this resolves the model and the key ONCE, runs both evals against that
// same config, and writes both reports plus a combined one.
//
// SEE runs 12 calls (3 tasks × 4 sample levels). DO runs 1 call. Total:
// 13 model calls per run.

import { runAllLevels, printLevelsRun } from "./see/run-levels.mjs";
import { runChainDo, REFERENCE_SOLVER_SOURCE } from "./do/chain/run.mjs";
import { chainEngagementRate } from "./do/chain/score.mjs";
import { reproducibility, printVerdict, fingerprint } from "./fingerprint.mjs";
import { loadPublishedPool } from "./do/chain/pool.mjs";
import { adjustedTotal } from "./adjusted.mjs";
import { describeCallFailure } from "./call-failure.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import {
  buildSeeLevelsReport,
  writeSeeLevelsReport,
  buildChainDoReport,
  writeChainDoReport,
  buildCombinedReport,
  writeCombinedReport,
  LIMITATIONS,
} from "./report.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice, printLimitations } from "./cli.mjs";

const HELP = `
MONKEY SEE and MONKEY DO (suite 1.0.0 — DO chain eval)

  node src/run-all.mjs --model <provider/model>

  Runs BOTH evals against one resolved model and key, then writes three
  reports: SEE (per-level), DO (chain), and a combined one. Cost is
  12 model calls for SEE (3 tasks x 4 sample levels) plus 1 for DO, per run.

  --model, -m    the model to score (openrouter/..., openai/..., ollama/...,
                 or any id defined in config/models.json)
  --key,   -k    API key. Usually unnecessary: the tool looks in the provider's
                 environment variable, ~/.config/monkeydo, then .env.
  --runs,  -r    repeat both evals N times (default 1). Use 3 for the stability
                 check the acceptance gate requires: totals must agree within
                 2 points.
  --per-band N   DO: score only the first N chains per band (a quick,
                 non-comparable subset run)
  --out DIR      where to write results (default results/)
  --config FILE  model registry
  --i-cannot-control-temperature
                 required for a model configured supportsTemperatureZero: false
  --seed, -s          fixed RNG seed sent with every request
  --only-provider     pin to one OpenRouter provider
  --no-fallback       refuse to switch provider if the pinned one is down
  --order-provider    a,b,c   try providers in this order

  Examples
    node src/run-all.mjs -m openrouter/dots-3-note-preview:free
    node src/run-all.mjs -m ollama/qwen2.5-coder:7b -r 3
`;

/**
 * Combined SEE + DO summary.
 *
 * Computes the per-task weighted scores (Phase 4) and the chain
 * engagement rate (Phase 5). The text returned is a flat summary, not
 * a README — it's printed to the terminal after every run.
 */
export const summarise = (seeOut, doOut) => {
  // Per-task weighted rate as a percentage.
  const perTaskRate = (id) => seeOut.perTask[id].weightedRate;
  const total = perTaskRate("A") * 15 + perTaskRate("B") * 15 + perTaskRate("C") * 15;

  const lines = [];
  lines.push(`  MONKEY SEE         ${total.toFixed(2)}/45   weighted: A=${(perTaskRate("A") * 100).toFixed(1)}%  B=${(perTaskRate("B") * 100).toFixed(1)}%  C=${(perTaskRate("C") * 100).toFixed(1)}%`);
  lines.push(`    GZ (per level): ${Object.entries(seeOut.perLevel).map(([l, e]) => `L${l}=${(e.gz * 100).toFixed(1)}%`).join("  ")}  GZ_mean=${((Object.values(seeOut.perLevel).reduce((s, e) => s + e.gz, 0) / Object.keys(seeOut.perLevel).length) * 100).toFixed(2)}%`);
  lines.push(`  MONKEY DO (v2)    ${doOut.score.total}/50   ${doOut.score.perChain.filter((c) => c.fullCredit).length}/${poolChainsCount(doOut)} chains full credit, ${doOut.score.perChain.filter((c) => c.partial).length} partial`);
  lines.push(`  SEE ${total.toFixed(0)}/45 + DO ${doOut.score.total}/50 = combined ${total + doOut.score.total}/95`);
  return lines.join("\n");
};

const poolChainsCount = (doOut) => doOut.score.perChain.length;

const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

/**
 * Run SEE levels + DO once. Exported so the acceptance gate scores
 * models through exactly the same path as a normal run.
 *
 * @returns {{ runs: Array<{seeOut, doOut, seeTotal, doTotal}>, stability }}
 */
export const runAll = async (config, { runs = 1, pool, onProgress = () => {} } = {}) => {
  const out = [];
  for (let i = 0; i < runs; i++) {
    onProgress(`run ${i + 1}/${runs}: SEE levels (12 calls)...`);
    const seeOut = await runAllLevels(config, {});
    onProgress(`run ${i + 1}/${runs}: DO (1 call, ${pool.chains.length} chains)...`);
    // The DO call can fail (network, timeout, refusal). Record it as a
    // route failure with doTotal: 0, keeping reproducibility stats
    // honest. Two answered runs must still get a verdict.
    let doOut;
    try {
      doOut = await runChainDo(config, { chains: pool.chains, seed: pool.seed });
    } catch (err) {
      const callFailure = describeCallFailure(err, { timeoutMs: config?.timeoutMs ?? null });
      doOut = {
        score: { total: 0, max: 50, perBand: {}, perChain: [] },
        usable: false,
        compileError: null,
        callFailure,
        callElapsedMs: 0,
        callTimeoutMs: config?.timeoutMs ?? null,
        response: "",
        providerModel: null,
        finishReason: null,
        responseFingerprint: fingerprint(""),
        digest: null,
        canary: false,
        dryRun: false,
      };
    }
    // SEE total = sum of weighted rates × 15; DO total = chain score total.
    const seeTotal = Object.values(seeOut.perTask).reduce((s, t) => s + t.weightedRate * 15, 0) + seeOut.robustness.points;
    out.push({ seeOut, doOut, seeTotal: Math.round(seeTotal), doTotal: doOut.score.total });
  }

  let stability = null;
  if (runs > 1) {
    const seeTotals = out.map((r) => r.seeTotal);
    const doTotals = out.map((r) => r.doTotal);
    const combinedTotals = out.map((r) => r.seeTotal + r.doTotal);
    // Per-run route failures, so a spread can be explained from this file alone.
    const seePrints = out.flatMap((r) =>
      (r.seeOut.runs ?? [])
        .filter((run) => run.out?.usable)
        .map((run) => ({ taskId: run.out.taskId, response: run.out.response, failed: Boolean(run.out.callFailure) }))
    );
    const doPrints = out.filter((r) => r.doOut.usable).map((r) => r.doOut.responseFingerprint);
    const seeRep = reproducibility(seePrints);
    // A run whose DO call failed at the route contributes NO determinism
    // evidence: its 0/50 is the score of a call that never returned, not a
    // model result. Such a run must not widen the DO or combined spread, or a
    // dead call reads as model variance. The exclusion set is the same one
    // doPrints uses (answered runs), so the spread and the verdict can never
    // disagree about which runs count.
    const doAnswered = out.filter((r) => !r.doOut.callFailure);
    const doTotalsAnswered = doAnswered.map((r) => r.doTotal);
    const combinedAnswered = doAnswered.map((r) => r.seeTotal + r.doTotal);
    stability = {
      runs,
      seeTotals,
      doTotals,
      combinedTotals,
      seeSpread: spread(seeTotals),
      // Spreads over ANSWERED runs only; the full per-run totals above stay in
      // the record so a reader can still see the failed run and its zero.
      doSpread: spread(doTotalsAnswered),
      combinedSpread: spread(combinedAnswered),
      answeredDoRuns: doTotalsAnswered.length,
      withinTwoPoints: spread(seeTotals) <= 2 && spread(doTotalsAnswered) <= 2,
      seeReproducible: seeRep.reproducible,
      seeVerdict: seeRep.verdict ?? "NO_VERDICT",
      seePrints,
      doReproducible: doPrints.length >= 2 && new Set(doPrints).size === 1,
      doVerdict: printVerdict(doPrints) ?? "NO_VERDICT",
      doPrints,
      // Per-run route failures, so a spread can be explained from this file alone.
      doCallFailures: out.map((r) => Boolean(r.doOut.callFailure)),
    };
  }
  return { runs: out, stability };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.model) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  console.log(`\nMONKEY SEE / MONKEY DO (v2) · ${args.model}`);
  await selfTestGate();
  const { config, keySource } = await prepareModel(args);

  const pool = loadPublishedPool({ perBand: args.perTier });
  console.log(
    `  DO chain pool: ${pool.chains.length} chains${pool.full ? "" : ` (first ${args.perTier} per band; a SUBSET, not comparable with a full run)`}`
  );

  const { runs, stability } = await runAll(config, {
    runs: args.runs,
    pool,
    onProgress: (m) => console.log(`  ${m}`),
  });

  const last = runs[runs.length - 1];
  for (const [i, r] of runs.entries()) {
    console.log(`\n\n=== MONKEY SEE (levels) ===`);
    printLevelsRun(args.model + (runs.length > 1 ? ` (run ${i + 1}/${runs.length})` : ""), r.seeOut);
    console.log(`\n\n=== MONKEY DO (v2) ===`);
    console.log(`  ${r.doOut.score.total}/50 across ${pool.chains.length} chains (fullCredit=${r.doOut.score.perChain.filter((c) => c.fullCredit).length}, partial=${r.doOut.score.perChain.filter((c) => c.partial).length})`);
  }

  console.log(`\n\n=== COMBINED ===`);
  const reading = summarise(last.seeOut, last.doOut);
  console.log(reading);

  {
    // SEE gzMean = unweighted mean of per-level GZ (each is seen - heldOut).
    const perLevel = last.seeOut.perLevel;
    const gzMean = Object.values(perLevel).reduce((s, e) => s + (e.gz ?? 0) * 100, 0) / Math.max(1, Object.keys(perLevel).length);
    const engagement = chainEngagementRate(last.doOut.score.perChain);
    const adj = adjustedTotal({
      seeTotal: Math.round(last.seeTotal),
      doTotal: last.doTotal,
      gzMean,
      chainEngagementRate: engagement,
    });
    console.log(`\n  ADJUSTED (see + do, less GZ_mean and unearned clawback)`);
    console.log(`    ${adj.base}  -  ${adj.gzMeanPenalty} (gz_mean)  -  ${adj.unearnedPenalty} (unearned)  =  \x1b[1m${adj.total}/100\x1b[0m`);
  }

  if (stability) {
    console.log(`\n  STABILITY over ${stability.runs} runs`);
    console.log(`    SEE totals ${stability.seeTotals.join(", ")}  (spread ${stability.seeSpread})`);
    // The spread is over ANSWERED runs; a failed route's 0 is not model
    // variance. Say so inline when a run was excluded, so the printed spread
    // and the printed totals cannot look contradictory.
    const doNote = stability.answeredDoRuns < stability.runs
      ? `  (spread ${stability.doSpread} over ${stability.answeredDoRuns} answered; ${stability.runs - stability.answeredDoRuns} route-failed and excluded)`
      : `  (spread ${stability.doSpread})`;
    console.log(`    DO  totals ${stability.doTotals.join(", ")}${doNote}`);
    console.log(
      stability.withinTwoPoints
        ? `    within 2 points, stable enough to compare`
        : `    MORE THAN 2 POINTS apart: these are samples, not a measurement`
    );
    const seeWord = { REPRODUCIBLE: "identical", NOT_REPRODUCIBLE: "DIFFERED" }[stability.seeVerdict] ?? "no answered pair";
    const doWord = { REPRODUCIBLE: "identical", NOT_REPRODUCIBLE: "DIFFERED" }[stability.doVerdict] ?? "no answered pair";
    console.log(`    responses: SEE ${seeWord}, DO ${doWord} across runs`);
  }
  temperatureNotice(config);

  const seePath = writeSeeLevelsReport(
    buildSeeLevelsReport({
      model: args.model,
      last: last.seeOut,
      reproducibility: stability ? { seePrints: stability.seePrints, seeReproducible: stability.seeReproducibility, seeVerdict: stability.seeVerdict } : null,
      config,
      keySource,
      runs: last.seeOut.runs ?? [],
    }),
    args.out
  );
  const doPath = writeChainDoReport(
    buildChainDoReport({
      model: args.model,
      result: last.doOut,
      config,
      keySource,
      pool,
      reproducibility: stability
        ? {
            prints: stability.doPrints,
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
      see: last.seeOut,
      doo: last.doOut,
      pool,
      reading: reading.split("\n").map((l) => l.trim()).filter(Boolean),
      stability,
      paths: { see: seePath, do: doPath },
    }),
    args.out
  );
  printLimitations(LIMITATIONS);
  console.log(`\n  SEE report:      ${seePath}`);
  console.log(`  DO  report:      ${doPath}`);
  console.log(`  combined report: ${combinedPath}\n`);
};

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