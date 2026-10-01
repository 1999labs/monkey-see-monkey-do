// The ADJUSTED total: one number to plot, reported beside SEE + DO and never
// replacing it.
//
// WHY THIS EXISTS. SEE + DO is out of 100 and already maxes out, so two real
// signals have nowhere to go:
//
//   - the Monkey Index, which says whether performance carried from shown to
//     held-out examples or was surface fit;
//   - the DO diagnostic, which says whether the 10 "no confident error" points
//     were earned by a solver that was demonstrably cautious or collected for
//     free by a solver that never clicked anything.
//
// Both are currently reported, neither is scored, and a reader plotting results
// has to decide what to do with them. This folds both into one derived figure
// so there is a single number per model, while SEE, DO, the Monkey Index and the
// diagnostic all remain on the report unchanged.
//
// It is REPORTING ONLY. No 50-point score is modified, the reference solver
// still scores 50/50 on DO, and nothing here is part of the publication gate.
//
// THE TWO ADJUSTMENTS POINT IN OPPOSITE DIRECTIONS, which is why they are not
// one formula:
//
//   - A high Monkey Index INFLATES a score. Memorizing the shown examples looks
//     like competence and collects held-out points it has not earned. So it is
//     SUBTRACTED.
//   - A low diagnostic does not inflate anything, it just means a solver did
//     nothing. The 10 no-confident-error points are real points in the 50, so
//     they cannot be removed here; instead the unearned portion is clawed back
//     as a subtraction, scaled by how few boards the solver engaged on.
//
// Both are bounded and neither can push the total below zero. A model that
// earned nothing scores 0, which is the correct answer.
//
// THE WEIGHTS ARE HAND-CHOSEN, and this project freezes hand-chosen weights for
// a reason — see docs/calibration.md. MI_WEIGHT is a judgement about how much
// surface-fit evidence is worth against one point of raw accuracy, and the
// clawback returns exactly the points the diagnostic shows were unearned. They
// are recorded here rather than buried so a reader can disagree with them.

/** Points removed per Monkey Index point. See the header. */
export const MI_WEIGHT = 0.5;

/** DO's "no confident error" component, i.e. the points a do-nothing solver collects. */
export const NO_CONFIDENT_ERROR_POINTS = 10;

/**
 * Fold the Monkey Index and the DO diagnostic into one reported figure.
 *
 * @param {object} opts
 * @param {number} opts.seeTotal  SEE score, 0-50
 * @param {number} opts.doTotal   DO score, 0-50
 * @param {number} opts.monkeyIndex  SEE index, seen rate minus held-out rate, as a percentage
 * @param {number} [opts.initiationRate]  DO diagnostic initiation, 0-1. Defaults to 1
 *   (no clawback) so a caller without a diagnostic is never silently penalised.
 * @returns {{total: number, max: number, base: number, monkeyIndexPenalty: number,
 *   unearnedPenalty: number, components: object}}
 */
export const adjustedTotal = ({
  seeTotal,
  doTotal,
  monkeyIndex,
  initiationRate = 1,
  miWeight = MI_WEIGHT,
  noConfidentErrorPoints = NO_CONFIDENT_ERROR_POINTS,
}) => {
  const base = seeTotal + doTotal;
  const monkeyIndexPenalty = Math.max(0, monkeyIndex) * miWeight;
  // An inert solver collected the full no-confident-error points without
  // engaging; claw back the portion it did not earn. The engagement rate is
  // clamped to [0,1] first so a bad diagnostic cannot claw back more than the
  // component it is correcting.
  const engagement = Math.max(0, Math.min(1, initiationRate));
  const unearnedPenalty = Math.max(0, noConfidentErrorPoints * (1 - engagement));

  const raw = base - monkeyIndexPenalty - unearnedPenalty;

  return {
    total: Math.max(0, Math.min(100, Math.round(raw))),
    max: 100,
    base,
    monkeyIndexPenalty: Number(monkeyIndexPenalty.toFixed(2)),
    unearnedPenalty: Number(unearnedPenalty.toFixed(2)),
    // Kept so a reader can reconstruct the number from the parts.
    components: {
      seeTotal,
      doTotal,
      monkeyIndex,
      initiationRate,
      miWeight,
      formula: "clamp(see + do - MI_WEIGHT*MI - 10*(1 - initiationRate), 0, 100)",
    },
  };
};