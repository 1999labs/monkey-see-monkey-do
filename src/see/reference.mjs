// MONKEY SEE — ground truth ONLY.
//
// INTEGRITY: this file must never be imported by prompt-construction code.
// Nothing in here is ever sent to a model. It holds the true rules and the
// naive implementations they are designed to punish, and nothing else — no
// case data lives here, so there is nothing in this module that could be
// leaked into a prompt even by mistake.
//
// The shown examples and held-out inputs live in tasks/*.json, which store no
// expected values for held-out cases. Those are DERIVED at runtime from the
// functions below, so data and truth cannot drift apart.

/**
 * Task A — hidden threshold.
 * f(n) = n*n when n <= 10, otherwise n*n - 100
 */
export const referenceA = (n) => (n <= 10 ? n * n : n * n - 100);

/** Naive: n => n * n. Misses the threshold entirely. */
export const naiveA = (n) => n * n;

/**
 * Task B — string transform with a carve-out.
 * If the first character is a vowel, return unchanged; else uppercase it.
 */
export const referenceB = (s) => {
  if (typeof s !== "string" || s.length === 0) return s;
  const first = s[0].toLowerCase();
  if ("aeiou".includes(first)) return s;
  return s[0].toUpperCase() + s.slice(1);
};

/** Naive: always uppercase. Misses the vowel carve-out entirely. */
export const naiveB = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Task C — second-largest DISTINCT value, or null.
 * Requires three separate things: dedup, degenerate handling, and null
 * (not undefined) as the empty answer.
 */
export const referenceC = (arr) => {
  if (!Array.isArray(arr)) return null;
  const distinct = [...new Set(arr)];
  if (distinct.length < 2) return null;
  distinct.sort((a, b) => b - a);
  return distinct[1];
};

/**
 * Naive: sort the raw array descending and index len-2.
 * No dedup, no degenerate handling, and it returns undefined rather than null.
 */
export const naiveC = (arr) => arr.slice().sort((a, b) => b - a)[arr.length - 2];

// Task id -> implementations. The JSON files carry the id; this maps it to
// ground truth. Keeping the join in one place means nothing downstream has to
// know which function belongs to which task.
export const groundTruth = {
  A: { reference: referenceA, naive: naiveA },
  B: { reference: referenceB, naive: naiveB },
  C: { reference: referenceC, naive: naiveC },
};
