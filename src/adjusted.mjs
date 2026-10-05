// The ADJUSTED total: one number to plot, reported beside SEE + DO and never
// replacing it.
//
// WHY THIS EXISTS. SEE + DO is out of 100 and already maxes out, so two real
// signals have nowhere to go:
//
//   - the Generalization Index across sample levels (suite 1.0.0+). It
//     says whether performance carried from shown examples to held-out
//     inputs at each of the four sample levels. A high index means the
//     model scored well on what it was shown and then its solver … no,
//     the SEE-side scoring. A high SEE GZ means the shown score did not
//     predict the held-out score: surface-fit evidence that the eval is
//     designed to catch.
//
//   - the DO "chain engagement rate" (suite 1.0.0+). It says whether the
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
// 1.1.0 CHANGE — the floor-saturation fix.
//
// Under the 1.0.0 formula (flat 0.5 × GZ_mean and flat 10 × (1 − eng))
// a weak model's two penalties could jointly exceed its base: the qwen
// shape (SEE 19, DO 1, GZ 26.7, eng 0.04) resolved to
// raw 19.54 − 10.82 − 9.6 = −0.88, clamped to 0; the whole weak
// band compressed into one value and lost resolving power where the
// eval needed it most. The 1.1.0 fix scales the GZ penalty by the
// model's EARNED FRACTION:
//
//   GZ_penalty = 0.5 × GZ_mean × ((SEE + DO) / 100)
//
// A surface-fit correction now can never subtract more than the model
// earned (the (SEE+DO)/100 factor caps it at 1.0 when the model
// scored near-perfect). For scores near 0 the factor is ≈0 and the
// GZ correction is too — the qwen example resolves to
// ~8 under 1.1.0 where it floored at 0.
//
// THE ENGAGEMENT CLAWBACK STAYS FIXED — 10 × (1 − engagement), unscaled.
// This asymmetry is deliberate: free-points (a sword) must not pity the
// weak, surface-fit (a shield) must. The engagement clawback is
// structurally about what the model DID NOT DO; scaling it by the
// earned fraction would let a non-engaged model off the hook for a
// fraction of its free-points, which is the exact failure the
// clawback exists to catch. The formula is therefore:
//
//   adjusted = clamp( SEE + DO
//                       − GENERALIZATION_WEIGHT × GZ_mean × (SEE + DO) / 100
//                       − NO_CONFIDENT_ERROR_POINTS × (1 − engagement)
//                    , 0, 100 )
//
// SUITE VERSION. This formula was bumped to suite 1.1.0 alongside
// the Phase 8 local-cohort recalc. Prompt digests are UNCHANGED —
// the pivot at 1.0.0 is the clean break, this is a derived-figure
// change only. Combined reports carry both readings side by side
// (adjusted.total = 1.0.0 reading, adjusted.total_1_1_0 = 1.1.0
// reading) and the cohort table prints both with their formula
// stamps. A future change to either weight breaks the four self-test
// pins in src/self-test.mjs (all-engaged, never-engaged, partially-
// engaged, round-trip) — that is the tripwire.
//
// THE WEIGHTS ARE HAND-CHOSEN, and this project freezes hand-chosen
// weights for a reason — see docs/calibration.md. GENERALIZATION_WEIGHT
// is a judgement about how much surface-fit evidence is worth against
// one point of raw accuracy. NO_CONFIDENT_ERROR_POINTS is the size of
// the DO pool whose free-pass nature this clawback corrects. Both are
// recorded here rather than buried so a reader can disagree with them.
//
// Suite 0.x.x used the Minesweeper progress index for engagement;
// that field is gone now and the clawback weights reported under it
// are not comparable to scores recorded here.

/** Points removed per Generalization Index point. See the header. */
export const GENERALIZATION_WEIGHT = 0.5;

/** Maximum points the chain-engagement clawback can subtract. See the header. */
export const NO_CONFIDENT_ERROR_POINTS = 10;

/** Suite version stamped on every report. Bumped at deliberate changes. */
export const SUITE_VERSION = "1.1.0";

