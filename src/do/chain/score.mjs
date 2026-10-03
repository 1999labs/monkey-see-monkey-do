// MONKEY DO v2 — scoring.
//
// 50 points, one band per length:
//
//   L5  10 points  (10 chains)
//   L10 10 points  (10 chains)
//   L20 10 points  (10 chains)
//   L30 10 points  (10 chains)
//   L50 10 points  (10 chains)
//
// PER-CHAIN SCORING (Phase 2):
//   chain_score = (correctSteps / expectedSteps)  clamped at [0, 1]
//   "correct" means: the rule was applicable at the recorded start position
//   AND applying it produced the recorded `next` state.
//
//   PLUS a completion bonus: chain_score += 0.05 if the final state equals
//   the chain's target. This is small because Phase 2 only scores the
//   reference solver, which always reaches the target; the bonus is here
//   so Phase 3's generalised scorer (any valid derivation, not just the
//   reference's) keeps the "reach the target" signal in the score.
//
// BAND SCORE = mean(chain scores across the 10 chains in the band) × 10.
//   A perfect run is 10 per band × 5 bands = 50.
//
//   The mean is unweighted: every chain contributes equally, so the bands
//   grade difficulty by "what fraction of chains you got right", not by
//   some length-derived weight. This is the same shape SEE uses for its
//   held-out sets.
//
// Phase 2 scope: the reference solver is the only "model" we test against.
// The scorer is written so Phase 3 can drop in the model's solver without
// changes — only the function that produces the steps differs.

import { verifyDerivation } from "./reference.mjs";
import { POOL_BANDS } from "./generator.mjs";

/** The completion bonus per chain when the final state matches the target. */
export const COMPLETION_BONUS = 0.05;

/**
 * Score one chain's submitted derivation against the recorded (start, target).
 *
 * @param {object} chain     { start, target, length, steps (the recorded reference) }
 * @param {Array}  submitted [{rule, start, next}, ...]
 * @returns {{ correctSteps, expectedSteps, reachedTarget, chainScore, band }}
 */
export const scoreChain = (chain, submitted) => {
  const expected = chain.length;
  const v = verifyDerivation(chain.start, chain.target, submitted);
  const correctSteps = v.correctSteps;
  const reachedTarget = v.reachedTarget;
  const base = expected > 0 ? correctSteps / expected : 0;
  const chainScore = Math.min(1, base + (reachedTarget ? COMPLETION_BONUS : 0));
  return {
    correctSteps,
    expectedSteps: expected,
    reachedTarget,
    chainScore: Number(chainScore.toFixed(4)),
    band: chain.band,
  };
};

/**
 * Score a whole run. `submittedPerChain` maps chainId -> [{rule,start,next}]
 * (chainId is the band+attempt tuple, formatted by `chainIdOf` below).
 *
 * @param {object} opts
 * @param {Array}  opts.chains       the pool's chain list (from loadPublishedPool)
 * @param {object} opts.submittedPerChain  chainId -> derivation
 *
 * @returns {{
 *   total: number, max: 50,
 *   perBand: Record<string, { score, points, max, chains }>,
 *   perChain: Array<{ id, band, correctSteps, expectedSteps, reachedTarget, chainScore }>
 * }}
 */
export const scoreRun = ({ chains, submittedPerChain = {} }) => {
  const perBand = Object.fromEntries(POOL_BANDS.map((b) => [b.name, { score: 0, points: 0, max: 10, chains: [] }]));
  const perChain = [];
  for (const c of chains) {
    const id = chainIdOf(c);
    const submitted = submittedPerChain[id] ?? [];
    const result = scoreChain(c, submitted);
    result.id = id;
    perChain.push(result);
    perBand[c.band].chains.push(result);
  }

  // Mean per band, scaled to the band's 10-point weight.
  for (const band of POOL_BANDS) {
    const b = perBand[band.name];
    const n = b.chains.length;
    const mean = n ? b.chains.reduce((s, x) => s + x.chainScore, 0) / n : 0;
    b.score = Number(mean.toFixed(4));
    b.points = Number((mean * band.count).toFixed(2)); // max equals the band weight (10 here)
  }

  const total = Number(Object.values(perBand).reduce((s, b) => s + b.points, 0).toFixed(2));
  return { total, max: 50, perBand, perChain };
};

/** Stable id for a chain: `<band>#<attempt>`. */
export const chainIdOf = (chain) => `${chain.band}#${chain.attempt}`;