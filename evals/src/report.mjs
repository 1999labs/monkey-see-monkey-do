// Report output: every result is written to results/<model>-<date>.json.
//
// A benchmark score you cannot re-derive is an anecdote. The file records
// everything needed to reconstruct the number later:
//
//   - the model id exactly as passed, and the provider's own returned id
//     (they differ, and the difference matters)
//   - the prompt SHA-256 for each task, so we can prove which text was scored
//   - the reproducibility verdict, because an unstable score means something
//     different from a stable one and a reader must be able to tell
//   - per-task pass rates, per-bucket breakdown, and the seen/held-out arms
//   - the raw model response, so a surprising score can be explained without
//     re-running anything
//
// Deliberately NOT recorded: the API key, or any fragment of it.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { allPromptDigests } from "./see/prompt.mjs";
import { fingerprint } from "./see/fingerprint.mjs";
import { temperatureStatus } from "./adapters/registry.mjs";

/**
 * guide.md 10.3: "A report omitting the limitations is invalid, regardless of
 * the scores." So every report — SEE, DO and combined — carries all of them,
 * and the console prints them after every run.
 */
export const LIMITATIONS = [
  "Not a coding benchmark. Neither eval edits a repository, runs a test suite, or uses tools; they measure rule inference (SEE) and constraint deduction (DO), not software engineering.",
  "SEE saturates. Frontier models reach high SEE scores and it stops discriminating at the top of the market; it is most informative for open-weight and mid-tier models.",
  "Not comparable to SWE-bench, HumanEval, or any external leaderboard. Different scale, different construction; never present these numbers alongside one.",
  "DO has residual contamination risk. Constraint propagation with search is a textbook algorithm, so a high DO score shows the model can produce a correct solver, not that it deduced one afresh.",
  "Two narrow tasks. This is not a general intelligence measure, and the 50-point weights are hand-chosen (frozen at suite version 0.2.0).",
];

/** A filesystem-safe, readable filename for a model id. */
const slug = (model) =>
  model
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/**
 * Assemble the machine-readable report.
 *
 * @param {object} opts
 * @param {string} opts.model         model id exactly as passed on the CLI
 * @param {Array}  opts.taskRuns      taskRuns from the final run
 * @param {object} opts.last          the runSee() summary, used for headline numbers
 * @param {number[]} opts.indices     Monkey Index for each run
 * @param {object} opts.reproducibility output of reproducibility()
 * @param {object} opts.config        resolved adapter config (key is NOT copied)
 */
