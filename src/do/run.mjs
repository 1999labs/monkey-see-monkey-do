// MONKEY DO — run the eval against a model.
//
//   node src/do/run.mjs --model openrouter/dots-3-note-preview:free
//
// ONE API CALL per run. The model is asked for a solve() function once, and that
// function is replayed across the entire board pool. That is what makes DO cheap
// to run repeatedly: cost is per-run, not per-board.
//
// The outcomes are the substance of the eval, and conflating any of them would
// destroy the signal:
//
//   won                 board cleared, every move proven safe
//   surrender           returned null where no cell was provable. On Pool B
//                       this is the CORRECT answer; on Pool A it cannot happen.
//   premature_surrender returned null while a provable move existed. CAUTION.
//   detonation          returned a cell that held a mine. A REASONING FAILURE.
//   unproven_move       returned a cell that turned out safe but could not have
//                       been proven safe. The same failure as a detonation,
//                       minus the bad luck, and scored the same.
//   protocol_violation  returned something unusable (out of bounds, already
//                       revealed, wrong shape, threw). Not a reasoning signal.
//   stalled             hit the effort cap. A correct solver never should.

import { complete } from "../adapters/registry.mjs";
import { compileCandidate, runCandidate } from "../sandbox.mjs";
import { fingerprint } from "../fingerprint.mjs";
import { asModelView, isWon, reveal, inBounds } from "./minesweeper/board.mjs";
import { replayBoard, capForTier, loadPublishedPool, POOL_SEED } from "./minesweeper/pool.mjs";
import { buildPrompt, promptDigest } from "./prompt.mjs";
import { analyse, verifyMove } from "./minesweeper/oracle.mjs";
import { scoreDo, randomBaseline } from "./score.mjs";
import { scoreProgressIndex } from "./progress-index.mjs";
import { buildDoReport, writeDoReport, LIMITATIONS } from "../report.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice, printLimitations } from "../cli.mjs";
import { REFERENCE_SOLVER_SOURCE } from "./reference-solver.mjs";

export { REFERENCE_SOLVER_SOURCE };

/** Is this a usable move? Anything else is a protocol violation, not a wrong guess. */
const isLegalMove = (board, move) => {
  if (move === null) return "surrender";
  if (typeof move !== "object" || Array.isArray(move)) return "protocol_violation";
  const { row, col } = move;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return "protocol_violation";
  if (!inBounds(board, row, col)) return "protocol_violation";
  if (board.revealed[row][col]) return "protocol_violation";
  return "ok";
};

/**
 * Play one board with the model's function.
 *
 * The oracle is consulted twice, and only to JUDGE, never to play:
 *
 *   - on every move, to check the cell was provably safe (verifyMove). The
 *     contract is "logically certain", and a move that merely turned out safe
 *     does not meet it. Without this check a lucky guess could win a Pool A
 *     board, and a model could guess its way past the point where Pool B asks
 *     it to stop.
 *   - on a surrender, to tell a correct stop (no provable move exists) from a
 *     premature one.
 *
 * Both judgements use exactly what the model was given: the visible grid and
 * the total mine count. When the oracle's search runs out of budget, the model
 * gets the benefit of the doubt, and the move is counted in `unverifiedMoves`.
 */
export const playBoard = (board, solve, { cap, verify = true } = {}) => {
  const limit = cap ?? capForTier(board.tier);
  let calls = 0;
  let unverifiedMoves = 0;
  const done = (outcome, extra = {}) => ({ outcome, calls, unverifiedMoves, violation: null, ...extra });

  while (calls < limit) {
    if (isWon(board)) return done("won");

    // What the model sees, as a copy, plus the mine count.
    const result = runCandidate(solve, asModelView(board), board.totalMines);

    if (!result.ok) {
      // A throw or timeout is not a reasoning failure, it is a broken solver.
      return done("protocol_violation", { violation: result.error });
    }

    const move = result.value;
    const legality = isLegalMove(board, move);
    if (legality === "protocol_violation") {
      return done("protocol_violation", { violation: `illegal move ${JSON.stringify(move)}` });
    }
    if (legality === "surrender") {
      const truth = analyse(board.visible, board.rows, board.cols, board.totalMines);
      if (truth.deducible) return done("premature_surrender");
      // An inconclusive oracle cannot call the surrender premature, so it counts
      // as a stop, flagged as unverified.
      return done("surrender", { stopVerified: truth.conclusive });
    }

    if (board.mines[move.row][move.col]) return done("detonation", { calls: calls + 1 });

    if (verify) {
      const v = verifyMove(board.visible, board.rows, board.cols, board.totalMines, move.row, move.col);
      if (!v.conclusive) unverifiedMoves++;
      else if (!v.proven) return done("unproven_move", { calls: calls + 1, move: { row: move.row, col: move.col } });
    }

    reveal(board, move.row, move.col);
    calls++;
  }
  return done("stalled");
};

