// MONKEY DO — scoring.
//
// 50 points:
//
//   Pool A  won                   30    board cleared, every move proven
//     split as 10 (Band 2, chained) + 20 (Band 3, wall) — see poolABands
//   Pool A  no confident error    10    never detonated, guessed, or broke
//   Pool B  correct stop          10    played every proven move, then
//                                       returned null where nothing is provable
//
// Pool A is split in two deliberately. A solver that returns null immediately
// never loses a board and learns nothing — so "not losing" alone cannot tell
// caution from competence. The 30/10 split rewards WINNING over not losing.
//
// BANDS (Phase 1 onward). Pool A's 30 points were previously awarded as a flat
// fraction of won-boards. That meant a model that could do the easy half but
// not the hard half got zero, and a model that could do the hard half but not
// the easy half also got zero. The 30 are now split across two bands by the
// oracle-measured difficulty of the board:
//
//   Band 2 (chained)  10 pts  every safe move derivable by Rules 2 + 3, but
//                             never the exhaustive search
//   Band 3 (wall)     20 pts  requires the exact search at some point
//
// Band 1 (easy, Rule 2 alone) was measured empty on all three shapes — the
// pool's openings are large enough that subset elimination is always needed.
// The plan documented this fallback: empty bands contribute zero, the 30
// redistribute across those that have any, with weights chosen so that a
// model that wins only Band 3 still gets 20 of 30 and a model that wins only
// Band 2 still gets 10. See poolABands in the report for the per-band score.
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

import { POOL_A_TIERS, POOL_B_TIERS, capForTier, replayBoard, classifyBoard, sampleClaims, POOL_SEED } from "./minesweeper/pool.mjs";
import { reveal, isWon, makeRng } from "./minesweeper/board.mjs";

/**
 * Band point weights — the 30 Pool A points distributed across the bands that
 * actually contain boards on the published pool (Phase 1 measurement:
 * Band 1 empty, Band 2 = 275, Band 3 = 25).
 *
 * Each band's score is (boards won in band / boards assigned to band) × weight.
 * Weights are hand-chosen so a perfect run still totals 30 and a model that
 * wins only one band gets partial credit on that band alone.
 */
export const POOL_A_BAND_WEIGHTS = { 2: 10, 3: 20 };

/**
 * Pool B's 10 points split: 4 for stop discipline (unchanged from v1) and
 * 6 for the verdict pool (Phase 2). Hand-chosen so the saturated path keeps
 * 6 points sharp, and the abstainer path keeps 4 sound but loses 2 sharp.
 *
 *   verdictSoundPoints   4  every claim assertion is sound (or absent)
 *   verdictSharpPoints   2  every provable claim was asserted in the right
 *                            direction, every mixed claim abstained
 *
 * A model that abstains everywhere (CANNOT_TELL on every claim) loses the
 * 2 sharp points but keeps the 4 sound points — exactly half the verdict
 * pot. A model that asserts PROVEN_TRUE on every provably_mine claim and
 * CANNOT_TELL on every mixed claim is sound AND sharp: 6/6.
 */
export const POOL_B_VERDICT_WEIGHTS = { sound: 4, sharp: 2 };

/** The three strings the model may return for a claim. */
export const VERDICT_VALUES = new Set(["PROVEN_TRUE", "PROVEN_FALSE", "CANNOT_TELL"]);

/**
 * The truth direction a sound answer takes for one claim status:
 *
 *   claim status       PROVEN_TRUE  PROVEN_FALSE  CANNOT_TELL
 *   provably_mine       sound       unsound       sound
 *   provably_safe       unsound     sound         sound
 *   mixed               unsound     unsound       sound
 *   inconclusive        sound       sound         sound
 *
 * Implemented as a status × answer table. The plan's contract: PROVEN_TRUE
 * asserts "this cell is provably a mine"; PROVEN_FALSE asserts "provably
 * safe"; CANNOT_TELL abstains. The plan's fairness note says most decidable
 * claims are provably_mine — and indeed the pool's measurement shows 385 of
 * 450 claims land there, with 0 provably_safe.
 */
