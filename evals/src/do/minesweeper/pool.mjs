// MONKEY DO — the board pool.
//
// Pool A and Pool B are not two lists of random boards. They are the same list,
// partitioned by a question that only the oracle can answer: played to
// completion by a correct solver, does a certain-safe move EXIST at every step?
//
//   Pool A  yes at every step  -> pure deduction, zero luck, worth 40 points
//   Pool B  no at some step   -> a coin flip is unavoidable; worth 10 points
//                                to a model that STOPS there instead of guessing
//
// Everything else is discarded. A board the oracle cannot classify — because
// its search ran out of budget — belongs in NEITHER pool. Filing those into
// Pool B would quietly pad the "ambiguous" set with positions a stronger solver
// would have solved, and Pool B's whole claim is that guessing is *required*.
//
// REPRODUCIBILITY IS THE POINT. The pool is regenerated from seed 0x5EED and
// must be byte-identical on every machine, so that anyone can check a
// submitted score against the boards it was scored on. Three things follow:
// no Math.random, no Date, and no dependence on iteration order. The only
// entropy is the seeded PRNG, and the only oracle is the deterministic one.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { makeRng, newBoard, openBoard, reveal, isWon, layoutDigest, TIERS } from "./board.mjs";
import { analyse, DEFAULT_BUDGET } from "./oracle.mjs";

/** The published seed. Changing it invalidates every score ever reported. */
export const POOL_SEED = 0x5eed;

/**
 * Bump this whenever a change alters WHICH boards land in which pool without
 * touching any constant recorded in generatorFingerprint() — in practice, any
 * change to the oracle's reasoning or to classifyBoard.
 *
 *   1  original generator
 *   2  oracle tries an unconstrained representative (global-count endgames are
 *      deducible, so some former Pool B boards are now Pool A), and a search
 *      that runs out of budget on its last candidate is inconclusive rather
 *      than ambiguous
 *
 * The published pool.json records the version it was built with, and loading a
 * pool built by a different version fails loudly.
 */
export const GENERATOR_VERSION = 2;

/**
 * The three non-standard shapes, used by BOTH pools.
 *
 * The design originally gave Pool B the three classic tiers — beginner 9x9,
 * intermediate 16x16, expert 16x30 — on the reasoning that Pool B would mirror
 * the classic game. Measurement killed that idea:
 *
 *   Pool B acceptance, 3 boards per tier:
 *     beginner        50 attempts
 *     intermediate    28 attempts
 *     expert          did not finish
 *
 * Two problems, both real. Most candidates were being REJECTED as wrong-pool
 * (i.e. they were winnable), so the search was grinding through 200,000
 * candidates. And on `expert` — 480 cells — a genuine endgame ambiguity is rare
 * enough that the quota may never be reached, which meant a run could hang
 * indefinitely with no error.
 *
 * The pools are distinguished by their CONDITION, not their shape: Pool A is
 * won by pure deduction, Pool B requires a guess. Nothing about that distinction
 * needs classic board sizes, and using the same shapes for both removes the
 * hang and keeps the tier gradient comparable across pools — a model that does
 * better on Pool B's small boards than its large ones is now making a claim
 * that can be compared against Pool A on the same shapes.
 */
export const POOL_TIERS = ["poolA-small", "poolA-medium", "poolA-large"];
export const POOL_A_TIERS = POOL_TIERS;
export const POOL_B_TIERS = POOL_TIERS;

/**
 * The effort cap, derived from board size rather than fixed.
 *
 * This constant has been wrong twice, and both times because it was fitted to
 * one tier and assumed to generalise. The history is worth keeping, because
 * the failure mode is not obvious from the code.
 *
 *   v1  a hardcoded 24, chosen for a 9x9 beginner board. On poolA-small, 256 of
 *       300 boards hit the cap. It looked like a property of Minesweeper — "a
 *       correct solver does not win most boards" — and it was not.
 *
 *   v2  CELLS_PER_CALL = 4, fitted to poolA-small's median of 32 calls. That
 *       fixed the small tier (9% -> 68% won) and quietly broke the other two:
 *       poolA-medium dropped to 2/10 won with 13 of 20 boards capping out.
 *
 *   v3  (this one) fitted across all three tiers at once, against an UNBOUNDED
 *       cap so the true call counts could be measured rather than inferred.
 *       Results, 20 boards per tier:
 *
 *         tier           safe cells   median   p95    max   implied cells/call
 *         poolA-small        125         33     52     52        3.79
 *         poolA-medium       203         74     96     96        2.74
 *         poolA-large        375        105    135    135        3.57
 *
 *       The medium tier needs 2.74 cells per call, the tightest of the three, so
 *       the divisor is set to 2 — a round number below the WORST measured tier,
 *       not the median of one. Headroom of 12 covers the p95-to-median spread
 *       (52 vs 33 on the small tier) without being so loose that a genuinely
 *       stuck board runs forever.
 *
 * With the cap removed entirely, every tier wins the large majority of boards
 * (18/20, 15/20, 7/8). The boards were always solvable; the cap was rejecting
 * them.
 *
 * The pool uses this to decide whether a board is winnable; the model-facing
 * harness must use the SAME value for a tier, or Pool A would
 * contain boards the oracle can win but the model is not allowed to finish.
 */
