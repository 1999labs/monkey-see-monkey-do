// MONKEY DO — the formal system.
//
// Phase 1 (frozen) decisions:
//   - 7 symbols:  A B C D X Y Z
//   - 5 rewrite rules
//   - chains are pure string-rewrite derivations, no board / no state beyond
//     the current string
//
// This module is the SPEC for the rules. The reference solver, the chain
// generator and the prompt all import from here, so a change to any rule is
// a one-file edit AND a deliberate bump of GENERATOR_VERSION in pool.mjs.
//
// DETERMINISM is a hard requirement (same as every pool in this suite):
//   - no Math.random
//   - no Date
//   - rule application order is fixed (leftmost occurrence first)
//   - chains generated from a seed must reproduce byte-for-byte
//
// -----------------------------------------------------------------------
// Amendment A — rule set finalized in Phase 2 (deviation from plan spec)
//
// The pivot plan's spec section lists R4 as "trailing X -> append Y" and
// R5 as "leading A -> prepend B". Both are one-shot per derivation: R4
// fires when X is at the end (and only once before the string ends in Y),
// R5 fires when A is at the front (and only once before the string begins
// with B). With 3 length-preserving swaps and 2 one-shot growth rules, the
// reachable space from any starting string caps at depth ~8 — short of the
// L=50 band the plan also pins.
//
// Measured on the plan's exact rule set:
//   starts             depth reached
//   "AXBYCDZX"            4
//   "ABCDXYZD"            5
//   "ABABCDXYZX"          8
//   "XYABCD"              3
//
// Finalized rule set, frozen in Phase 2 (any further change is a deliberate
// bump of GENERATOR_VERSION):
//
//   R1  substring "AB" anywhere   -> replace with "BA"   (length preserved)
//   R2  substring "CD" anywhere   -> replace with "DC"   (length preserved)
//   R3  substring "YZ" anywhere   -> replace with "ZY"   (length preserved)
//   R4  substring "X" anywhere    -> insert "Y" right after the X
//                                              (length grows by 1)
//   R5  substring "A" anywhere    -> insert "B" right before the A
//                                              (length grows by 1)
//
// R4 and R5 can fire many times per derivation (every X, every A is a
// trigger), so chains of depth 50 are reachable from any starting string
// with at least one X and one A. The resulting search space is bounded
// because each rule application extends the string by at most one character
// and the BFS caps the string length at 64 (see reference.mjs
// MAX_STRING_LENGTH).
//
// Branches per step: typically 3-6 (every X can be R4'd, every AB is R1, etc.),
// so a 50-step derivation requires non-trivial search. A model that tries
// rules at random without a strategy will rarely hit the target.
// -----------------------------------------------------------------------

/** The seven symbols the rules operate over. */
export const SYMBOLS = ["A", "B", "C", "D", "X", "Y", "Z"];

/** A character-set membership check, both for input and intermediate strings. */
export const isValidString = (s) =>
  typeof s === "string" && s.length > 0 && [...s].every((ch) => SYMBOLS.includes(ch));

/**
 * The five rewrite rules. Each is a small object describing ONE local rewrite,
 * used by the batch applier (`allApplicable`) and by the per-rule applier.
 *
 *   R1  substring "AB"  -> "BA"   length-preserving local swap
 *   R2  substring "CD"  -> "DC"   length-preserving local swap
 *   R3  substring "YZ"  -> "ZY"   length-preserving local swap
 *   R4  substring "X"   -> insert "Y" after (length+1)
 *   R5  substring "A"   -> insert "B" before (length+1)
 *
 * R4 and R5 can fire many times — every X is a trigger for R4, every A is a
 * trigger for R5. That makes deep derivations possible. R1-R3 are local
 * swaps that preserve length.
 */
