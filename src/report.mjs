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

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { allPromptDigests } from "./see/prompt.mjs";
import { fingerprint, printVerdict } from "./fingerprint.mjs";
import { temperatureStatus } from "./adapters/registry.mjs";
import { adjustedTotal } from "./adjusted.mjs";

/**
 * A report omitting the limitations is invalid, regardless of the scores. So
 * every report — SEE, DO and combined — carries all of them, and the console
 * prints them after every run.
 *
 * These are the load-bearing ones. Two in particular constrain how far any
 * score can be read: DO scores a program rather than a chain of thought, and a
 * low Generalization Index is evidence of generalization but not of abstraction.
 */
export const LIMITATIONS = [
  "Not a coding benchmark. Neither eval edits a repository, runs a test suite, or uses tools; they measure rule inference (SEE) and solver soundness (DO), not software engineering.",
  "DO scores a program, not a chain of thought. The model writes solve(board, mines) in a single call and never sees an individual board, so a DO score describes the code it emitted — not deduction performed at inference time. A correct solver may be recalled rather than derived.",
  "A low Generalization Index is evidence of generalization, not proof of abstraction. It shows performance carried from shown to held-out inputs within one distribution; a heuristic fitted to that distribution would score the same. Separating the two needs a held-out task family the model provably could not have seen, which the suite does not have.",
  "Neither eval controls for prior exposure. There is no canary and no novel-format control, so a high score cannot be attributed to reasoning over recall of the specific task or the textbook algorithm.",
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
 * `<date>-<HHmmss>` from a report's own ISO timestamp, so the name is derived
 * from the report rather than from when the process happens to run.
 *
 * Same-day re-runs of the same model used to overwrite each other silently
 * (writeFileSync truncates), and for the COMMITTED combined reports that
 * silently rewrote history on the next git add. Distinct model ids can also
 * slug to the same filename (gpt-4o(2024) and gpt-4o-2024), so the date alone
 * was never enough. The time component is UTC, matching the timestamp it is
 * taken from.
 */
const fileStamp = (iso) => `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}`;

/**
 * Write a report, refusing to clobber one that is already there.
 *
 * The timestamp carries seconds, so two runs of the same model inside the same
 * second would previously have written the same path and the second silently
 * truncated the first (writeFileSync overwrites). For a combined report that is
 * evidence committed to the repo, so a collision quietly discarded a score.
 *
 * Rather than invent a suffix and leave two files whose relationship is
 * unclear, this fails loudly. A caller that genuinely wants to overwrite says
 * so with `overwrite: true`.
 *
 * @param {string} path        destination file
 * @param {object} report      already-serialisable report object
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite] replace an existing file instead of throwing
 * @returns {string} the path written
 */
const writeReportFile = (path, report, { overwrite = false } = {}) => {
  if (!overwrite && existsSync(path)) {
    throw new Error(
      `report already exists, refusing to overwrite: ${path}\n` +
        `  Two runs of the same model landed in the same second. Re-run; the` +
        ` timestamp carries seconds, so the next one gets its own file.`
    );
  }
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
};

/**
 * The lower median of an even-length list: sorted, take the middle-low index.
 * Integer-valued by construction, and the conservative half when two disagree.
 * The headline a multi-run report plots, so a single lucky or unlucky run
 * (measured: unpinned -r 3 gave 21, 50, 50 across three providers) cannot become
 * the committed number just by happening to be last.
 */
export const median = (xs) => {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/** temperatureHonoured from a reproducibility verdict: unknown stays null. */
const honouredFrom = (verdict) =>
  ({ REPRODUCIBLE: true, NOT_REPRODUCIBLE: false }[verdict] ?? null);

/**
 * Assemble the machine-readable report.
 *
 * @param {object} opts
 * @param {string} opts.model         model id exactly as passed on the CLI
 * @param {Array}  opts.taskRuns      taskRuns from the final run
 * @param {object} opts.last          the runSee() summary, used for headline numbers
 * @param {number[]} opts.indices     Generalization Index for each run
 * @param {object} opts.reproducibility output of reproducibility()
 * @param {object} opts.config        resolved adapter config (key is NOT copied)
 */
export const buildReport = ({ model, taskRuns, last, indices, reproducibility, config, keySource, startedAt }) => {
  return {
    schema: "monkey-see/report@2",
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
      // Why the model stopped, per dialect. A Responses endpoint reports
      // "max_output_tokens" here when the answer was cut off, which is the
      // difference between a model that cannot solve the task and a harness
      // that gave it too little room. Null where the dialect has no such field.
      finishReason: taskRuns.find((t) => t.finishReason)?.finishReason ?? null,
    },

    generation: {
      temperature: 0,
      // What the model config says about temperature 0, including whether the
      // score was recorded under --i-cannot-control-temperature.
      temperatureControl: temperatureStatus(config),
      // Never assume this. It is only knowable after a reproducibility check,
      // and `null` must not be reported as `true`. NO_VERDICT (too few
      // answered runs to compare) also stays null: unknown, not false.
      temperatureHonoured: reproducibility ? honouredFrom(reproducibility.verdict) : null,
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
      generalizationIndex: last ? Math.round(last.index.index * 100) : null,
      indexReading: last ? last.reading : null,
      seen: last ? Number(last.seen.rate.toFixed(4)) : null,
      heldOut: last ? Number(last.index.heldOut.toFixed(4)) : null,
      perRunGeneralizationIndex: indices ?? null,
    },

    reproducibility: reproducibility
      ? {
          // NO_VERDICT means too few answered runs to compare: unknown, not
          // stable, and not unstable either. Failed runs are excluded upstream
          // (they all share the empty response's constant fingerprint).
          verdict: reproducibility.verdict ?? "NO_VERDICT",
          perTask: Object.fromEntries(
            Object.entries(reproducibility.perTask).map(([id, info]) => [
              id,
              {
                distinctResponses: info.distinct,
                runs: info.runs,
                failedRuns: info.failedRuns ?? 0,
                fingerprints: info.prints,
              },
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
      // Set when the call for this task produced nothing at all. A zero beside
      // this is the score of a missing answer, not of a wrong one.
      callFailure: t.callFailure ?? null,
      callElapsedMs: t.callElapsedMs ?? null,
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

/** Write the report to results/<model>-<date>-<time>.json and return the path. */
export const writeReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${slug(report.model.requested)}-${fileStamp(report.timestamp)}.json`);
  return writeReportFile(path, report, opts);
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
  schema: "monkey-do/report@3",
  eval: "DO",
  timestamp: new Date().toISOString(),

  model: {
    requested: model,
    resolvedByProvider: result.providerModel ?? null,
    endpoint: config?.endpoint ?? null,
    // See the SEE report: "max_output_tokens" here means a truncated solver,
    // not a model that could not write one.
    finishReason: result.finishReason ?? null,
    // A dry run is not a model result and must never be filed as one.
    dryRun: result.dryRun === true,
  },

  generation: {
    temperature: 0,
    temperatureControl: temperatureStatus(config),
    // Not assumed: temperature 0 is a request, not a guarantee, and only a
    // reproducibility check can establish it. Only ANSWERED runs are evidence:
    // the caller passes answered runs' prints, because a failed run shares the
    // empty response's constant fingerprint with every other failure.
    temperatureHonoured: reproducibility ? honouredFrom(printVerdict(reproducibility.prints)) : null,
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

  // A second axis on the same boards, deliberately outside `score`. A solver
  // that surrendered immediately still banks score.points.poolANoDetonation,
  // so the 50 alone cannot distinguish caution from inertia; this can.
  progressIndex: result.progressIndex,

  reproduction: reproducibility
    ? {
        prints: reproducibility.prints,
        failedRuns: reproducibility.failedRuns ?? 0,
        totals: reproducibility.totals ?? null,
        // NO_VERDICT: fewer than two answered runs, so neither word is
        // claimable. Failed runs are excluded rather than counted, which is
        // the fix for the bug where two timeouts certified as "identical code".
        verdict: printVerdict(reproducibility.prints) ?? "NO_VERDICT",
      }
    : null,

  solver: {
    usable: result.usable,
    compileError: result.compileError,
    responseFingerprint: result.responseFingerprint,
    // The full source. It is the evidence for every score below.
    response: result.response,
    // Set when the model call produced nothing at all. A score beside this is
    // NOT a measurement of the model: `timeout` describes the route, not the
    // reasoning. Read this field before quoting any total from a run where it
    // is non-null. An EMPTY completion is a different event: the endpoint
    // answered with zero-length text, the adapter RETURNS it rather than
    // throwing, and it scores as a compile error plus protocol_violation on
    // every board — visible here as usable: false and the compileError above,
    // with callFailure null.
    callFailure: result.callFailure ?? null,
    // How long the one call took. On a timeout this is the budget, not a
    // measurement, so it cannot distinguish "slow" from "never coming back".
    callElapsedMs: result.callElapsedMs ?? null,
    // The budget that was in force for this run, so a timeout is readable: a
    // model that needed 200s at a 420s budget is a different finding from one
    // that hit a 120s ceiling and stopped.
    callTimeoutMs: result.callTimeoutMs ?? null,
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
    "no_response means the model call produced nothing, so no board was played. If solver.callFailure",
    "  is set, the score is 0 for want of an answer and is NOT evidence about the model. A timeout",
    "  there describes the route (endpoint, provider, budget), not the reasoning.",
  ],
});

/** Write a DO report. Shares the naming scheme with SEE so results sort together. */
export const writeDoReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `do-${slug(report.model.requested)}-${fileStamp(report.timestamp)}.json`);
  return writeReportFile(path, report, opts);
};

/**
 * The combined report written by run-all, in the order the tests pin:
 * model, date, temperature guarantee, route failures, SEE score and index, DO
 * score and baseline gap, limitations, combined total. The per-eval reports
 * remain the primary artefacts; this one points at them.
 *
 * With --runs > 1 the headline totals are the MEDIAN of the per-run totals,
 * not the last run's. The last run of an unstable endpoint is a sample that
 * happened to be last (measured: unpinned -r 3 gave 21, 50, 50 across three
 * providers); the median is the number a chart should plot, with every
 * per-run total kept beside it in `stability`. A single-run report is unchanged.
 *
 * @param {object} opts
 * @param {object} opts.see      the last runSee() summary
 * @param {object} opts.doo      the last runDo() result
 * @param {object} [opts.stability]  per-run totals and verdicts when --runs > 1
 * @param {object} [opts.paths]  { see, do } report paths
 */
export const buildCombinedReport = ({ model, config, keySource, see, doo, pool, reading, stability = null, paths = {} }) => {
  const seeTotal = stability?.seeTotals?.length ? median(stability.seeTotals) : Math.round(see.points + see.noCrash);
  const doTotal = stability?.doTotals?.length ? median(stability.doTotals) : doo.score.total;
  return {
    schema: "monkey-see-monkey-do/combined@4",
    model: { requested: model, endpoint: config?.endpoint ?? null },
    date: new Date().toISOString(),
    temperature: { ...temperatureStatus(config), keySource: keySource ?? null },
    // ROUTE failures, not model failures. A zero beside a non-null entry here
    // is the score of a call that never returned and says nothing about the
    // model. This is the COMMITTED file, and the per-eval reports that carry
    // the detail are gitignored, so without this block the only auditable
    // artefact could show a route-failure 0 as a plain 0.
    callFailure: {
      see: (see.taskRuns ?? [])
        .filter((t) => t.callFailure)
        .map((t) => ({
          taskId: t.taskId,
          reason: t.callFailure.reason ?? null,
          message: String(t.callFailure.message ?? "").slice(0, 160),
          elapsedMs: t.callFailure.elapsedMs ?? null,
        })),
      do: doo.callFailure
        ? {
            reason: doo.callFailure.reason ?? null,
            message: String(doo.callFailure.message ?? "").slice(0, 160),
            elapsedMs: doo.callFailure.elapsedMs ?? null,
            timeoutMs: doo.callFailure.timeoutMs ?? null,
            attempts: doo.callFailure.attempts ?? null,
          }
        : null,
    },
    see: {
      total: seeTotal,
      max: 50,
      generalizationIndex: Math.round(see.index.index * 100),
      reading: see.reading,
      seen: Number(see.seen.rate.toFixed(4)),
      heldOut: Number(see.index.heldOut.toFixed(4)),
    },
    do: {
      total: doTotal,
      max: 50,
      // An answer that could not be compiled (prose, an empty completion) is
      // visible HERE too, not only in the gitignored per-eval report: a 0/50
      // with usable: false and a compileError is a different fact from a 0/50
      // the model played and lost.
      usable: doo.usable !== false,
      compileError: doo.compileError ?? null,
      poolAWon: Number(doo.score.poolA.won.toFixed(4)),
      poolANoConfidentError: Number(doo.score.poolA.noDetonation.toFixed(4)),
      poolBCorrectStop: Number(doo.score.poolB.correctStop.toFixed(4)),
      baselineGap: doo.score.index,
      // Carried here so one file answers every column the cohort table prints.
      // Without it a reader auditing a chart from the repo has to open the
      // separate DO report, which is 135 KB per model and gitignored.
      progressIndex: doo.progressIndex
        ? {
            total: doo.progressIndex.total,
            max: doo.progressIndex.max,
            points: doo.progressIndex.points,
            initiationRate: doo.progressIndex.initiationRate,
            meanCalls: doo.progressIndex.meanCalls,
            inert: doo.progressIndex.inert,
          }
        : null,
      poolSha256: pool?.sha256 ?? null,
      fullPool: pool?.full ?? null,
    },
    limitations: LIMITATIONS,
    combined: {
      // The medians of the per-run totals when --runs > 1; see the header.
      total: seeTotal + doTotal,
      max: 100,
      reading,
    },
    // REPORTING ONLY — see src/adjusted.mjs. `combined.total` above is
    // untouched; this is the single figure to plot once the Generalization Index and
    // the DO progress index are folded in.
    adjusted: adjustedTotal({
      seeTotal,
      doTotal,
      generalizationIndex: Math.round(see.index.index * 100),
      initiationRate: doo.progressIndex?.initiationRate ?? 1,
    }),
    stability,
    reports: paths,
  };
};

/** Write the combined report next to the per-eval ones. */
export const writeCombinedReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `combined-${slug(report.model.requested)}-${fileStamp(report.date)}.json`);
  return writeReportFile(path, report, opts);
};
