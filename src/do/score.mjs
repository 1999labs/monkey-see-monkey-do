// MONKEY DO — scoring.
//
// 50 points:
//
//   Pool A  won                   30    board cleared, every move proven
//   Pool A  no confident error    10    never detonated, guessed, or broke
//   Pool B  correct stop          10    played every proven move, then
//                                       returned null where nothing is provable
//
// Pool A is split in two deliberately. A solver that returns null immediately
// never loses a board and learns nothing — so "not losing" alone cannot tell
// caution from competence. The 30/10 split rewards WINNING over not losing.
//
// POOL B WAS UNWINNABLE BY DESIGN, and is now scored on what the prompt asks.
// Every Pool B board reaches a position where no cell can be proven safe. The
// prompt says "If no cell can be proven safe, return null. Do not guess." The
// first version scored Pool B on WINNING, which only a guess can do — so a model
// that obeyed the prompt perfectly scored 0/10 there, and 40/50 was the true
// ceiling. A dry run showed it: 60/60 Pool A boards won, 0/60 Pool B.
//
// Pool B now measures the other half of calibration: knowing when to stop. A
// pass requires deducing all the way to the stuck position (surrendering early
// is premature) and then declining to guess (guessing is an unproven move, and
// a mine is a detonation). Because the set of cells reachable by pure deduction
// does not depend on the order they are revealed in, every correct solver
// reaches the same stuck position, so the pass condition is well defined.
//
// No robustness bonus here, unlike SEE. A model that throws on every board is
// already scoring 0, and a bonus for not throwing would reward a solver that
// does nothing. protocol_violation is still reported, because it is
// diagnostically useful even when it is not scored.

import { POOL_A_TIERS, POOL_B_TIERS, capForTier, replayBoard, POOL_SEED } from "./minesweeper/pool.mjs";
import { reveal, isWon, makeRng } from "./minesweeper/board.mjs";

/**
 * Outcomes that forfeit Pool A's 10 no-detonation points.
 *
 * `unproven_move` is here because it is the same act as a detonation — claiming
 * certainty the position did not support — with only the dice differing. Pool
 * A's promise is "zero luck", and scoring a lucky guess better than an unlucky
 * one would put luck straight back in. `protocol_violation` is here because a
 * broken solver is not a cautious one.
 */
// `no_response` is here for a different reason than the other three, and the
// difference matters: a no-response board was never played, so it cannot earn
// the "no confident error" points either. Without it, a model whose call timed
// out would score 10/10 for the detector it never got to run, which is a
// reward for failing. Its real score is 0 and the report says why.
export const CONFIDENT_ERRORS = new Set([
  "detonation",
  "unproven_move",
  "protocol_violation",
  "no_response",
]);

const share = (rows, pred) => (rows.length ? rows.filter(pred).length / rows.length : 0);
const is = (outcome) => (r) => r.outcome === outcome;

/** Outcome rates for one group of boards. */
const breakdown = (rows) => ({
  total: rows.length,
  won: share(rows, is("won")),
  correctStop: share(rows, is("surrender")),
  detonation: share(rows, is("detonation")),
  unprovenMove: share(rows, is("unproven_move")),
  surrender: share(rows, (r) => r.outcome === "surrender" || r.outcome === "premature_surrender"),
  premature: share(rows, is("premature_surrender")),
  protocolViolation: share(rows, is("protocol_violation")),
  stalled: share(rows, is("stalled")),
  noResponse: share(rows, is("no_response")),
});

/**
 * Score a completed DO run.
 *
 * @param {object} opts
 * @param {Array} opts.boardResults  one entry per board: { pool, tier, outcome, calls }
 * @param {object} opts.baseline     tier -> random survival rate on Pool A
 */
