// Report output: every result is written to results/<model>-<date>.json.
//
// A benchmark score you cannot re-derive is an anecdote. The file records
// everything needed to reconstruct the number later:
//
//   - the model id exactly as passed, and the provider's own returned id
//     (they differ, and the difference matters)
//   - the prompt SHA-256 for each task and level, so we can prove which
//     text was scored
//   - the reproducibility verdict, because an unstable score means something
//     different from a stable one and a reader must be able to tell
//   - per-task pass rates, per-level breakdown, and the seen/held-out arms
//   - the raw model response, so a surprising score can be explained without
//     re-running anything
//
// Deliberately NOT recorded: the API key, or any fragment of it.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { allPromptDigests, SAMPLE_LEVELS } from "./see/prompt.mjs";
import { fingerprint, printVerdict } from "./fingerprint.mjs";
import { temperatureStatus } from "./adapters/registry.mjs";
import { adjustedTotal } from "./adjusted.mjs";
import { chainEngagementRate } from "./do/chain/score.mjs";
import { SAMPLE_WEIGHTS } from "./see/score.mjs";

/**
 * A report omitting the limitations is invalid, regardless of the scores. So
 * every report — SEE, DO v2 and combined — carries all of them, and the
 * console prints them after every run.
 *
 * These are the load-bearing ones. Two in particular constrain how far any
 * score can be read: DO v2 scores a program rather than a chain of thought,
 * and a low Generalization Index is evidence of generalization but not of
 * abstraction.
 */
