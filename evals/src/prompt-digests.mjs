// Recorded SHA-256 of every prompt, exactly as sent (no trailing newline).
//
// guide.md 8.3, check 7. These are pinned so that a digest mismatch means the
// PROMPT CHANGED — never that a reconstruction drifted. Two scores are only
// comparable if every model saw byte-identical text.
//
// Changing a prompt is allowed, but it is a deliberate act: update the digest
// here AND in guide.md 8.3, and treat every score recorded under the old digest
// as a different experiment. Every report embeds the digests it actually used.
//
// DO history: the first DO prompt (digest 69200346a3f1…) called solve(board)
// with no mine count and no stated indexing. It was replaced before any model
// was scored; see src/do/prompt.mjs.

export const RECORDED_DIGESTS = {
  A: "043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da",
  B: "4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc",
  C: "2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728",
  DO: "f2f520b6f29679abaa8ab0b659bb26c66358dbea912cde637cf29b027e28173c",
};