/**
 * The board list this run scores: the published pool, verified on load.
 *
 * `perTier` takes a deterministic prefix of every (pool, tier) for a quick run.
 * Such a run is marked `full: false` in the report, because its score is not
 * comparable with a full-pool score.
 */
export const loadPool = ({ perTier = null, path } = {}) => loadPublishedPool({ perTier, path });

/**
 * Run the whole eval: ONE model call, then every board in the pool.
 *
 * `dryRun` substitutes the reference solver for the model and makes NO network
 * call. The solver is compiled fresh for every board, so a model's function
 * cannot carry state from one board to the next ("pure function").
 *
 * @param {object} config resolved adapter config (unused when dryRun)
 * @param {object} opts
 * @param {Array}  opts.boards   [{ tier, attempt, pool }]
 * @param {number} opts.seed     the pool's seed (default: the published seed)
 * @param {object} opts.baseline tier -> random survival rate
 * @param {boolean} opts.dryRun  use the reference solver, no API call
 */
/**
 * Why a model call produced nothing, in terms a report reader can act on.
 *
 * The distinction that matters: `empty_response` means the endpoint answered
 * and declined to say anything, which is a real answer and is scored. Everything
 * else means we never got one, and the number describes the route, not the
 * model. Keeping those apart is the whole point of recording this at all.
 */
const classifyCallFailure = (err) => {
  const message = String(err?.message ?? err ?? "");
  const status = err?.status;
  if (err?.name === "AbortError" || /abort/i.test(message)) return "timeout";
  if (/non-JSON/i.test(message)) return "non_json_response";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (typeof status === "number") return `http_${status}`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message)) return "network_error";
  return "provider_error";
};

export const runDo = async (config, { boards, seed = POOL_SEED, baseline = {}, onProgress, dryRun = false } = {}) => {
  const callStartedAt = Date.now();
  // Recorded even on success: a run that took 200s and one that took 2s are
  // different facts about a model, and the cohort tables need both.
  const callTimeoutMs = config?.timeoutMs ?? null;

  // A model that times out, returns nothing, or errors must still produce a
  // scored run. A model that answers badly already does: it lands as
  // protocol_violation or detonation and is written out with a score. Without
  // this, an endpoint that stalls produces NO report at all, which is
  // indistinguishable from a run nobody started — and it is not evidence about
  // the model, it is evidence about the provider.
  //
  // So the failure is caught here and turned into the `no_response` outcome
  // below. The timeout itself is NOT raised or lengthened: a hung request must
  // still fail fast rather than hang a cohort run indefinitely.
  let completion = null;
  let callFailure = null;
  if (dryRun) {
    completion = { text: REFERENCE_SOLVER_SOURCE, providerModel: "dry-run/reference-solver" };
  } else {
    try {
      completion = await complete(config, buildPrompt());
    } catch (err) {
      callFailure = {
        reason: classifyCallFailure(err),
        message: String(err?.message ?? err),
        elapsedMs: Date.now() - callStartedAt,
        // The budget that was in force, so a report reader can tell a model
        // that needed longer from one that would never have answered.
        timeoutMs: err?.timeoutMs ?? config?.timeoutMs ?? null,
        // Timeouts are not retried, so one wait is the cost of finding out.
        attempts: err?.timedOut ? 1 : null,
      };
    }
  }

  const boardResults = [];

  // No answer at all: every board is `no_response`, which is a scored outcome,
  // not an exception. A DIFFERENT failure from protocol_violation (which means
  // the model answered with something unusable) and from stalled (which means
  // the solver answered but made no progress within the oracle's budget).
  if (callFailure) {
    for (const b of boards) {
      boardResults.push({
        pool: b.pool,
        tier: b.tier,
        attempt: b.attempt,
        outcome: "no_response",
        calls: 0,
      });
    }
    return {
      boardResults,
      score: scoreDo({ boardResults, baseline }),
      progressIndex: scoreProgressIndex({ boardResults }),
      usable: false,
      compileError: null,
      callFailure,
      callElapsedMs: Date.now() - callStartedAt,
      callTimeoutMs,
      response: "",
      providerModel: null,
      finishReason: null,
      responseFingerprint: fingerprint(""),
      digest: promptDigest(),
      dryRun,
    };
  }

  const first = compileCandidate(completion.text, { entry: "solve" });
  const compileError = first.ok ? null : first.error;

  for (const [i, b] of boards.entries()) {
    onProgress?.(i, boards.length, b);
    if (!first.ok) {
      boardResults.push({ pool: b.pool, tier: b.tier, attempt: b.attempt, outcome: "protocol_violation", calls: 0, violation: compileError });
      continue;
    }
    const compiled = i === 0 ? first : compileCandidate(completion.text, { entry: "solve" });
    const board = replayBoard(b.tier, b.attempt, seed);
    boardResults.push({ pool: b.pool, tier: b.tier, attempt: b.attempt, ...playBoard(board, compiled) });
  }

  return {
    boardResults,
    score: scoreDo({ boardResults, baseline }),
    // Reported beside the 50, never inside it. See src/do/progress-index.mjs.
    progressIndex: scoreProgressIndex({ boardResults }),
    usable: compileError === null,
    compileError,
    callFailure: null,
    callElapsedMs: Date.now() - callStartedAt,
    callTimeoutMs,
    response: dryRun ? "(reference solver — no model was called)" : completion.text,
    providerModel: completion.providerModel ?? null,
    finishReason: completion.finishReason ?? null,
    responseFingerprint: fingerprint(completion.text),
    digest: promptDigest(),
    dryRun,
  };
};