export const MIN_CALLS = 24;
export const CELLS_PER_CALL = 2;
export const CALL_HEADROOM = 12;

/** The cap for one board, given its dimensions and mine count. */
export const callsFor = (rows, cols, mines) => {
  const safeCells = rows * cols - mines;
  return Math.max(MIN_CALLS, Math.ceil(safeCells / CELLS_PER_CALL) + CALL_HEADROOM);
};

/**
 * The cap for a named tier — the form the model-facing harness must use.
 *
 * This exists so do/run.mjs cannot drift from the pool. If the harness computed
 * its own cap, a future change to CELLS_PER_CALL would silently produce pools
 * containing boards the oracle can win but the model is never allowed to finish.
 * That is not a scoring nuisance, it is a Pool A board quietly measuring the
 * cap instead of reasoning.
 *
 * @param {string} tier a key of TIERS
 * @returns {number} the maximum calls permitted on that tier
 */
export const capForTier = (tier) => {
  const spec = TIERS[tier];
  if (!spec) throw new Error(`unknown tier "${tier}"`);
  return callsFor(spec.rows, spec.cols, spec.mines);
};

/**
 * How many cells are still hidden, as a fraction of the board.
 *
 * Used to tell a genuine endgame ambiguity (a few cells left, a real coin flip)
 * apart from a solver that simply gave up with most of the board intact (a hard
 * board, not an ambiguous one). Only the former belongs in Pool B.
 */
const hiddenFraction = (board) => {
  let hidden = 0;
  for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) if (!board.revealed[r][c]) hidden++;
  return hidden / (board.rows * board.cols);
};

/**
 * Above this hidden fraction, an ambiguous position is treated as "hard", not
 * "ambiguous", and the board is rejected rather than filed into Pool B.
 *
 * Measured on poolA-small: genuine endgames stalled with 19-26 of 143 cells
 * left (13-18% hidden), while hard stalls left 101-132 (71-92%). A 40% split
 * sits in the empty gap between the two groups, so the exact value is not
 * delicate — but it IS a judgement call, and it is recorded here so a reader can
 * disagree with it explicitly rather than discovering it in a score.
 */
export const ENDGAME_HIDDEN_FRACTION = 0.4;

/**
 * Play one board to completion with the oracle, and classify it.
 *
 * @returns {{
 *   pool: "A"|"B"|null, won: boolean, calls: number,
 *   initialRevealed: number, stalledAt: number|null,
 *   isEndgame: boolean, hiddenAtStall: number|null
 * }}
 *   pool === null means "unclassifiable" — the oracle ran out of budget, or the
 *   board was already won before any move. Such a board is not used.
 */