const SOUND_TABLE = {
  provably_mine: { PROVEN_TRUE: true, PROVEN_FALSE: false, CANNOT_TELL: true },
  provably_safe: { PROVEN_TRUE: false, PROVEN_FALSE: true, CANNOT_TELL: true },
  mixed: { PROVEN_TRUE: false, PROVEN_FALSE: false, CANNOT_TELL: true },
  inconclusive: { PROVEN_TRUE: true, PROVEN_FALSE: true, CANNOT_TELL: true },
};

/** Per-board verdict scoring. Returns sound (boolean) and sharp (boolean). */
export const scoreBoardVerdict = (claims, answers) => {
  let clean = true;
  let sharp = true;
  for (const claim of claims) {
    const ans = answers[claim.id];
    // A missing answer on a decidable claim is unsound; on a mixed or
    // inconclusive claim it is sharp CANNOT_TELL (no assertion either way).
    if (!VERDICT_VALUES.has(ans)) {
      if (claim.status === "provably_mine" || claim.status === "provably_safe") clean = false;
      sharp = false;
      continue;
    }
    if (!SOUND_TABLE[claim.status][ans]) clean = false;
    if (ans !== "CANNOT_TELL" && claim.status === "mixed") sharp = false;
    if (claim.status === "provably_mine" && ans !== "PROVEN_TRUE") sharp = false;
    if (claim.status === "provably_safe" && ans !== "PROVEN_FALSE") sharp = false;
    if (claim.status === "inconclusive" && ans !== "CANNOT_TELL") sharp = false;
  }
  return { clean, sharp };
};

/**
 * Compute one board's band by replaying it with the oracle in instrumented
 * mode. Pool A boards only; Pool B is intentionally not banded.
 *
 * Cheap (one board replay), but called once per Pool A board per run. For
 * the published pool's 300 Pool A boards, the cumulative cost is a few seconds
 * — acceptable for a measurement pass that also informs scoring.
 */