// --- CLI -----------------------------------------------------------------

const HELP = `
MONKEY DO

  node src/do/run.mjs --model <provider/model>

  --model, -m    the model to score, e.g.
                   openrouter/dots-3-note-preview:free
                   ollama/qwen2.5-coder:7b
                 or any id defined in config/models.json
  --key,   -k    your API key. Usually unnecessary: the tool looks in the
                 provider's environment variable, ~/.config/monkeydo, then .env.
  --per-tier N   score only the first N boards per tier per pool (a quick run;
                 the report marks it as a subset, not comparable to a full run)
  --out DIR      where to write the JSON result (default results/)
  --runs,  -r    repeat the whole eval N times to check stability (default 1)
  --config FILE  model registry (default config/models.json)
  --dry-run      play the REFERENCE SOLVER instead of a model, with no API
                 call and no key. Verifies the harness end to end. It EXITS
                 NON-ZERO if any board detonates, guesses, or cannot be played.
                 A sound, complete solver should score 50/50.

  --i-cannot-control-temperature
                 required to score a model whose config says it cannot run at
                 temperature 0. The result is stamped as not comparable.

  REPRODUCIBILITY (optional, but strongly recommended)

  --seed, -s          fixed RNG seed sent with the request
  --only-provider     pin to one OpenRouter provider
  --no-fallback       refuse to switch provider if the pinned one is down
  --order-provider    a,b,c   try providers in this order

  Examples
    node src/do/run.mjs -m openrouter/dots-3-note-preview:free
    node src/do/run.mjs -m ollama/qwen2.5-coder:7b -r 3
    node src/do/run.mjs --dry-run --per-tier 5
`;