export const classifyBoard = (board, { maxCalls, budget } = {}) => {
  // Default to the size-derived cap. An explicit maxCalls overrides it, which
  // tests use to exercise the capped path deliberately.
  const limit = maxCalls ?? callsFor(board.rows, board.cols, board.totalMines);
  let calls = 0;
  let initialRevealed = 0;
  for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) if (board.revealed[r][c]) initialRevealed++;

  while (calls < limit) {
    if (isWon(board)) {
      return { pool: "A", won: true, calls, initialRevealed, stalledAt: null, isEndgame: true, hiddenAtStall: 0 };
    }

    const verdict = analyse(board.visible, board.rows, board.cols, board.totalMines, budget ? { budget } : {});
    if (!verdict.conclusive) {
      return { pool: null, won: false, calls, initialRevealed, stalledAt: calls, isEndgame: false, hiddenAtStall: null };
    }
    if (verdict.deducible) {
      // The oracle is ground truth; it cannot return a mine. This guard exists so
      // that a future change to the oracle surfaces as a loud pool-generation
      // failure rather than as a silently corrupt board.
      if (board.mines[verdict.move.row][verdict.move.col]) {
        throw new Error("oracle returned a mine — refusing to classify a board it cannot reason about");
      }
      reveal(board, verdict.move.row, verdict.move.col);
      calls++;
      continue;
    }
    // Ambiguous with the search finished: a guess may be required. Whether this
    // is a real coin flip or just a hard board is decided by how much is left.
    const hidden = hiddenFraction(board);
    return {
      pool: "B",
      won: false,
      calls,
      initialRevealed,
      stalledAt: calls,
      isEndgame: hidden <= ENDGAME_HIDDEN_FRACTION,
      hiddenAtStall: Number(hidden.toFixed(4)),
    };
  }
  // Ran out of calls without finishing. The oracle should not need this many on
  // a board it can win, so this is a hard board rather than a solvable one.
  return {
    pool: null,
    won: false,
    calls,
    initialRevealed,
    stalledAt: calls,
    isEndgame: false,
    hiddenAtStall: null,
    capped: true,
    callLimit: limit,
  };
};

/**
 * Rebuild a candidate board exactly as generation did.
 *
 * A Pool A board is really a PAIR: the mine layout AND the opening reveal. Two
 * boards with identical mines but different openings are different puzzles — the
 * opening decides which cells the solver can see, and therefore whether a given
 * step is deducible. Storing only `mines` would make a stored board impossible
 * to replay, and an unverifiable pool is not a published pool.
 *
 * So the pool stores the attempt index, and this function regenerates the exact
 * board from (seed, tier, attempt). The test suite uses it to prove that every
 * stored board still classifies the way it did at generation time — which is
 * the property that actually matters.
 */
export const replayBoard = (tier, attempt, seed = POOL_SEED, boardSeed = seed) => {
  const rng = makeRng(boardSeed ^ (attempt * 0x9e3779b1));
  const board = newBoard(tier, rng);
  openBoard(board, makeRng(boardSeed ^ (attempt * 0x85ebca6b)));
  return board;
};

/**
 * Generate the pool by rejection sampling.
 *
 * MEASURED REALITY, which the original design got wrong twice.
 *
 * First measurement, with a fixed cap of 24 calls: only 9% of boards were won,
 * and 85% hit the cap. That looked like a property of Minesweeper — "a correct
 * solver does not win most boards" — and it was not. The cap was simply too
 * small for the board sizes Pool A uses, and it was truncating the oracle on
 * boards it could otherwise solve.
 *
 * After deriving the cap from board size, the same 200 boards:
 *
 *   136  won outright            68%
 *    45  hit the (new, larger) cap
 *    11  ambiguous at an endgame -> Pool B
 *     8  ambiguous but most of the board still hidden -> rejected as "hard"
 *
 * Median calls on a won board is 32, comfortably under the derived cap of 44
 * for this tier. The remaining 23% that still cap out are NOT yet explained;
 * so treat per-tier acceptance rates as provisional until that is explained.
 *
 * The two ambiguity groups are kept apart deliberately:
 *
 *   endgame, few cells left   a real coin flip. A guess is required. Pool B.
 *   most of the board hidden  a hard board, not an ambiguous one. Rejected,
 *                             because Pool B claims guessing is REQUIRED and
 *                             a wall is not a coin flip.
 *
 * @param {object} opts
 * @param {number} opts.seed
 * @param {Record<string, number>} opts.count   tier -> how many boards wanted
 * @param {'A'|'B'} opts.want                   which pool to fill
 * @param {number} opts.maxAttempts             safety valve per tier
 */