export const LIMITATIONS = [
  "Not a coding benchmark. Neither eval edits a repository, runs a test suite, or uses tools; they measure rule inference (SEE) and chain-rewrite derivation (DO v2), not software engineering.",
  "DO v2 scores a program, not a chain of thought. The model writes solve(start, target) in a single call and never sees an individual chain, so a DO v2 score describes the code it emitted — not deduction performed at inference time. A correct solver may be recalled rather than derived.",
  "A low Generalization Index is evidence of generalization, not proof of abstraction. It shows performance carried from shown to held-out inputs within one distribution; a heuristic fitted to that distribution would score the same. Separating the two needs a held-out task family the model provably could not have seen, which the suite does not have.",
  "Neither eval controls for prior exposure. There is no canary and no novel-format control, so a high score cannot be attributed to reasoning over recall of the specific task or the textbook algorithm.",
  "SEE saturates. Frontier models reach high SEE scores and it stops discriminating at the top of the market; it is most informative for open-weight and mid-tier models.",
  "Not comparable to SWE-bench, HumanEval, or any external leaderboard. Different scale, different construction; never present these numbers alongside one.",
  "DO v2 has residual contamination risk. The 5-rule / 7-symbol formal system is novel, but BFS on derivable search spaces is a textbook technique; a high DO v2 score shows the model can produce a correct solver, not that it deduced one afresh.",
  "Two narrow tasks. This is not a general intelligence measure, and the 50-point weights are hand-chosen (frozen at suite version 1.0.0).",
  "Suite 1.0.0 DO scores are not comparable to suite 0.x.x DO scores. The pivot changed the task, the pool, the prompt, the scorer, and the limit, with no continuity arithmetic. Old DO scores keep their numbers; new DO scores are reported on the new scale.",
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

/** Temperature honoured from a reproducibility verdict: unknown stays null. */
const honouredFrom = (verdict) =>
  ({ REPRODUCIBLE: true, NOT_REPRODUCIBLE: false }[verdict] ?? null);

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

/**
 * SEE report (suite 1.0.0, sample-efficiency axis).
 *
 * The new report carries per-level seen / held-out / GZ so a reader can audit
 * the per-level numbers that the weighted score aggregates. Level 8 is the
 * backward-compat slot: every old Cohort 1 SEE score lives here.
 */
export const buildSeeLevelsReport = ({ model, last, reproducibility, config, keySource, runs }) => {
  const perLevel = {};
  for (const [level, e] of Object.entries(last.perLevel)) {
    perLevel[level] = {
      seen: e.seen ? { correct: e.seen.correct, total: e.seen.total, rate: Number(e.seen.rate.toFixed(4)) } : null,
      heldOut: { correct: e.heldOut.correct, total: e.heldOut.total, rate: Number(e.heldOut.rate.toFixed(4)) },
      gz: e.gz === null || e.gz === undefined ? null : Number(e.gz.toFixed(4)),
    };
  }
  const gzMean = Object.values(perLevel).reduce((s, e) => s + (e.gz ?? 0), 0) / Math.max(1, Object.keys(perLevel).length);

  const perTask = {};
  for (const [id, t] of Object.entries(last.perTask)) {
    const taskLevels = {};
    for (const [level, r] of Object.entries(t.levels)) {
      taskLevels[level] = r && r.usable
        ? {
            seen: { correct: r.seen.correct, total: r.seen.total },
            heldOut: { correct: r.heldOut.correct, total: r.heldOut.total },
            gz: Number(((r.seen.correct / r.seen.total) - (r.heldOut.correct / r.heldOut.total)).toFixed(4)),
          }
        : null;
    }
    perTask[id] = {
      taskId: t.taskId,
      name: t.name,
      weightedRate: Number(t.weightedRate.toFixed(4)),
      gzMean: Number(t.gzMean.toFixed(4)),
      perLevel: taskLevels,
    };
  }

  return {
    schema: "monkey-see/levels@1",
    eval: "SEE",
    timestamp: new Date().toISOString(),
    levels: SAMPLE_LEVELS,
    weights: SAMPLE_WEIGHTS,

    model: {
      requested: model,
      resolvedByProvider: last.runs?.find((run) => run.providerModel)?.providerModel ?? null,
      endpoint: config?.endpoint ?? null,
      finishReason: last.runs?.find((run) => run.finishReason)?.finishReason ?? null,
    },

    generation: {
      temperature: 0,
      temperatureControl: temperatureStatus(config),
      temperatureHonoured: reproducibility ? honouredFrom(reproducibility.seeVerdict) : null,
      seed: config?.seed ?? null,
      providerPin: config?.provider ?? null,
      keySource: keySource ?? null,
      // 12 model calls per run (3 tasks × 4 levels). Recorded so the
      // combined report is self-describing without forcing the reader
      // to count.
      modelCallsPerRun: 12,
    },

    prompts: allPromptDigests().map(({ taskId, digest }) => ({ taskId, sha256: digest })),

    score: {
      // Per-level pooled GZ is the headline; per-task weighted rate is
      // the per-task aggregate; gzMean is the rolled-up number.
      perLevel,
      perTask,
      gzMean: Number((gzMean * 100).toFixed(4)),
      // Robustness is unchanged. The bonus is computed from a single
      // held-out arm (the held-out arm is identical across levels, so
      // summing throws across levels would double-count).
      robustness: last.robustness
        ? {
            points: Number(last.robustness.points.toFixed(4)),
            max: 5,
            threw: last.robustness.threw,
            total: last.robustness.total,
            rate: Number(last.robustness.rate.toFixed(4)),
            crashed: last.robustness.crashed,
          }
        : null,
      // Headline: sum of (per-task weightedRate × 15) + robustness.
      points: Object.values(last.perTask).reduce((s, t) => s + t.weightedRate * 15, 0),
      robustnessPoints: last.robustness ? last.robustness.points : 0,
      total: Object.values(last.perTask).reduce((s, t) => s + t.weightedRate * 15, 0) + (last.robustness ? last.robustness.points : 0),
      maxTotal: 50,
    },

    reproducibility: reproducibility
      ? {
          verdict: reproducibility.seeVerdict ?? "NO_VERDICT",
          prints: reproducibility.seePrints ?? [],
        }
      : null,

    runs: last.runs?.map((r) => ({
      taskId: r.taskId,
      name: r.name,
      level: r.level,
      promptSha256: r.promptDigest,
      usable: r.usable,
      compileError: r.compileError ?? null,
      callFailure: r.callFailure ?? null,
      seen: r.seen ? { correct: r.seen.correct, total: r.seen.total, rate: r.seen.rate } : null,
      heldOut: r.heldOut ?? null,
      responseFingerprint: r.responseFingerprint,
      response: r.response ?? null,
    })) ?? null,

    limitations: LIMITATIONS,

    notes: [
      "Each level renders the FIRST <level> entries of task.shown. Held-out is the same 50 cases at every level.",
      "Per-task weightedRate = sum across levels of (SAMPLE_WEIGHTS[level] * heldOutRate).",
      "gzMean = unweighted mean of per-level GZ. Phase 5 folds gzMean into the adjusted total.",
      "Expected values are derived at runtime from src/see/reference.mjs, not stored.",
      "An unusable response counts as 50 failed, thrown held-out cases for its task.",
      "No held-out case or reference implementation appears in this file.",
      "Level 8 is byte-identical to the level-8 prompt shipped under suite 0.x.x; old Cohort 1 SEE scores remain comparable to a new level-8 run.",
      "Levels 2, 4 and 16 are NEW prompt slots at suite 1.0.0. Their digests are pinned in src/prompt-digests.mjs (SEE_LEVEL_DIGESTS).",
    ],
  };
};

/** Write a SEE-level report to results/<model>-<date>-<time>.json and return the path. */
export const writeSeeLevelsReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${slug(report.model.requested)}-${fileStamp(report.timestamp)}.json`);
  return writeReportFile(path, report, opts);
};

/**
 * DO v2 (chain eval) report.
 *
 * Records per-band results, per-chain outcomes, and the chain engagement
 * rate. The engagement rate is the new signal the adjusted formula uses
 * in place of the legacy Minesweeper progress index.
 */
export const buildChainDoReport = ({ model, result, config, keySource, pool, reproducibility }) => {
  const perBand = {};
  for (const [band, b] of Object.entries(result.score.perBand)) {
    perBand[band] = {
      score: Number(b.score.toFixed(4)),
      points: Number(b.points.toFixed(2)),
      max: b.max,
      chains: b.chains.map((c) => ({
        id: c.id,
        correctSteps: c.correctSteps,
        submittedSteps: c.submittedSteps,
        reachedTarget: c.reachedTarget,
        fullCredit: c.fullCredit,
        partial: c.partial,
        chainScore: c.chainScore,
        outcome: c.outcome,
        error: c.error ?? null,
      })),
    };
  }

  return {
    schema: "monkey-do/chain@1",
    eval: "DO",
    timestamp: new Date().toISOString(),

    model: {
      requested: model,
      resolvedByProvider: result.providerModel ?? null,
      endpoint: config?.endpoint ?? null,
      finishReason: result.finishReason ?? null,
      dryRun: result.dryRun === true,
    },

    generation: {
      temperature: 0,
      temperatureControl: temperatureStatus(config),
      // Only ANSWERED runs are evidence of determinism. A failed run
      // records an empty response, whose fingerprint is the same constant
      // for every failure mode.
      temperatureHonoured: reproducibility ? honouredFrom(printVerdict(reproducibility.prints)) : null,
      seed: config?.seed ?? null,
      providerPin: config?.provider ?? null,
      keySource: keySource ?? null,
      modelCalls: 1,
    },

    pool: {
      sha256: pool.sha256,
      full: pool.full,
      publishedSha256: pool.publishedSha256 ?? pool.sha256,
      seed: pool.seed,
      chainCount: pool.chains.length,
    },

    prompt: { sha256: result.digest },

    score: {
      total: result.score.total,
      max: result.score.max,
      perBand,
      perChain: result.score.perChain,
      // Chain engagement rate — the fraction of chains on which the
      // model's submission made at least one legal step (full credit
      // or partial). An empty submission scores 0; full credit on every
      // chain scores 1.
      chainEngagementRate: Number(chainEngagementRate(result.score.perChain).toFixed(4)),
    },

    reproduction: reproducibility
      ? {
          prints: reproducibility.prints,
          failedRuns: reproducibility.failedRuns ?? 0,
          verdict: printVerdict(reproducibility.prints) ?? "NO_VERDICT",
        }
      : null,

    solver: {
      usable: result.usable,
      compileError: result.compileError,
      responseFingerprint: result.responseFingerprint,
      response: result.response,
      callFailure: result.callFailure ?? null,
      callElapsedMs: result.callElapsedMs ?? null,
      callTimeoutMs: result.callTimeoutMs ?? null,
      // The canary strings the prompt asked the model to echo verbatim.
      canary: result.canary ?? null,
    },

    limitations: LIMITATIONS,

    notes: [
      "Chains come from the published pool (src/do/chain/pool.json), verified on load against seed 0xC0FFEE.",
      "The model is called as solve(start, target): the formal system rules are stated verbatim in the prompt.",
      "Every step is checked for legality. A step's rule must be applicable at its recorded position AND produce the recorded next state.",
      "fullCredit means every step replayed is legal AND the final state equals target.",
      "partial means some steps were legal but the chain did not reach it.",
      "protocol_violation means the solver was unusable — a broken solver, not a reasoning failure.",
      "no_response means the model call produced nothing, so no chain was played. If solver.callFailure is set, the score is 0 for want of an answer and is NOT evidence about the model. A timeout describes the route, not the reasoning.",
      "chainEngagementRate drives the chain-engagement clawback in the adjusted total (Phase 5).",
    ],
  };
};

/** Write a DO v2 report. Shares the naming scheme with SEE so results sort together. */
export const writeChainDoReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `do-${slug(report.model.requested)}-${fileStamp(report.timestamp)}.json`);
  return writeReportFile(path, report, opts);
};

// -----------------------------------------------------------------------------
// LEGACY: Minesweeper DO report builders.
//
// Kept exported while the legacy Minesweeper self-test block (and any user
// still running `npm run do` against the old eval) imports them. Phase 6 will
// delete them along with src/do/minesweeper/* and src/do/run.mjs.
//
// The data shape is unchanged from suite 0.x.x; only the prompt digest pin
// was retired (the new DO v2 digest replaced it). Old reports in results/ that
// were scored under the Minesweeper DO keep their numbers — they were never
// rewritten. New Minesweeper DO reports will fail their digest pin (Phase 6
// deletes the field altogether).
// -----------------------------------------------------------------------------

/**
 * MONKEY DO's machine-readable report (legacy Minesweeper eval).
 */
export const buildDoReport = ({ model, result, config, keySource, pool, baseline, reproducibility }) => ({
  schema: "monkey-do/report@3",
  eval: "DO",
  timestamp: new Date().toISOString(),

  model: {
    requested: model,
    resolvedByProvider: result.providerModel ?? null,
    endpoint: config?.endpoint ?? null,
    finishReason: result.finishReason ?? null,
    dryRun: result.dryRun === true,
  },

  generation: {
    temperature: 0,
    temperatureControl: temperatureStatus(config),
    temperatureHonoured: reproducibility ? honouredFrom(printVerdict(reproducibility.prints)) : null,
    seed: config?.seed ?? null,
    providerPin: config?.provider ?? null,
    keySource: keySource ?? null,
    modelCalls: 1,
  },

  pool: {
    sha256: pool.sha256,
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
    points: result.score.points ?? {},
    poolA: result.score.poolA,
    poolB: result.score.poolB,
    poolABands: result.score.points?.poolABands ?? {},
    poolABandWeights: result.score.poolABandWeights ?? { 2: 10, 3: 20 },
    poolABandCounts: result.score.poolABandCounts ?? {},
    poolBStopPoints: result.score.points?.poolBCorrectStop ?? 0,
    verdictSoundPoints: result.score.points?.poolBVerdictSound ?? 0,
    verdictSharpPoints: result.score.points?.poolBVerdictSharp ?? 0,
    poolBTotal: result.score.points?.poolBTotal ?? (result.score.points?.poolBCorrectStop ?? 0),
    poolBVerdict: result.score.poolBVerdict,
    perTier: result.score.perTier,
    poolBPerTier: result.score.poolBPerTier,
    index: result.score.index,
    outcomes: result.score.outcomes,
    unverifiedMoves: result.score.unverifiedMoves,
  },

  // LEGACY: progressIndex from the Minesweeper DO. Removed from the
  // adjusted formula at suite 1.0.0 in favour of the DO v2 chain
  // engagement rate. Retained here so legacy reports still render and
  // downstream readers can see the data, but the field is no longer
  // consumed by anything new.
  progressIndex: result.progressIndex ?? null,

  reproduction: reproducibility
    ? {
        prints: reproducibility.prints,
        failedRuns: reproducibility.failedRuns ?? 0,
        totals: reproducibility.totals ?? null,
        verdict: printVerdict(reproducibility.prints) ?? "NO_VERDICT",
      }
    : null,

  solver: {
    usable: result.usable,
    compileError: result.compileError,
    responseFingerprint: result.responseFingerprint,
    response: result.response,
    callFailure: result.callFailure ?? null,
    callElapsedMs: result.callElapsedMs ?? null,
    callTimeoutMs: result.callTimeoutMs ?? null,
  },

  boardResults: result.boardResults,
  verdictErrors: result.verdictErrors ?? null,

  limitations: LIMITATIONS,

  notes: [
    "LEGACY: Minesweeper DO. Suite 1.0.0 added DO v2; this report is retained only so old runs in results/ still render. Old reports keep their numbers; new Minesweeper DO reports will fail their digest pin (Phase 6 deletes the field).",
    "Boards come from the published pool (src/do/minesweeper/pool.json), verified on load against seed 0x5EED.",
    "The model is called as solve(board, mines): the visible grid and the total mine count.",
    "Every move is checked for proof. unproven_move means the cell happened to be safe but could not have been proven safe; it is scored like a detonation.",
  ],
});

/** Write a legacy DO report. */
export const writeDoReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `do-${slug(report.model.requested)}-${fileStamp(report.timestamp)}.json`);
  return writeReportFile(path, report, opts);
};

/**
 * The combined report written by run-all, in the order the tests pin:
 * model, date, temperature guarantee, route failures, SEE score, DO v2 score,
 * limitations, combined total. The per-eval reports remain the primary
 * artefacts; this one points at them.
 *
 * With --runs > 1 the headline totals are the MEDIAN of the per-run totals,
 * not the last run's. The last run of an unstable endpoint is a sample that
 * happened to be last; the median is the number a chart should plot.
 *
 * @param {object} opts
 * @param {object} opts.see      the last runAllLevels() summary
 * @param {object} opts.doo      the last runChainDo() result
 * @param {object} [opts.stability]  per-run totals and verdicts when --runs > 1
 * @param {object} [opts.paths]  { see, do } report paths
 */
export const buildCombinedReport = ({ model, config, keySource, see, doo, pool, reading, stability = null, paths = {} }) => {
  // SEE total = sum of (per-task weightedRate × 15) + robustness.
  const seeTotal = Object.values(see.perTask).reduce((s, t) => s + t.weightedRate * 15, 0) + see.robustness.points;
  // DO v2 total = chain score total (sum across bands, max 50).
  const doTotal = doo.score.total;

  // Per-level pooled GZ rolled into a single number (percentage, 0-100).
  const perLevel = see.perLevel ?? {};
  const levels = Object.keys(perLevel);
  const gzMean = levels.length
    ? (levels.reduce((s, l) => s + (perLevel[l].gz ?? 0) * 100, 0) / levels.length)
    : 0;

  // DO v2 chain engagement rate (fraction of chains on which the model
  // made at least one legal step). Computed once at the top so the
  // adjusted formula and the report field agree on the same number.
  const engagement = Number(chainEngagementRate(doo.score.perChain).toFixed(4));

  // Per-run medians when --runs > 1.
  const seeTotals = stability?.seeTotals?.length ? stability.seeTotals : [Math.round(seeTotal)];
  const doTotals = stability?.doTotals?.length ? stability.doTotals : [doTotal];
  const seeTotalMedian = median(seeTotals);
  const doTotalMedian = median(doTotals);
  const combinedTotals = seeTotals.map((s, i) => s + doTotals[i] ?? s);

  // Adjusted total uses the medians so the chart and the committed
  // artefact never disagree on retries.
  const adj = adjustedTotal({
    seeTotal: seeTotalMedian,
    doTotal: doTotalMedian,
    gzMean,
    chainEngagementRate: engagement,
  });

  return {
    schema: "monkey-see-monkey-do/combined@5",
    eval: "COMBINED",
    timestamp: new Date().toISOString(),

    model: { requested: model, endpoint: config?.endpoint ?? null },
    date: new Date().toISOString(),
    temperature: { ...temperatureStatus(config), keySource: keySource ?? null },

    // ROUTE failures, not model failures. A zero beside a non-null
    // entry here is the score of a call that never returned and says
    // nothing about the model. SEE routes per-level; DO has one call.
    callFailure: {
      // SEE per-level call failures: count any (task, level) pair that
      // came back with callFailure != null. This is informational — the
      // per-level report has the detail.
      seeCount: (see.runs ?? []).filter((r) => r.callFailure).length,
      do: doo.callFailure
        ? {
            reason: doo.callFailure.reason ?? null,
            message: String(doo.callFailure.message ?? "").slice(0, 160),
            elapsedMs: doo.callFailure.elapsedMs ?? null,
            timeoutMs: doo.callFailure.timeoutMs ?? null,
          }
        : null,
    },

    see: {
      total: Math.round(seeTotalMedian),
      max: 50,
      // The new sample-efficiency axis: per-level pooled seen / heldOut /
      // GZ. The per-level rate is the headlined metric (it is what the
      // model actually saw). gzMean is the rolled-up GZ the adjusted
      // formula uses.
      perLevel: Object.fromEntries(
        Object.entries(perLevel).map(([l, e]) => [
          l,
          {
            seen: e.seen ? { correct: e.seen.correct, total: e.seen.total, rate: e.seen.rate } : null,
            heldOut: { correct: e.heldOut.correct, total: e.heldOut.total, rate: e.heldOut.rate },
            gz: e.gz,
          },
        ])
      ),
      gzMean: Number(gzMean.toFixed(4)),
      perTask: Object.fromEntries(
        Object.entries(see.perTask).map(([id, t]) => [
          id,
          {
            weightedRate: t.weightedRate,
            gzMean: t.gzMean,
          },
        ])
      ),
    },

    do: {
      total: Math.round(doTotalMedian),
      max: 50,
      // An answer that could not be compiled (prose, an empty completion) is
      // visible HERE too.
      usable: doo.usable !== false,
      compileError: doo.compileError ?? null,
      // Per-band results, each band worth its weight (10 points across 5 bands).
      perBand: Object.fromEntries(
        Object.entries(doo.score.perBand).map(([band, b]) => [
          band,
          {
            score: b.score,
            points: Number(b.points.toFixed(2)),
            max: b.max,
            chainCount: b.chains.length,
            fullCreditChains: b.chains.filter((c) => c.fullCredit).length,
            partialChains: b.chains.filter((c) => c.partial).length,
          },
        ])
      ),
      // The Phase 5 engagement rate that drives the new clawback.
      chainEngagementRate: engagement,
      poolSha256: pool?.sha256 ?? null,
      fullPool: pool?.full ?? null,
    },

    combined: {
      // Medians of the per-run totals when --runs > 1.
      total: seeTotalMedian + doTotalMedian,
      max: 100,
      reading,
      // Per-run totals, exposed so a reader can reconstruct the
      // median from this file alone.
      perRunTotals: combinedTotals,
    },

    // REPORTING ONLY — see src/adjusted.mjs. `combined.total` above is
    // untouched; this is the single figure to plot once gzMean and
    // the chain-engagement clawback are folded in.
    adjusted: adj,

    stability: stability && {
      ...stability,
      // Strip the prints from the published artefact to keep its size
      // manageable. They live in the per-eval reports.
      seePrints: undefined,
      doPrints: undefined,
    },

    reports: paths,

    limitations: LIMITATIONS,

    notes: [
      "Suite 1.0.0 combined report. DO v2 (chain eval) replaces the legacy Minesweeper DO.",
      "Old Minesweeper DO reports in results/ keep their numbers; they were not rewritten.",
      "SEE gzMean drives the Generalization-Index half of the adjusted formula;",
      "DO v2 chainEngagementRate drives the chain-engagement clawback half.",
      "An unusable response counts as 50 failed cases for SEE and 50 chains with no legal step for DO v2.",
      "A zero beside a non-null callFailure is the score of a call that never returned and is NOT evidence about the model.",
      "A NOT_REPRODUCIBLE verdict means the endpoint returned different code for the same prompt; such a score is one sample from a range and must not be compared to another model or to a future run.",
    ],
  };
};

/** Write the combined report next to the per-eval ones. */
export const writeCombinedReport = (report, outDir = "results", opts = {}) => {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `combined-${slug(report.model.requested)}-${fileStamp(report.timestamp)}.json`);
  return writeReportFile(path, report, opts);
};