const bar = (rate, width = 20) => {
  const filled = Math.round(rate * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
};
const pct = (r) => `${Math.round(r * 100)}%`;

/**
 * The --dry-run verdict.
 *
 * The bar is SAFETY: every board played, zero detonations, zero unproven moves.
 * Those can only mean a harness or solver-logic fault. A score below 50/50 is
 * reported but does not fail the gate — it means the reference solver ran out
 * of search budget somewhere, which is a limit, not a fault.
 *
 * This exists because the first version of the reference solver returned cells
 * that were merely NOT PROVEN to be mines, detonated on all six boards, and
 * scored 0/50 — while every unit test and the whole self-test passed.
 */
export const dryRunVerdict = (out) => {
  const o = out.score.outcomes;
  const played = Object.values(o).reduce((sum, n) => sum + n, 0);
  const detonations = o.detonation ?? 0;
  const guesses = o.unproven_move ?? 0;
  const unplayed = out.boardResults.filter((r) => r.outcome === "protocol_violation").length;
  const failures = [];
  if (detonations > 0) {
    failures.push(
      `${detonations} board(s) DETONATED. A sound solver must never click a mine — ` +
        `this is a harness or solver-logic fault, not a hard board.`
    );
  }
  if (guesses > 0) {
    failures.push(`${guesses} board(s) ended on an UNPROVEN move. The reference must only return proven cells.`);
  }
  if (unplayed > 0) {
    failures.push(`${unplayed} board(s) could not be played (protocol violation).`);
  }
  if (!out.usable) failures.push(`the reference solver did not compile: ${out.compileError}`);
  return { ok: failures.length === 0, failures, played, detonations, guesses, unplayed, perfect: out.score.total === 50 };
};

export const printDoRun = (model, out) => {
  const s = out.score;
  console.log(`\nMONKEY DO · ${model}`);

  // Said first, and in plain words, because a 0 beside a timeout otherwise
  // reads as a weak model. It is the score of a call that never returned.
  if (out.callFailure) {
    console.log(`\n  NO RESPONSE FROM THE MODEL — the score below is 0 for want of an answer.`);
    console.log(`    reason:   ${out.callFailure.reason}`);
    const budget = out.callFailure.timeoutMs;
    console.log(
      `    elapsed:  ${(out.callFailure.elapsedMs / 1000).toFixed(1)}s` +
        (budget ? ` of a ${(budget / 1000).toFixed(0)}s budget (not retried)` : "")
    );
    console.log(`    message:  ${out.callFailure.message.slice(0, 160)}`);
    console.log(`\n    This is NOT a measurement of the model. Nothing was played: the call failed`);
    console.log(`    before any board, so no board result says anything about reasoning.`);
  } else if (!out.usable) {
    console.log(`\n  unusable response — ${out.compileError}`);
  }

  console.log(`\n  Pool A · solvable      ${s.poolA.total} boards`);
  console.log(`    won                  ${pct(s.poolA.won).padStart(4)}   ${bar(s.poolA.won)}`);
  console.log(`    no confident error   ${pct(s.poolA.noDetonation).padStart(4)}`);
  console.log(`  Pool B · ambiguous     ${s.poolB.total} boards`);
  console.log(`    stopped correctly    ${pct(s.poolB.correctStop).padStart(4)}   ${bar(s.poolB.correctStop)}`);

  console.log(`\n  Pool A by tier (the DO Index is the gap to random play)`);
  for (const [tier, t] of Object.entries(s.perTier)) {
    const base = t.baseline === null ? "no baseline" : `random ${pct(t.baseline)}`;
    console.log(
      `    ${tier.padEnd(14)} won ${pct(t.won).padStart(4)}   ${bar(t.won)}   ` +
        `det ${pct(t.detonation)}  guess ${pct(t.unprovenMove)}  gave up ${pct(t.premature)}  (${base})`
    );
  }
  if (Object.keys(s.poolBPerTier).length) {
    console.log(`  Pool B by tier`);
    for (const [tier, t] of Object.entries(s.poolBPerTier)) {
      console.log(
        `    ${tier.padEnd(14)} stop ${pct(t.correctStop).padStart(4)}   ${bar(t.correctStop)}   ` +
          `det ${pct(t.detonation)}  guess ${pct(t.unprovenMove)}  gave up ${pct(t.premature)}`
      );
    }
  }

  console.log(`\n  POOL A won            ${s.points.poolAWon.toFixed(1)}/30`);
  console.log(`  POOL A no conf. error ${s.points.poolANoDetonation.toFixed(1)}/10`);
  console.log(`  POOL B correct stop   ${s.points.poolBCorrectStop.toFixed(1)}/10`);
  console.log(`\n  ${s.total}/50`);

  const outcomes = Object.entries(s.outcomes).filter(([, n]) => n > 0);
  if (outcomes.length) {
    console.log(`\n  outcomes: ${outcomes.map(([k, n]) => `${k} ${n}`).join("  ")}`);
  }
  if (s.unverifiedMoves > 0) {
    console.log(`  ${s.unverifiedMoves} move(s) could not be verified within the oracle's budget and were given the benefit of the doubt.`);
  }

  // The progress index is printed under the score, never added to it. `inert` is
  // called out in words because a 0/15 next to a 10/50 reads as noise without
  // it: both numbers are explained by a solver that made no move at all.
  const dg = out.progressIndex;
  if (dg) {
    console.log(`\n  \x1b[1mDIAGNOSTIC (not part of the 50)\x1b[0m`);
    console.log(`    initiation ${dg.points.initiation.toFixed(1)}/5   depth ${dg.points.depth.toFixed(1)}/5   breadth ${dg.points.breadth.toFixed(1)}/5`);
    console.log(`    ${dg.total}/${dg.max}`);
    if (dg.inert) {
      console.log(`    made no move on any Pool A board — mean 0 of ${dg.referenceDepth} proven moves`);
    } else {
      console.log(`    mean ${dg.meanCalls} proven moves per Pool A board (oracle ${dg.referenceDepth}); tiers reached: ${dg.activeTiers.join(", ") || "none"}`);
    }
  }

  if (out.dryRun) {
    const v = dryRunVerdict(out);
    console.log(`\n  \x1b[1mDRY RUN VERDICT\x1b[0m`);
    console.log(`    boards played:  ${v.played}`);
    console.log(`    detonations:    ${v.detonations}`);
    console.log(`    unproven moves: ${v.guesses}`);
    if (v.ok) {
      console.log(
        `\n    \x1b[32mPASS\x1b[0m the harness is sound: every board was played and the reference\n` +
          `    solver never clicked a mine or an unproven cell.` +
          (v.perfect
            ? `\n    It scored 50/50: the pool's claims hold end to end through the sandbox.`
            : `\n    It scored ${s.total}/50, not 50: the reference ran out of search budget on some\n` +
              `    positions and surrendered early. A limit, not a fault — but worth a look.`)
      );
    } else {
      console.log(`\n    \x1b[31mFAIL\x1b[0m the harness is broken:`);
      for (const f of v.failures) console.log(`      - ${f}`);
      console.log(`\n    Do not trust any DO score until this passes.`);
    }
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.model && !args.dryRun)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const model = args.dryRun ? "dry-run/reference-solver" : args.model;
  console.log(`\nMONKEY DO · ${model}`);
  await selfTestGate();

  // A dry run needs no model and no key, so it must not ask for either. It
  // exists precisely so the harness can be verified when quota is exhausted.
  //
  // `keySource` is declared HERE, outside the branch. It used to be declared
  // inside the non-dry-run branch and read after it, so every real DO run
  // printed its score and then crashed with "source is not defined" before
  // writing a report.
  let config = null;
  let keySource = "none (dry run)";
  if (!args.dryRun) {
    ({ config, keySource } = await prepareModel(args));
  } else {
    console.log(`\n  \x1b[1mDRY RUN\x1b[0m — the reference solver will play every board.`);
    console.log(`  No model is called and no key is used.`);
  }

  const pool = loadPool({ perTier: args.perTier });
  console.log(
    `\n  board pool: ${pool.boards.length} boards${pool.full ? " (the full published pool)" : ` (first ${args.perTier} per tier per pool; a SUBSET, not comparable with a full run)`}`
  );
  console.log(`  pool sha256 ${pool.sha256}`);
  console.log(args.dryRun ? `\n  playing the reference solver...` : `\n  contacting the model (ONE call)...`);

  const baseline = randomBaseline({ boards: pool.boards, seed: pool.seed });
  const runs = [];
  for (let i = 0; i < args.runs; i++) {
    const out = await runDo(config, {
      boards: pool.boards,
      seed: pool.seed,
      baseline,
      dryRun: args.dryRun,
      onProgress: (n, total) => {
        if (n % 50 === 0) console.log(`  board ${n + 1} of ${total}...`);
      },
    });
    printDoRun(model + (args.runs > 1 ? ` (run ${i + 1}/${args.runs})` : ""), out);
    runs.push(out);
  }

  if (runs.length > 1) {
    const prints = runs.map((r) => r.responseFingerprint);
    const same = new Set(prints).size === 1;
    const totals = runs.map((r) => r.score.total);
    console.log(`\n  REPRODUCIBILITY`);
    console.log(`    ${same ? "REPRODUCIBLE — identical code every run" : "NOT REPRODUCIBLE — different code each run"}`);
    console.log(`    prints: ${prints.join(" ")}   totals: ${totals.join(", ")}`);
    if (!same) {
      console.log(
        `\n  The endpoint returned different code for the same prompt, so these\n` +
          `  scores are separate samples. Compare them with care.`
      );
    }
  }

  const last = runs[runs.length - 1];
  if (config) temperatureNotice(config);
  const report = buildDoReport({
    model,
    result: last,
    config,
    keySource,
    pool,
    baseline,
    reproducibility: runs.length > 1 ? { prints: runs.map((r) => r.responseFingerprint), totals: runs.map((r) => r.score.total) } : null,
  });
  const path = writeDoReport(report, args.out);
  printLimitations(LIMITATIONS);
  console.log(`\n  Saved results to ${path}`);
  console.log(`  Prompt digest (SHA-256): ${last.digest}\n`);

  // A dry run is a gate, not just a report. Exiting 0 after a detonation would
  // make a broken harness look like a passing one.
  if (args.dryRun && !dryRunVerdict(last).ok) process.exit(1);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\n  Something went wrong: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
