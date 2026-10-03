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

export const RECORDED_DIGESTS = {
  A: "043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da",
  B: "4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc",
  C: "2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728",
  DO: "b7a62fe682039067b6f1f0eef8e34abd2ea4cab574d315da75fb053b0d6b14d8",
};