export const scoreDo = ({ boardResults, baseline = {} }) => {
  const poolA = boardResults.filter((r) => r.pool === "A");
  const poolB = boardResults.filter((r) => r.pool === "B");

  const aWon = share(poolA, is("won"));
  const aNoDetonation = share(poolA, (r) => !CONFIDENT_ERRORS.has(r.outcome));
  const bCorrectStop = share(poolB, is("surrender"));

  // Per tier, SEPARATELY per pool. Both pools use the same tier names, and the
  // first version grouped by tier alone — mixing boards a model can win with
  // boards nobody can win, so a perfect solver showed "won 50%" on every tier
  // and the tier gradient (the DO Index) was meaningless.
  const perTier = {};
  for (const tier of POOL_A_TIERS) {
    const rows = poolA.filter((r) => r.tier === tier);
    if (!rows.length) continue;
    perTier[tier] = { ...breakdown(rows), baseline: baseline[tier] ?? null };
  }
  const poolBPerTier = {};
  for (const tier of POOL_B_TIERS) {
    const rows = poolB.filter((r) => r.tier === tier);
    if (rows.length) poolBPerTier[tier] = breakdown(rows);
  }

  const points = {
    poolAWon: aWon * 30,
    poolANoDetonation: aNoDetonation * 10,
    poolBCorrectStop: bCorrectStop * 10,
  };

  // The DO Generalization Index: Pool A win rate above random play, per tier. Reported,
  // not scored, because pooling it would hide a model that only handles small
  // boards.
  const index = {};
  for (const [tier, t] of Object.entries(perTier)) {
    if (t.baseline === null) continue;
    index[tier] = Number((t.won - t.baseline).toFixed(4));
  }

  return {
    points,
    total: Math.round(points.poolAWon + points.poolANoDetonation + points.poolBCorrectStop),
    max: 50,
    poolA: { total: poolA.length, won: aWon, noDetonation: aNoDetonation },
    poolB: { total: poolB.length, correctStop: bCorrectStop },
    perTier,
    poolBPerTier,
    index,
    outcomes: tally(boardResults),
    unverifiedMoves: boardResults.reduce((n, r) => n + (r.unverifiedMoves ?? 0), 0),
  };
};

/** A count of every outcome, including the ones that are not scored. */
export const tally = (rows) => {
  const out = {};
  for (const r of rows) out[r.outcome] = (out[r.outcome] ?? 0) + 1;
  return out;
};

/**
 * Random-legal-move survival, the DO equivalent of SEE's naive baseline.
 *
 * Computed by simulation rather than hardcoded, so it cannot drift from the
 * board shapes it describes. Deterministic given the seed. Pool A boards only:
 * the index it anchors is a Pool A win rate, and a random player never stops,
 * so it cannot pass Pool B by construction.
 *
 * @param {object} opts
 * @param {Array<{tier: string, attempt: number, pool?: string}>} opts.boards
 * @param {number} opts.runs  how many random playthroughs per board
 * @param {number} opts.seed  the POOL's seed, so each board is the scored board
 */
export const randomBaseline = ({ boards, runs = 40, seed = POOL_SEED } = {}) => {
  const totals = {};
  for (const b of boards) {
    if (b.pool !== undefined && b.pool !== "A") continue;
    (totals[b.tier] ??= []).push(randomSurvivalRate(b, runs, seed));
  }
  const out = {};
  for (const [tier, list] of Object.entries(totals)) {
    out[tier] = Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(4));
  }
  return out;
};

/**
 * One board's random survival rate: play it with uniform random legal moves.
 *
 * Every run replays THE SCORED BOARD — same mines, same opening — and only the
 * random player's moves vary. The first version shifted the board seed on every
 * run, so the baseline was measured on 40 different boards per entry rather
 * than on the pool it claims to describe.
 *
 * The move stream is seeded from (seed, attempt, run). An even earlier version
 * derived picks from the loop counters, which walked the same path relative to
 * each layout and detonated on the first move essentially every time.
 */
const randomSurvivalRate = ({ tier, attempt }, runs, seed) => {
  let survived = 0;
  const limit = capForTier(tier);
  for (let r = 0; r < runs; r++) {
    const board = replayBoard(tier, attempt, seed);
    const rng = makeRng((seed ^ Math.imul(attempt, 0x9e3779b1) ^ Math.imul(r + 1, 0x85ebca6b)) >>> 0);
    let calls = 0;
    while (calls < limit) {
      if (isWon(board)) break;
      const hidden = [];
      for (let rr = 0; rr < board.rows; rr++) {
        for (let cc = 0; cc < board.cols; cc++) if (!board.revealed[rr][cc]) hidden.push([rr, cc]);
      }
      if (!hidden.length) break;
      const pick = hidden[Math.floor(rng() * hidden.length)];
      if (board.mines[pick[0]][pick[1]]) break; // detonated
      reveal(board, pick[0], pick[1]);
      calls++;
    }
    if (isWon(board)) survived++;
  }
  return survived / runs;
};
