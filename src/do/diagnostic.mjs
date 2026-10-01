// MONKEY DO — diagnostic, reported ALONGSIDE the 50-point score and never
// inside it.
//
// Why this exists. The 50 points measure two different things at once: whether a
// solver can clear a board (Pool A won, 30), and whether it stays out of trouble
// (no confident error, 10; Pool B correct stop, 10). A solver that returns null
// on the very first call clears nothing and so scores 0 on the 30 — but it also
// never detonates and never guesses, so it banks the full 10 for "no confident
// error" and lands on 10/50.
//
// That 10 flatters it. Ten points for a solver that did nothing reads like
// partial competence on a report, and every model that gave up immediately
// landed on exactly the same 10/50. The score could not tell a cautious solver
// apart from an inert one, which is the one distinction a reader most needs.
//
// So this is a second, separate axis on the SAME 450 boards and the SAME
// replay — no extra model calls, no extra boards, no new prompt. It grades
// provable PROGRESS, which is what a solver that returns null immediately does
// not have, and which the 50-point score has no room to express.
//
// It is deliberately not part of the 50. The weights are hand-chosen and frozen
// at suite version 0.2.0, and the reference solver's 50/50 is the anchor of the
// publication gate. Changing the split would invalidate every report already
// written and move the oracle's score off its own calibration. This file adds
// information without moving any existing number.
//
// Calibration. REFERENCE_DEPTH is the reference solver's mean proven-move count
// on Pool A, measured by `npm run dry-run`: 74.99, rounded to 75. It is a depth
// scale, not a pass mark — a model that clears boards in a different order can
// legitimately make fewer calls and still be correct, so `depth` saturates at
// the oracle and never requires matching it.

import { POOL_A_TIERS } from "./minesweeper/pool.mjs";

/** The reference solver's mean proven moves per Pool A board. See header. */
export const REFERENCE_DEPTH = 75;

const DIAGNOSTIC_MAX = 15;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Grade a completed DO run on provable progress. Pool A only.
 *
 * Pool B is excluded on purpose. Its boards are unwinnable by design, so a
 * correct solver makes a lot of calls and then stops; measuring progress there
 * would reward depth that Pool A already measures, and a solver that quits
 * immediately would score zero for having correctly quit.
 *
 * @param {object} opts
 * @param {Array} opts.boardResults one entry per board, as scored by scoreDo
 * @param {number} opts.referenceDepth mean proven moves to treat as full depth
 */
export const scoreDiagnostic = ({ boardResults, referenceDepth = REFERENCE_DEPTH } = {}) => {
  const poolA = boardResults.filter((r) => r.pool === "A");
  const calls = poolA.map((r) => r.calls ?? 0);

  // Did it move at all? A solver that returns null on call one scores zero here,
  // which is the whole point: this is where an inert solver separates from a
  // cautious one. Graded on the SHARE of boards rather than the best board, so a
  // solver cannot buy the points with one lucky opening.
  const initiationRate = poolA.length ? poolA.filter((r) => (r.calls ?? 0) >= 1).length / poolA.length : 0;

  // Did the moves chain? One move can be a coincidence of board layout; a chain
  // means each reveal produced the next. Scaled against the oracle and capped,
  // because depth past the oracle's is not more competence, it is a different
  // (possibly luckier) play order.
  const meanCalls = mean(calls);
  const depthRate = referenceDepth > 0 ? Math.min(meanCalls / referenceDepth, 1) : 0;

  // Did it generalise across board sizes, or only learn to look at small
  // boards? Scored per tier so a model that handles poolA-small and nothing else
  // cannot reach full marks. The 50-point score reports the same shape in its
  // per-tier breakdown but does not score it.
  const activeTiers = POOL_A_TIERS.filter((tier) =>
    poolA.some((r) => r.tier === tier && (r.calls ?? 0) >= 1)
  );
  const breadthRate = POOL_A_TIERS.length ? activeTiers.length / POOL_A_TIERS.length : 0;

  const points = {
    initiation: initiationRate * 5,
    depth: depthRate * 5,
    breadth: breadthRate * 5,
  };

  return {
    points,
    total: Math.round(points.initiation + points.depth + points.breadth),
    max: DIAGNOSTIC_MAX,
    initiationRate,
    depthRate,
    breadthRate,
    meanCalls: Number(meanCalls.toFixed(2)),
    maxCalls: calls.length ? Math.max(...calls) : 0,
    activeTiers,
    referenceDepth,
    /**
     * True when the solver never moved. Reported as a flag rather than left to
     * be inferred from three zeroes, because "returned null immediately" and
     * "made one move on one board" deserve to be distinguishable at a glance.
     */
    inert: meanCalls === 0,
  };
};