export const RULES = [
  {
    id: "R1",
    trigger: "AB",
    rewrite: "BA",
    match(state) {
      const out = [];
      let i = state.indexOf("AB");
      while (i !== -1) {
        out.push({ start: i, rule: "R1" });
        i = state.indexOf("AB", i + 1);
      }
      return out;
    },
    apply(state, occ) {
      return state.slice(0, occ.start) + "BA" + state.slice(occ.start + 2);
    },
  },
  {
    id: "R2",
    trigger: "CD",
    rewrite: "DC",
    match(state) {
      const out = [];
      let i = state.indexOf("CD");
      while (i !== -1) {
        out.push({ start: i, rule: "R2" });
        i = state.indexOf("CD", i + 1);
      }
      return out;
    },
    apply(state, occ) {
      return state.slice(0, occ.start) + "DC" + state.slice(occ.start + 2);
    },
  },
  {
    id: "R3",
    trigger: "YZ",
    rewrite: "ZY",
    match(state) {
      const out = [];
      let i = state.indexOf("YZ");
      while (i !== -1) {
        out.push({ start: i, rule: "R3" });
        i = state.indexOf("YZ", i + 1);
      }
      return out;
    },
    apply(state, occ) {
      return state.slice(0, occ.start) + "ZY" + state.slice(occ.start + 2);
    },
  },
  {
    id: "R4",
    trigger: "X",
    rewrite: "XY",
    match(state) {
      const out = [];
      let i = state.indexOf("X");
      while (i !== -1) {
        out.push({ start: i, rule: "R4" });
        i = state.indexOf("X", i + 1);
      }
      return out;
    },
    apply(state, occ) {
      return state.slice(0, occ.start) + "XY" + state.slice(occ.start + 1);
    },
  },
  {
    id: "R5",
    trigger: "A",
    rewrite: "BA",
    match(state) {
      const out = [];
      let i = state.indexOf("A");
      while (i !== -1) {
        out.push({ start: i, rule: "R5" });
        i = state.indexOf("A", i + 1);
      }
      return out;
    },
    apply(state, occ) {
      return state.slice(0, occ.start) + "BA" + state.slice(occ.start + 1);
    },
  },
];

/** Apply one occurrence of one rule. Returns the next state. */
export const applyOccurrence = (ruleId, state, occ) => {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`unknown rule ${ruleId}`);
  return rule.apply(state, occ);
};

/** Apply one named rule once at one occurrence. Throws on a bad rule id. */
export const applyRule = (state, ruleId, occurrenceStart) => {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`unknown rule ${ruleId}`);
  const occs = rule.match(state);
  const occ = occs.find((o) => o.start === occurrenceStart);
  if (!occ) throw new Error(`rule ${ruleId} not applicable at position ${occurrenceStart} in ${JSON.stringify(state)}`);
  return rule.apply(state, occ);
};

/**
 * All applicable rule applications in one state, in deterministic order.
 *
 * Order: by start position ascending, then by rule id (string compare). Two
 * states that admit the same set of applications produce the same output
 * list, which is what makes the reference solver's BFS deterministic and
 * makes "the rule the model picked" a checkable identity rather than a
 * dependency on iteration order.
 *
 * Each entry carries the `next` state already computed, so the model can
 * emit a derivation as a stream of (rule, start, next) tuples without
 * re-doing the apply step.
 */
export const allApplicable = (state) => {
  const out = [];
  for (const rule of RULES) {
    for (const occ of rule.match(state)) {
      out.push({
        rule: rule.id,
        start: occ.start,
        trigger: rule.trigger,
        rewrite: rule.rewrite,
        next: rule.apply(state, occ),
      });
    }
  }
  out.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule));
  return out;
};

/** Pretty-print the rule set. Stable across calls (used in prompts). */
export const rulesForPrompt = () =>
  [
    `R1  substring "AB" anywhere   -> replace with "BA"`,
    `R2  substring "CD" anywhere   -> replace with "DC"`,
    `R3  substring "YZ" anywhere   -> replace with "ZY"`,
    `R4  substring "X" anywhere    -> insert "Y" immediately after   (length grows by 1)`,
    `R5  substring "A" anywhere    -> insert "B" immediately before  (length grows by 1)`,
  ].join("\n");