export const generatePool = ({ seed = POOL_SEED, count, want = "A", maxAttempts = 200000, ...opts } = {}) => {
  const out = {};
  for (const [tier, target] of Object.entries(count)) {
    const accepted = [];
    let attempts = 0;
    // Rejection reasons, reported so a suspiciously low acceptance rate is
    // visible rather than silent.
    let rejectedWrongPool = 0;
    let rejectedUnclassifiable = 0;
    let rejectedHardStall = 0;

    while (accepted.length < target) {
      if (++attempts > maxAttempts) {
        throw new Error(
          `tier ${tier}: only accepted ${accepted.length} of ${target} after ${maxAttempts} attempts`
        );
      }
      // replayBoard keeps construction in ONE place. Inlining the RNG calls
      // here instead would risk the two drifting apart, and a drift would mean
      // stored boards could no longer be regenerated — silently, and only on
      // the boards where it happened.
      const board = replayBoard(tier, attempts, seed);

      const result = classifyBoard(board, opts);
      if (result.pool === null) {
        rejectedUnclassifiable++;
        continue;
      }
      if (result.pool !== want) {
        rejectedWrongPool++;
        continue;
      }
      if (want === "B" && !result.isEndgame) {
        // Ambiguous, but with most of the board still hidden. That is a hard
        // board, not a coin flip, and Pool B claims a guess is REQUIRED.
        rejectedHardStall++;
        continue;
      }
      accepted.push({
        tier,
        // The attempt index is the board's real identity. Everything else here
        // is derived from it, so storing it is what makes the pool replayable —
        // see replayBoard.
        attempt: attempts,
        mines: board.mines,
        totalMines: board.totalMines,
        calls: result.calls,
        // Recorded so the report can explain a board rather than just score it.
        initialRevealed: result.initialRevealed,
        stalledAt: result.stalledAt,
      });
    }
    out[tier] = {
      boards: accepted,
      stats: { attempts, rejectedWrongPool, rejectedUnclassifiable, rejectedHardStall },
    };
  }
  return out;
};

/**
 * A stable digest of the whole pool, recorded in every report so a score can be
 * tied to the exact boards it was scored on.
 *
 * The attempt index is included deliberately. Two pools can hold identical mine
 * layouts and still be different pools, if the openings differ — and a changed
 * opening changes which positions are deducible, which changes every score. A
 * digest over mines alone would report those as identical.
 */
export const poolDigest = (pool) => {
  const parts = [];
  for (const tier of Object.keys(pool).sort()) {
    for (const b of pool[tier].boards) {
      const rows = TIERS[tier].rows;
      const cols = TIERS[tier].cols;
      parts.push(`${tier}#${b.attempt}:${rows}x${cols}:${layoutDigest({ mines: b.mines, rows, cols })}`);
    }
  }
  return parts.join("\n");
};

// --- The published pool ---------------------------------------------------
//
// Generating the full pool takes minutes (Pool B acceptance is 10-20%), so it
// is generated ONCE by scripts/gen-pool.mjs and stored as pool.json. That
// reverses an earlier decision to regenerate on every run, which was sound at
// 20 boards per tier and unworkable at a size that resolves scores: 120 boards
// took over three minutes per run.
//
// Drift, the reason regeneration was preferred, is handled by verification
// instead of by avoidance:
//
//   every load       the generator fingerprint must match this code, every board
//                    must replay to its recorded layout hash, and the list must
//                    hash to the recorded digest
//   self-test        a sample of boards is re-classified by the oracle
//   gen-pool --check the whole pool is regenerated and compared byte for byte
//                    (success criterion 4)

/** Boards per tier in the published pool. 3 tiers x (100 + 50) = 450 boards. */
export const PUBLISHED_PER_TIER = { A: 100, B: 50 };

/** Where the published pool lives. */
export const POOL_FILE = fileURLToPath(new URL("./pool.json", import.meta.url));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Everything that decides which boards a seed produces, apart from the code
 * itself. A pool whose fingerprint differs from the running code's was built by
 * a different generator and cannot be trusted to mean what this code thinks.
 */
export const generatorFingerprint = (seed = POOL_SEED) => ({
  version: GENERATOR_VERSION,
  seed,
  tiers: Object.fromEntries(POOL_TIERS.map((t) => [t, { ...TIERS[t] }])),
  minCalls: MIN_CALLS,
  cellsPerCall: CELLS_PER_CALL,
  callHeadroom: CALL_HEADROOM,
  endgameHiddenFraction: ENDGAME_HIDDEN_FRACTION,
  oracleBudget: DEFAULT_BUDGET,
});

/** A short, stable hash of one board's hidden layout. */
export const layoutHash = (board) => sha256(layoutDigest(board)).slice(0, 16);