/**
 * Fold the SEE Generalization Index (mean across sample levels) and the
 * DO chain engagement rate into one reported figure.
 *
 * Formula (frozen at suite 1.1.0):
 *
 *   adjusted = clamp(
 *     SEE_total + DO_total
 *       - GENERALIZATION_WEIGHT * GZ_mean * (SEE_total + DO_total) / 100
 *       - NO_CONFIDENT_ERROR_POINTS * (1 - engagement)
 *     , 0, 100
 *   )
 *
 * GZ_mean is the unweighted mean of per-level seen-pass-rate minus
 * held-out-pass-rate, expressed as a percentage (0..100). engagement is
 * the fraction (0..1) of the 50 chains on which the model's submission
 * made at least one legal step (full credit or partial credit). Empty
 * submissions score engagement = 0; full credit on every chain scores
 * engagement = 1.
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
 *   gzMeanPenalty: number, earnedFraction: number,
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
  // Clamp GZ to [0, ∞) — a negative GZ means held-out out-performs shown,
  // which is generalisation in the GOOD direction; we don't penalise it.
  // (Per docs/calibration.md §3, naive baselines carry negative GZ on
  // some tasks; we don't subtract from scores for being below baseline.)
  const safeGz = Math.max(0, gzMean);
  // Earned fraction: (SEE + DO) / 100. Clamp to [0, 1] so a report with
  // an inflated base (caller bug) cannot scale the penalty past its
  // intent. A score of 100 yields factor 1.0 (no relief). A score of 0
  // yields factor 0.0 (no GZ correction can be applied — the model
  // earned nothing to claw back from).
  const earnedFraction = Math.max(0, Math.min(1, base / 100));
  const gzMeanPenalty = safeGz * generalizationWeight * earnedFraction;
  // Clamp engagement to [0, 1] first so a bad input cannot claw back
  // more than the component it is correcting. Negative engagement is
  // structurally impossible; the clamp is for defensive cleanliness.
  const engagement = Math.max(0, Math.min(1, chainEngagementRate));
  // Engagement clawback is FIXED (unscaled). This asymmetry is
  // deliberate: a non-engaged submission earned its free points by
  // doing nothing, and scaling the clawback by earned fraction would
  // pity the weak exactly where the clawback exists to penalise.
  const unearnedPenalty = Math.max(0, noConfidentErrorPoints * (1 - engagement));

  const raw = base - gzMeanPenalty - unearnedPenalty;

  return {
    total: Math.max(0, Math.min(100, Math.round(raw))),
    max: 100,
    base,
    // The legacy field name (generalizationIndexPenalty) is preserved so
    // existing readers of the adjusted block don't break. The new field
    // carries the same value under its new name (gzMeanPenalty) — and
    // reflects the 1.1.0 scaled value, NOT the 1.0.0 flat value.
    generalizationIndexPenalty: Number(gzMeanPenalty.toFixed(2)),
    gzMeanPenalty: Number(gzMeanPenalty.toFixed(2)),
    unearnedPenalty: Number(unearnedPenalty.toFixed(2)),
    earnedFraction: Number(earnedFraction.toFixed(4)),
    components: {
      seeTotal,
      doTotal,
      gzMean,
      chainEngagementRate,
      generalizationWeight,
      noConfidentErrorPoints,
      formula:
        "clamp(see + do - GENERALIZATION_WEIGHT*GZ_mean*(see+do)/100 - 10*(1 - chainEngagementRate), 0, 100)",
      formulaVersion: SUITE_VERSION,
    },
  };
};

/**
 * Recalculate the 1.0.0 reading for back-compat. Pure function of the
 * same four components; never re-runs the model. Reports store BOTH
 * readings side by side (1.0.0 reading as adjusted.total, 1.1.0
 * reading as adjusted.total_1_1_0) so the audit trail is intact.
 */
export const adjustedTotal_1_0_0 = ({
  seeTotal,
  doTotal,
  gzMean,
  chainEngagementRate = 1,
}) => {
  const base = seeTotal + doTotal;
  const safeGz = Math.max(0, gzMean);
  const gzMeanPenalty = safeGz * 0.5;
  const engagement = Math.max(0, Math.min(1, chainEngagementRate));
  const unearnedPenalty = Math.max(0, 10 * (1 - engagement));
  const raw = base - gzMeanPenalty - unearnedPenalty;
  return {
    total: Math.max(0, Math.min(100, Math.round(raw))),
    max: 100,
    base,
    generalizationIndexPenalty: Number(gzMeanPenalty.toFixed(2)),
    gzMeanPenalty: Number(gzMeanPenalty.toFixed(2)),
    unearnedPenalty: Number(unearnedPenalty.toFixed(2)),
    earnedFraction: 1, // 1.0.0 didn't have this concept; report 1 for symmetry
    components: {
      seeTotal,
      doTotal,
      gzMean,
      chainEngagementRate,
      generalizationWeight: 0.5,
      noConfidentErrorPoints: 10,
      formula: "clamp(see + do - GENERALIZATION_WEIGHT*GZ_mean - 10*(1 - chainEngagementRate), 0, 100)",
      formulaVersion: "1.0.0",
    },
  };
};