export const bandOf = ({ tier, attempt, pool }, seed = POOL_SEED) => {
  if (pool !== "A") return null;
  const board = replayBoard(tier, attempt, seed);
  return classifyBoard(board, { instrument: true }).band;
};

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
 * @param {number} opts.seed         the pool seed (default published). Used to
 *                                    compute bands by replaying each Pool A
 *                                    board in instrumented mode. Optional but
 *                                    required to enable poolABands.
 * @param {object} opts.verdictAnswers  board-key → { claimId → "PROVEN_TRUE" |
 *                                    "PROVEN_FALSE" | "CANNOT_TELL" }. Optional.
 *                                    Absent/empty for now (Phase 3 wires the
 *                                    model's `verdict` function); scoring falls
 *                                    back to "no verdict answers" so the run
 *                                    still totals correctly.
 */
export const scoreDo = ({ boardResults, baseline = {}, seed = POOL_SEED, verdictAnswers = {} } = {}) => {
  const poolA = boardResults.filter((r) => r.pool === "A");
  const poolB = boardResults.filter((r) => r.pool === "B");

  // Tag each Pool A board with its band. Two passes over the same board list
  // would double the cost, so we walk once and reuse the lookup for the
  // win-rate and the per-band score below.
  const bandByKey = new Map();
  const bandCounts = {}; // band -> assigned count
  for (const r of poolA) {
    const key = `${r.pool}:${r.tier}#${r.attempt}`;
    let band = bandByKey.get(key);
    if (band === undefined) {
      band = bandOf({ pool: r.pool, tier: r.tier, attempt: r.attempt }, seed);
      bandByKey.set(key, band);
    }
    if (band != null) bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  }

  // Per-band won counts.
  const bandWon = {};
  for (const r of poolA) {
    if (r.outcome !== "won") continue;
    const key = `${r.pool}:${r.tier}#${r.attempt}`;
    const band = bandByKey.get(key);
    if (band == null) continue;
    bandWon[band] = (bandWon[band] ?? 0) + 1;
  }

  // Per-band score: fraction of assigned boards won, weighted.
  // Band 1 is omitted from the report per the amended plan — measured empty
  // on all three shapes, so its contribution is structurally zero and the
  // reader does not need to see "0/0".
  const poolABands = {};
  for (const [band, weight] of Object.entries(POOL_A_BAND_WEIGHTS)) {
    const assigned = bandCounts[band] ?? 0;
    if (assigned === 0) continue; // skip empty bands, per plan
    const won = bandWon[band] ?? 0;
    poolABands[labelForBand(Number(band))] = Number(((won / assigned) * weight).toFixed(2));
  }

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

  // Pool B verdict (Phase 2). Each Pool B board gets 3 sampled claims; the
  // model's answers (when present, Phase 3 wires them) are scored against
  // claim statuses. The weights are 4 sound + 2 sharp out of 6 — a model
  // that abstains everywhere loses 2 sharp but keeps 4 sound. The plan's
  // fairness note says decidable claims are mostly provably_mine; the pool
  // measurement below corroborates this (385 of 450 claims are mine,
  // 0 are safe, 65 mixed on perTier=50 sample).
  let cleanCount = 0;
  let sharpCount = 0;
  const verdictBoardKeys = poolB.length;
  for (const r of poolB) {
    const claims = sampleClaims(r, seed);
    const key = `${r.pool}:${r.tier}#${r.attempt}`;
    const answers = verdictAnswers[key] ?? {};
    const { clean, sharp } = scoreBoardVerdict(claims, answers);
    if (clean) cleanCount++;
    if (sharp) sharpCount++;
  }
  // Denominator: 150 Pool B boards on the full pool. Subsets use the actual
  // board count, so a perTier=10 subset scores 0–4 sound on a fraction of
  // its actual size — meaningful on the subset, comparable on the full pool.
  const verdictDenom = Math.max(verdictBoardKeys, 1);
  const poolBVerdictSound = (cleanCount / verdictDenom) * POOL_B_VERDICT_WEIGHTS.sound;
  const poolBVerdictSharp = (sharpCount / verdictDenom) * POOL_B_VERDICT_WEIGHTS.sharp;

  // Sum the band scores — they replace the flat 30. A perfect run still
  // totals 30 because every band scores its full weight. The math is the
  // same as the old 30 only when the per-band weights sum to 30, which they
  // do by construction.
  const poolAWonPoints = Object.values(poolABands).reduce((a, b) => a + b, 0);

  const points = {
    poolABands,
    poolAWon: poolAWonPoints, // kept as a legacy field, recomputed from bands
    poolANoDetonation: aNoDetonation * 10,
    // Phase 2: Pool B's 10 points split 4 stop + 4 sound + 2 sharp. The old
    // 10-point poolBCorrectStop field stays in the report for one release,
    // recomputed from the same replay, so the transition is checkable rather
    // than a silent change.
    poolBCorrectStop: bCorrectStop * 4,
    poolBVerdictSound,
    poolBVerdictSharp,
    poolBTotal: bCorrectStop * 4 + poolBVerdictSound + poolBVerdictSharp,
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
    total: Math.round(points.poolAWon + points.poolANoDetonation + points.poolBCorrectStop + points.poolBVerdictSound + points.poolBVerdictSharp),
    max: 50,
    poolA: { total: poolA.length, won: aWon, noDetonation: aNoDetonation },
    poolB: { total: poolB.length, correctStop: bCorrectStop },
    poolBVerdict: { cleanBoards: cleanCount, sharpBoards: sharpCount, total: verdictBoardKeys },
    poolABandCounts: bandCounts, // { 2: 5, 3: 1 } — internal, useful for the self-test
    poolABandWeights: POOL_A_BAND_WEIGHTS,
    poolBVerdictWeights: POOL_B_VERDICT_WEIGHTS,
    perTier,
    poolBPerTier,
    index,
    outcomes: tally(boardResults),
    unverifiedMoves: boardResults.reduce((n, r) => n + (r.unverifiedMoves ?? 0), 0),
  };
};

const labelForBand = (n) => (n === 2 ? "chained" : n === 3 ? "wall" : `band${n}`);

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