export const buildReport = ({ model, taskRuns, last, indices, reproducibility, config, keySource, startedAt }) => {
  return {
    schema: "monkey-see/report@1",
    eval: "SEE",
    timestamp: new Date().toISOString(),
    startedAt,
    durationMs: startedAt ? Date.now() - new Date(startedAt).getTime() : null,

    model: {
      requested: model,
      // The provider may report a different id than we asked for (a dated
      // snapshot, a different quantisation). Record both.
      resolvedByProvider: taskRuns.find((t) => t.providerModel)?.providerModel ?? null,
      endpoint: config?.endpoint ?? null,
    },

    generation: {
      temperature: 0,
      // What the model config says about temperature 0, including whether the
      // score was recorded under --i-cannot-control-temperature.
      temperatureControl: temperatureStatus(config),
      // Never assume this. It is only knowable after a reproducibility check,
      // and `null` must not be reported as `true`.
      temperatureHonoured: reproducibility?.reproducible ?? null,
      seed: config?.seed ?? null,
      providerPin: config?.provider ?? null,
      keySource: keySource ?? null,
    },

    prompts: allPromptDigests().map(({ taskId, digest }) => ({ taskId, sha256: digest })),

    score: {
      // Taken from runSee's own summary so the file and the terminal can never
      // disagree about what was scored.
      points: last ? Math.round(last.points) : 0,
      // Fractional. The 45 task points are whole numbers; the robustness bonus
      // is proportional to non-throwing cases, so it is rarely a round figure.
      robustness: last
        ? {
            points: Number(last.robustness.points.toFixed(4)),
            max: 5,
            threw: last.robustness.threw,
            total: last.robustness.total,
            rate: Number(last.robustness.rate.toFixed(4)),
            // The categorical flag, kept separate from the score on purpose:
            // "did it crash at all" and "how robust is it" are different
            // questions, and folding the first into the second is what made
            // one empty string worth 10% of the total.
            crashed: last.robustness.crashed,
          }
        : null,
      // Retained under the old name so existing readers do not silently break.
      noCrash: last ? Number(last.noCrash.toFixed(4)) : 0,
      total: last ? Math.round(last.points + last.noCrash) : 0,
      maxTotal: 50,
      monkeyIndex: last ? Math.round(last.index.index * 100) : null,
      indexReading: last ? last.reading : null,
      seen: last ? Number(last.seen.rate.toFixed(4)) : null,
      heldOut: last ? Number(last.index.heldOut.toFixed(4)) : null,
      perRunMonkeyIndex: indices ?? null,
    },

    reproducibility: reproducibility
      ? {
          verdict: reproducibility.reproducible ? "REPRODUCIBLE" : "NOT_REPRODUCIBLE",
          perTask: Object.fromEntries(
            Object.entries(reproducibility.perTask).map(([id, info]) => [
              id,
              { distinctResponses: info.distinct, runs: info.runs, fingerprints: info.prints },
            ])
          ),
        }
      : null,

    tasks: taskRuns.map((t) => ({
      taskId: t.taskId,
      name: t.name,
      promptSha256: t.digest,
      responseFingerprint: fingerprint(t.response ?? ""),
      usable: Boolean(t.result),
      compileError: t.compileError ?? null,
      heldOut: t.result
        ? {
            correct: t.result.correct,
            total: t.result.total,
            rate: Number(t.result.rate.toFixed(4)),
            threw: t.result.threw,
            perBucket: t.result.perBucket,
            // Sample failures, to make a surprising score explainable at a
            // glance. `expected` is deliberately DROPPED: keeping it would put
            // held-out answers into a file on disk, which is the one thing this
            // eval's split is designed to prevent. The input plus what the
            // model returned is enough to diagnose, and the expected value can
            // always be re-derived by calling the reference.
            sampleFailures: (t.result.failures ?? []).slice(0, 5).map((f) => ({
              input: f.input,
              got: f.got,
              threw: f.got === "<threw>",
            })),
          }
        : null,
      // The full response is included: a few hundred bytes each, and it is what
      // turns "38/50, index 15" from a claim into evidence.
      response: t.response ?? null,
    })),

    limitations: LIMITATIONS,

    notes: [
      "Expected values are derived at runtime from src/see/reference.mjs, not stored.",
      "An unusable response counts as 50 failed, thrown held-out cases for its task.",
      "No held-out case or reference implementation appears in this file.",
      "A NOT_REPRODUCIBLE verdict means the endpoint returned different code for the",
      "same prompt. Such a score is one sample from a range and must not be compared",
      "to another model or to a future run.",
    ],
  };
};

