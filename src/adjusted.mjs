// The ADJUSTED total: one number to plot, reported beside SEE + DO and never
// replacing it.
//
// WHY THIS EXISTS. SEE + DO is out of 100 and already maxes out, so two real
// signals have nowhere to go:
//
//   - the Generalization Index across sample levels (suite 1.0.0). It
//     says whether performance carried from shown examples to held-out
//     inputs at each of the four sample levels. A high index means the
//     model scored well on what it was shown and then its solver … no,
//     the SEE-side scoring. A high SEE GZ means the shown score did not
//     predict the held-out score: surface-fit evidence that the eval is
//     designed to catch.
//
//   - the DO "chain engagement rate" (suite 1.0.0). It says whether the
//     10 free "no confident error" points the DO eval used to award were
//     earned by a solver that was demonstrably active or collected for
//     free by a solver that never made a single legal step. An inert
//     submission (empty array, every chain) earns 10 "no confident
//     error" points by doing nothing; engagement below 1 is the clawback.
//
// Both are currently reported, neither is scored, and a reader plotting
// results has to decide what to do with them. This folds both into one
// derived figure so there is a single number per model, while SEE, DO,
// GZ_mean and chainEngagementRate all remain on the report unchanged.
//
// It is REPORTING ONLY. No 50-point score is modified, the reference
// solver still scores 50/50 on both evals, and nothing here is part of
// the publication gate.
//
// THE TWO ADJUSTMENTS POINT IN OPPOSITE DIRECTIONS, which is why they are
// not one formula:
//
//   - A high GZ_mean INFLATES a score. Memorizing the shown examples looks
//     like competence and collects held-out points it has not earned. So it
//     is SUBTRACTED, weighted by GENERALIZATION_WEIGHT (0.5).
//
//   - A low engagement does not inflate anything, it just means a solver
//     did nothing. The 10 free "no confident error" points are real
//     points in the 50, so they cannot be removed here; instead the
//     unearned portion is clawed back as a subtraction, scaled by how
//     few chains the solver engaged on. The clawback tops out at 10.
//
// Both are bounded and neither can push the total below zero. A model
// that earned nothing scores 0, which is the correct answer.
//
// THE WEIGHTS ARE HAND-CHOSEN, and this project freezes hand-chosen
// weights for a reason — see docs/calibration.md. GENERALIZATION_WEIGHT
// is a judgement about how much surface-fit evidence is worth against
// one point of raw accuracy. NO_CONFIDENT_ERROR_POINTS is the size of
// the DO pool whose free-pass nature this clawback corrects. Both are
// recorded here rather than buried so a reader can disagree with them.
//
// SUITE VERSION. The two-weights-and-an-engagement-rate shape was
// frozen at suite 1.0.0 alongside the DO v2 pool and the SEE sample-
// efficiency levels. Suite 0.x.x used the Minesweeper progress index
// for engagement; that field is gone now and the clawback weights
// reported under it are not comparable to scores recorded here.

/** Points removed per Generalization Index point. See the header. */
export const GENERALIZATION_WEIGHT = 0.5;

/** Maximum points the chain-engagement clawback can subtract. See the header. */
export const NO_CONFIDENT_ERROR_POINTS = 10;

/**
 * Fold the SEE Generalization Index (mean across sample levels) and the
 * DO chain engagement rate into one reported figure.
 *
 * Formula (frozen at suite 1.0.0):
 *
 *   adjusted = clamp(
 *     SEE_total + DO_total
 *       - GENERALIZATION_WEIGHT * GZ_mean        // 0.5 * GZ_mean
 *       - NO_CONFIDENT_ERROR_POINTS * (1 - engagement)  // 10 * (1 - engagement)
 *     , 0, 100
 *   )
 *
 * GZ_mean is the unweighted mean of per-level seen-pass-rate minus
 * held-out-pass-rate, expressed as a percentage (0..100). engagement is the
 * fraction (0..1) of the 50 chains on which the model's submission made at
 * least one legal step (full credit or partial credit). Empty submissions
 * score engagement = 0; full credit on every chain scores engagement = 1.
 *
 * Both adjustments are bounded and never push the total below 0 or above
 * 100. The output preserves the components so a reader can reconstruct
 * the number from the parts.
 *
 * @param {object} opts
 * @param {number} opts.seeTotal  SEE score, 0-50
 * @param {number} opts.doTotal   DO score, 0-50
 * @param {number} opts.gzMean    SEE GZ mean, percentage 0-100 (NOT a fraction)
 * @param {number} [opts.chainEngagementRate]  0-1. Defaults to 1 so a
 *   caller without the new field is never silently penalised.
 * @param {number} [opts.generalizationWeight]
 * @param {number} [opts.noConfidentErrorPoints]
 * @returns {{total: number, max: number, base: number,
 *   generalizationIndexPenalty: number, unearnedPenalty: number,
 *   components: object}}
 */
export const adjustedTotal = ({
  seeTotal,
  doTotal,
  gzMean,
  chainEngagementRate = 1,
  generalizationWeight = GENERALIZATION_WEIGHT,
  noConfidentErrorPoints = NO_CONFIDENT_ERROR_POINTS,
}) => {
  const base = seeTotal + doTotal;
  const gzMeanPenalty = Math.max(0, gzMean) * generalizationWeight;
  // Clamp engagement to [0, 1] first so a bad input cannot claw back more
  // than the component it is correcting. Negative engagement is
  // structurally impossible; the clamp is for defensive cleanliness.
  const engagement = Math.max(0, Math.min(1, chainEngagementRate));
  const unearnedPenalty = Math.max(0, noConfidentErrorPoints * (1 - engagement));

  const raw = base - gzMeanPenalty - unearnedPenalty;

  return {
    total: Math.max(0, Math.min(100, Math.round(raw))),
    max: 100,
    base,
    // The legacy field name (generalizationIndexPenalty) is preserved so
    // existing readers of the adjusted block don't break. The new field
    // carries the same value under its new name (gzMeanPenalty).
    generalizationIndexPenalty: Number(gzMeanPenalty.toFixed(2)),
    gzMeanPenalty: Number(gzMeanPenalty.toFixed(2)),
    unearnedPenalty: Number(unearnedPenalty.toFixed(2)),
    components: {
      seeTotal,
      doTotal,
      gzMean,
      chainEngagementRate,
      generalizationWeight,
      noConfidentErrorPoints,
      formula: "clamp(see + do - GENERALIZATION_WEIGHT*GZ_mean - 10*(1 - chainEngagementRate), 0, 100)",
    },
  };
};