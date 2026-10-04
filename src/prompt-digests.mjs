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

export const RECORDED_DIGESTS = {
  A: "043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da",
  B: "4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc",
  C: "2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728",
  DO: "d46e8e3f082d5eb56b7f4578ce9d6841bf68535d2b1a455a4499dfca29255ad1",
};

/** Suite version. Bumped deliberately whenever a prompt changes, the pool
 * regenerates, or a phase introduces a scoring change that moves scores.
 *
 *   0.1.0 / 0.2.0  the Minesweeper eval, two prompt revisions
 *   0.3.0           verdict pool split (Pool B = stop + sound + sharp)
 *   1.0.0           DO v2 pivot: string-rewrite formal system, new pool,
 *                   new prompt, new scorer. Minesweeper scores under 1.0.0
 *                   are NOT comparable to scores under any 0.x.x.
 */
export const SUITE_VERSION = "1.0.0";