/** Write the report to results/<model>-<date>.json and return the path. */
export const writeReport = (report, outDir = "results") => {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.timestamp.slice(0, 10);
  const path = join(outDir, `${slug(report.model.requested)}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
};

/**
 * MONKEY DO's machine-readable report.
 *
 * Kept separate from buildReport because the two evals record different things.
 * SEE's headline is a gap between two pass rates; DO's is a per-board outcome
 * distribution, and the tier gradient is the interesting part.
 *
 * Per-board outcomes are recorded in full. "It lost" is not actionable, but
 * "it detonated on 14 of 20 large boards" is.
 *
 * The board LIST is included (pool, tier, attempt) so a score can be tied to the
 * exact boards that produced it. Layouts are regenerable from (seed, tier,
 * attempt), so storing them would be redundant bulk that could disagree with
 * the generator.
 *
 * @param {object} opts.pool  the loadPool() result: { boards, seed, full, sha256, publishedSha256 }
 */
export const buildDoReport = ({ model, result, config, keySource, pool, baseline, reproducibility }) => ({
  schema: "monkey-do/report@2",
  eval: "DO",
  timestamp: new Date().toISOString(),

  model: {
    requested: model,
    resolvedByProvider: result.providerModel ?? null,
    endpoint: config?.endpoint ?? null,
    // A dry run is not a model result and must never be filed as one.
    dryRun: result.dryRun === true,
  },

  generation: {
    temperature: 0,
    temperatureControl: temperatureStatus(config),
    // Not assumed: temperature 0 is a request, not a guarantee, and only a
    // reproducibility check can establish it.
    temperatureHonoured: reproducibility ? new Set(reproducibility.prints).size === 1 : null,
    seed: config?.seed ?? null,
    providerPin: config?.provider ?? null,
    keySource: keySource ?? null,
    // ONE call, reused across every board.
    modelCalls: 1,
  },

  pool: {
    sha256: pool.sha256,
    // A subset run (--per-tier) is not comparable with a full-pool run, and
    // says so here rather than leaving a reader to count boards.
    full: pool.full,
    publishedSha256: pool.publishedSha256 ?? pool.sha256,
    seed: pool.seed,
    boardCount: pool.boards.length,
    boards: pool.boards.map((b) => ({ pool: b.pool, tier: b.tier, attempt: b.attempt })),
    baseline,
  },

  prompt: { sha256: result.digest },

  score: {
    total: result.score.total,
    max: result.score.max,
    points: result.score.points,
    poolA: result.score.poolA,
    poolB: result.score.poolB,
    perTier: result.score.perTier,
    poolBPerTier: result.score.poolBPerTier,
    index: result.score.index,
    outcomes: result.score.outcomes,
    unverifiedMoves: result.score.unverifiedMoves,
  },

  reproduction: reproducibility
    ? {
        prints: reproducibility.prints,
        totals: reproducibility.totals ?? null,
        verdict: new Set(reproducibility.prints).size === 1 ? "REPRODUCIBLE" : "NOT_REPRODUCIBLE",
      }
    : null,

  solver: {
    usable: result.usable,
    compileError: result.compileError,
    responseFingerprint: result.responseFingerprint,
    // The full source. It is the evidence for every score below.
    response: result.response,
  },

  boardResults: result.boardResults,

  limitations: LIMITATIONS,

  notes: [
    "Boards come from the published pool (src/do/minesweeper/pool.json), verified on load against",
    "  seed 0x5EED. Any board can be rebuilt with replayBoard(tier, attempt).",
    "The model is called as solve(board, mines): the visible grid and the total mine count.",
    "Every move is checked for proof. unproven_move means the cell happened to be safe but could not",
    "  have been proven safe; it is scored like a detonation.",
    "Pool B passes on a CORRECT STOP (surrender where no cell is provable). premature_surrender",
    "  means a provable move existed.",
    "protocol_violation means the solver was unusable — a broken solver, not a reasoning failure.",
  ],
});

/** Write a DO report. Shares the naming scheme with SEE so results sort together. */
export const writeDoReport = (report, outDir = "results") => {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.timestamp.slice(0, 10);
  const path = join(outDir, `do-${slug(report.model.requested)}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
};

/**
 * The combined report written by run-all, in the order guide.md 10.3 requires:
 * model, date, temperature guarantee, SEE score and index, DO score and baseline
 * gap, limitations, combined total. The per-eval reports remain the primary
 * artefacts; this one points at them.
 *
 * @param {object} opts
 * @param {object} opts.see      the last runSee() summary
 * @param {object} opts.doo      the last runDo() result
 * @param {object} [opts.stability]  per-run totals when --runs > 1
 * @param {object} [opts.paths]  { see, do } report paths
 */
export const buildCombinedReport = ({ model, config, keySource, see, doo, pool, reading, stability = null, paths = {} }) => {
  const seeTotal = Math.round(see.points + see.noCrash);
  return {
    schema: "monkey-see-monkey-do/combined@1",
    model: { requested: model, endpoint: config?.endpoint ?? null },
    date: new Date().toISOString(),
    temperature: { ...temperatureStatus(config), keySource: keySource ?? null },
    see: {
      total: seeTotal,
      max: 50,
      monkeyIndex: Math.round(see.index.index * 100),
      reading: see.reading,
      seen: Number(see.seen.rate.toFixed(4)),
      heldOut: Number(see.index.heldOut.toFixed(4)),
    },
    do: {
      total: doo.score.total,
      max: 50,
      poolAWon: Number(doo.score.poolA.won.toFixed(4)),
      poolANoConfidentError: Number(doo.score.poolA.noDetonation.toFixed(4)),
      poolBCorrectStop: Number(doo.score.poolB.correctStop.toFixed(4)),
      baselineGap: doo.score.index,
      poolSha256: pool?.sha256 ?? null,
      fullPool: pool?.full ?? null,
    },
    limitations: LIMITATIONS,
    combined: {
      total: seeTotal + doo.score.total,
      max: 100,
      reading,
    },
    stability,
    reports: paths,
  };
};

/** Write the combined report next to the per-eval ones. */
export const writeCombinedReport = (report, outDir = "results") => {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.date.slice(0, 10);
  const path = join(outDir, `combined-${slug(report.model.requested)}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
};
