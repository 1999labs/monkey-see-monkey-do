// Recorded SHA-256 of every prompt, exactly as sent (no trailing newline).
//
// These are pinned so that a digest mismatch means the
// PROMPT CHANGED — never that a reconstruction drifted. Two scores are only
// comparable if every model saw byte-identical text.
//
// Changing a prompt is allowed, but it is a deliberate act: update the digest
// here, bump the suite version, and treat every score recorded under the old digest
// as a different experiment. Every report embeds the digests it actually used.
//
// DO history: the first DO prompt (digest 69200346a3f1…) called solve(board)
// with no mine count and no stated indexing. It was replaced before any model
// was scored; see src/do/prompt.mjs.
//
// Second digest f2f520b6f296… defined the current solve contract (mine count,
// zero-based indexing) and scored the Cohort 1 reports under suite 0.2.0.
//
// Third digest b7a62fe68203… (suite 0.3.0) adds the verdict protocol: a second
// function, verdict(position, claims, mines), scored on Pool B. Scores recorded
// under either earlier digest describe a different DO and are not comparable.
//
// Fourth digest d46e8e3f082d… (suite 1.0.0) is the DO v2 pivot: the prompt
// describes the string-rewrite formal system (5 rules, 7 symbols) and asks
// for a single solve(start, target) function. The Minesweeper pool and the
// DO v2 pool are non-comparable — a clean break, marked by the suite
// version bump to 1.0.0. The v2 DO has its own pool (sha256
// f87d0b1906fc7906…, seed 0xC0FFEE) and its own scorer.
//
// SEE history: under suite 0.x.x, every SEE run used the 8-shown-example
// prompt (level 8). The level-8 digests A=043dd2b7…, B=4f200996…,
// C=2e2bcf34… are what old Cohort 1 reports were scored under.
//
// Fifth: suite 1.0.0 also adds the SEE sample-efficiency axis. Each task
// now ships 16 shown examples (was 8); the SEE runner loops over sample
// levels 2, 4, 8, 16 and the per-task score is a weighted average. Levels
// 2, 4 and 16 are NEW prompt slots — their digests are recorded below so a
// score can always be re-derived from the exact prompt that produced it.
// The level-8 digests are unchanged byte-for-byte: every existing
// SEE score under the old level-8 prompt is still comparable to a new
// level-8 run.

export const RECORDED_DIGESTS = {
  A: "043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da",
  B: "4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc",
  C: "2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728",
  DO: "d46e8e3f082d5eb56b7f4578ce9d6841bf68535d2b1a455a4499dfca29255ad1",
};

/**
 * SEE sample-level prompt digests, suite 1.0.0.
 *
 * Keys are "<taskId>-<level>". Levels are 2, 4, 8, 16. Level 8 mirrors
 * RECORDED_DIGESTS (the level-8 pin is the single source of truth for
 * backward compat; the per-level pins live here).
 *
 * The first 8 shown examples of every task are unchanged from suite 0.x.x,
 * so every level-8 digest is identical to the corresponding level-8
 * pin in RECORDED_DIGESTS. The level-2 / level-4 / level-16 pins below
 * are the per-level digests of those new prompt slots.
 */
export const SEE_LEVEL_DIGESTS = {
  "A-2":  "0ce5da7eed7dc90503563bb4e8a2a83fc701dd00cd47adca58aa9c170a7fe32c",
  "A-4":  "e6c84ef27b4e58d5cb97b3c09a53952589891118f2d44a837181124eb7363e05",
  "A-8":  "043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da",
  "A-16": "5b48ec298ed807ea6309052d4888324d1960b22fdb6f0a7803c9d415bf04f768",
  "B-2":  "17bf47ec5bb83689067964d687c7ede5ebacfff6ed02042dece695a713830c86",
  "B-4":  "698d863b99cc446224b5e0ab6142b58908f9857c1b23c7fe812156d48e1701c3",
  "B-8":  "4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc",
  "B-16": "7098500ee41c57825a4820b203bab888d883316de75132c37c24f369cd3431fd",
  "C-2":  "35d76575f91d1ed2047a9ebecf05ef109bdb74301f145f89bee00901f15a3482",
  "C-4":  "d305dfb38c4f1f103a219b12d46de7a639d8ca7b34e9b86e1e3845d5a40fd2f9",
  "C-8":  "2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728",
  "C-16": "acd424f775345fe21993783679f5bdb904b15517ca1d82d959368f639f136294",
};

/** Suite version. Bumped deliberately whenever a prompt changes, the pool
 * regenerates, or a phase introduces a scoring change that moves scores.
 *
 *   0.1.0 / 0.2.0  the Minesweeper eval, two prompt revisions
 *   0.3.0           verdict pool split (Pool B = stop + sound + sharp)
 *   1.0.0           DO v2 pivot (string-rewrite formal system, new pool,
 *                   new prompt, new scorer) AND SEE sample efficiency
 *                   (levels 2, 4, 8, 16). Minesweeper scores under 1.0.0
 *                   are NOT comparable to scores under any 0.x.x. Old
 *                   SEE scores under level 8 remain comparable because
 *                   the level-8 prompt is byte-identical.
 */
export const SUITE_VERSION = "1.0.0";
