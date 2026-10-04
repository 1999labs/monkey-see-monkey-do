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
// PER-CHAIN SCORING (Phase 3, generalised for any valid derivation):
//   The scorer accepts ANY derivation the model returns, regardless of how
//   many steps it took. The contract:
//     - every step is rule-applicable at its recorded start position, AND
//     - applying the rule produces the recorded `next` state, AND
//     - the final state after all steps equals the chain's target.
//
//   If ALL three hold: chain_score = 1.0 (full credit for that chain).
//   Otherwise: chain_score = (correctSteps / submittedSteps), where
//   correctSteps counts the steps that replayed successfully and
//   submittedSteps is the total the model emitted. An empty array
//   (no derivation found) scores 0.
//
//   The previous (Phase 2) definition added a fractional COMPLETION_BONUS
//   per chain; that was a reference-solver-only convenience. Phase 3
//   removes it: completion IS the score. A model that finds a shorter
//   route gets the same 1.0 as one that follows the pool's recorded path
//   — both are full-credit derivations. The fraction below 1.0 only ever
//   appears when the model failed mid-way, which is what "partial credit"
//   should mean.
//
// BAND SCORE = mean(chain scores across the 10 chains in the band) × 10.
//   A perfect run is 10 per band × 5 bands = 50.
//
// Why "any valid derivation" rather than "the shortest": the plan pins
// sustained deduction as the eval's value proposition. A solver that finds
// a SHORTER route is still proving a chain — the difficulty is in reaching
// the target by legal moves, not in matching the pool's recorded length.
// Per-band lengths (5/10/20/30/50) are the *target* difficulty of each band;
// a chain is banded by the nominal length, but its score is binary
// (reached / not-reached) once any valid derivation is in hand.

import { verifyDerivation } from "./reference.mjs";
import { POOL_BANDS } from "./generator.mjs";

/**
 * Score one chain's submitted derivation against the recorded (start, target).
 *
 *   fullCredit   true when every step is legal AND the final state equals
 *                the target — the chain earns 1.0 regardless of how many
 *                steps it took.
 *   partial      true when some steps were legal but the chain failed
 *                mid-way (a wrong step at position k, or never reached the
 *                target). Chain score = correctSteps / submittedSteps.
 *
 * @returns {{ fullCredit, partial, correctSteps, submittedSteps, reachedTarget, chainScore, band }}
 */
export const scoreChain = (chain, submitted) => {
  const submittedSteps = Array.isArray(submitted) ? submitted.length : 0;
  const v = verifyDerivation(chain.start, chain.target, Array.isArray(submitted) ? submitted : []);
  const correctSteps = v.correctSteps;
  const reachedTarget = v.reachedTarget;
  const fullCredit = v.ok && reachedTarget;
  let chainScore;
  if (fullCredit) {
    chainScore = 1;
  } else if (submittedSteps > 0) {
    chainScore = correctSteps / submittedSteps;
  } else {
    chainScore = 0;
  }
  return {
    fullCredit,
    partial: !fullCredit && correctSteps > 0,
    correctSteps,
    submittedSteps,
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
 *   perChain: Array<{ id, band, fullCredit, partial, correctSteps, submittedSteps, reachedTarget, chainScore }>
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

  for (const band of POOL_BANDS) {
    const b = perBand[band.name];
    const n = b.chains.length;
    const mean = n ? b.chains.reduce((s, x) => s + x.chainScore, 0) / n : 0;
    b.score = Number(mean.toFixed(4));
    b.points = Number((mean * band.count).toFixed(2)); // max equals the band's 10-point weight
  }

  const total = Number(Object.values(perBand).reduce((s, b) => s + b.points, 0).toFixed(2));
  return { total, max: 50, perBand, perChain };
};

/** Stable id for a chain: `<band>#<attempt>`. */
export const chainIdOf = (chain) => `${chain.band}#${chain.attempt}`;

/**
 * An empty submission is legal — it scores 0 per chain, not protocol_violation.
 * A broken solver (one that throws or returns garbage) is handled at the run
 * level, not here.
 */
export const isEmpty = (submitted) => !Array.isArray(submitted) || submitted.length === 0;

/**
 * Phase 5: the chain engagement rate. The fraction of the 50 chains on
 * which the model's submission made at least ONE legal step (full credit
 * or partial credit). An empty submission (`[]` on every chain) scores
 * engagement 0, which the adjusted formula then claws back as 10 free
 * points the model would otherwise collect.
 *
 * @param {Array} perChain   the scoreRun() per-chain array
 * @returns {number}  fraction 0-1
 */
export const chainEngagementRate = (perChain) => {
  if (!Array.isArray(perChain) || perChain.length === 0) return 0;
  const engaged = perChain.filter((c) => c.fullCredit || c.partial).length;
  return engaged / perChain.length;
};