/**
 * SHA-256 over a flat board list: pool, tier, attempt and layout of every board.
 *
 * This replaces hashing `{ ...poolA, ...poolB }`, which was wrong: both pools
 * use the same tier names, so the spread let Pool B's entries overwrite Pool
 * A's, and the recorded digest silently covered Pool B alone.
 */
export const boardListSha256 = (boards) =>
  sha256(boards.map((b) => `${b.pool}:${b.tier}#${b.attempt}:${b.layout}`).join("\n"));

/**
 * Build the published pool in memory. Deterministic: the same seed and counts
 * always produce the same object, and serializePool the same bytes.
 */
export const buildPublishedPool = ({ seed = POOL_SEED, perTier = PUBLISHED_PER_TIER, onProgress } = {}) => {
  const boards = [];
  const stats = {};
  for (const pool of ["A", "B"]) {
    stats[pool] = {};
    for (const tier of POOL_TIERS) {
      onProgress?.(`Pool ${pool} · ${tier} · ${perTier[pool]} boards`);
      const out = generatePool({ seed, count: { [tier]: perTier[pool] }, want: pool })[tier];
      stats[pool][tier] = out.stats;
      for (const b of out.boards) {
        boards.push({
          pool,
          tier,
          attempt: b.attempt,
          layout: layoutHash({ mines: b.mines }),
          // The oracle's own call count: to win (A) or to reach the stuck
          // position (B). Recorded so a report can explain a board, not scored.
          calls: b.calls,
        });
      }
    }
  }
  return {
    schema: "monkey-do/pool@1",
    generator: generatorFingerprint(seed),
    perTier,
    sha256: boardListSha256(boards),
    stats,
    boards,
  };
};

/**
 * Serialize with one board per line, so a regenerated pool diffs readably and
 * `gen-pool --check` can point at the first board that changed.
 */
export const serializePool = (pool) => {
  const { boards, ...head } = pool;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const lines = boards.map((b) => `    ${JSON.stringify(b)}`);
  return `${top},\n  "boards": [\n${lines.join(",\n")}\n  ]\n}\n`;
};

/**
 * Load, verify and optionally subset the published pool.
 *
 * `perTier` takes the first N boards of every (pool, tier) — a deterministic
 * prefix, useful for a quick run. A subset is marked `full: false` and gets its
 * own digest, because its score is not comparable with a full-pool score.
 *
 * Throws, with the command that fixes it, if the file is missing, was built by a
 * different generator, or any board no longer replays to its recorded layout.
 */
export const loadPublishedPool = ({ path = POOL_FILE, perTier = null } = {}) => {
  if (!existsSync(path)) {
    throw new Error(`no board pool at ${path}. Generate it with:  npm run gen-pool`);
  }
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (file.schema !== "monkey-do/pool@1") throw new Error(`${path}: unknown pool schema "${file.schema}"`);

  const expected = generatorFingerprint(file.generator?.seed);
  const mismatched = Object.keys(expected).filter(
    (k) => JSON.stringify(expected[k]) !== JSON.stringify(file.generator?.[k])
  );
  if (mismatched.length) {
    throw new Error(
      `${path} was built by a different generator (${mismatched.join(", ")} differ from this code). ` +
        `Its boards may not mean what this code assumes. Regenerate it with:  npm run gen-pool`
    );
  }

  const seed = file.generator.seed;
  for (const b of file.boards) {
    const replayed = layoutHash(replayBoard(b.tier, b.attempt, seed));
    if (replayed !== b.layout) {
      throw new Error(
        `${path}: Pool ${b.pool} ${b.tier} attempt ${b.attempt} no longer replays to its recorded layout. ` +
          `Board generation has changed; regenerate with:  npm run gen-pool`
      );
    }
  }
  if (boardListSha256(file.boards) !== file.sha256) {
    throw new Error(`${path}: the board list does not match its recorded digest. The file has been edited by hand.`);
  }

  let boards = file.boards;
  const full = perTier == null || (perTier >= file.perTier.A && perTier >= file.perTier.B);
  if (!full) {
    const taken = {};
    boards = file.boards.filter((b) => {
      const k = `${b.pool}:${b.tier}`;
      taken[k] = (taken[k] ?? 0) + 1;
      return taken[k] <= perTier;
    });
  }
  return {
    boards,
    seed,
    full,
    sha256: boardListSha256(boards),
    publishedSha256: file.sha256,
    generator: file.generator,
  };
};
