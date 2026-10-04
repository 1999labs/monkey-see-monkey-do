// MONKEY DO v2 — the reference solver.
//
// BFS over the formal system from `start` until `target` is reached, returning
// a SHORTEST derivation as a list of { rule, start, next } steps.
//
// Soundness contract:
//   - every step is rule-applicable (the reference solver never produces a
//     derivation it cannot replay);
//   - every step's `next` is the exact string after applying that step's rule
//     to the previous step's state;
//   - applying the steps in order from `start` lands on `target`.
//
// Performance: a bounded BFS. `MAX_STATES` bounds the visited set and
// `MAX_STEPS` bounds the search depth. A search that hits either cap returns
// null and the pool generator treats that as a rejection.
//
// Determinism: a fixed rule/position ordering in rules.mjs and a stable Map
// insertion order in the visited set make the result reproducible byte-for-
// byte across runs.

import { allApplicable, RULES } from "./rules.mjs";

/** Hard cap on the number of distinct states BFS will visit.
 *
 * The longest L50 chains need ~40k visited states for a BFS to reach their
 * targets — measured against the published pool, not against an isolated
 * worst case. The cap is set above that worst case by a comfortable margin
 * so a future pool that includes harder chains (longer bands, more rules)
 * still runs without an early reject.
 *
 * Phase 2 originally shipped with 10000 here; that turned out to truncate
 * BFS on the chains the pool was already published with, because the
 * generator and the verifier both called solveChain and the verifier hit
 * the cap on every L50 chain. Bumping to 50000 brought the cap above the
 * measured worst case; the dry-run gate verifies the cap is high enough
 * before any chain ships.
 */
export const MAX_STATES = 50000;

/** Hard cap on derivation length BFS will search. Bands stop at 50 today. */
export const MAX_STEPS = 60;

/** Hard cap on string length BFS will expand from. Larger strings explode. */
export const MAX_STRING_LENGTH = 64;

/**
 * Find the shortest derivation from `start` to `target`.
 *
 *   success: { ok: true,  steps: [{rule, start, next}, ...] }
 *   failure: { ok: false, reason: "max_states"|"max_steps"|"not_found" }
 *
 * `steps[0]` is the FIRST move from `start`. Applying the steps in order
 * from `start` lands on `target`. An empty `steps` array means start === target.
 */
export const solveChain = (start, target, { maxStates = MAX_STATES, maxSteps = MAX_STEPS } = {}) => {
  if (start === target) return { ok: true, steps: [] };

  // parent maps a discovered state to its parent state plus the move that
  // produced it. `parent.get(start)` is undefined — start has no parent.
  const parent = new Map();
  parent.set(start, { parentState: null, move: null });

  let frontier = [start];
  let depth = 0;
  while (frontier.length && depth <= maxSteps) {
    if (parent.size >= maxStates) return { ok: false, reason: "max_states" };
    const next = [];
    for (const state of frontier) {
      if (state.length > MAX_STRING_LENGTH) continue;
      for (const occ of allApplicable(state)) {
        if (parent.has(occ.next)) continue;
        parent.set(occ.next, { parentState: state, move: { rule: occ.rule, start: occ.start, next: occ.next } });
        if (occ.next === target) return reconstruct(parent, start, target);
        next.push(occ.next);
      }
    }
    if (parent.size >= maxStates) return { ok: false, reason: "max_states" };
    frontier = next;
    depth++;
  }
  if (depth > maxSteps) return { ok: false, reason: "max_steps" };
  return { ok: false, reason: "not_found" };
};

/** Walk parent pointers from `target` back to `start`, then reverse. */
const reconstruct = (parent, start, target) => {
  const steps = [];
  let cursor = target;
  let entry = parent.get(target);
  if (!entry) return { ok: false, reason: "not_found" };
  while (entry.parentState !== null) {
    steps.push(entry.move);
    cursor = entry.parentState;
    if (cursor === start) break;
    entry = parent.get(cursor);
    if (!entry) return { ok: false, reason: "parent_mismatch" };
  }
  steps.reverse();
  return { ok: true, steps };
};

/**
 * Verify a derivation: walk the steps from `start` and assert each step is
 * rule-applicable, each step's `next` matches the replay, and the final
 * state equals `target`. Used by the dry-run gate and by the scorer.
 *
 * Returns { ok, correctSteps, reachedTarget, lastState, firstBadStep }.
 */
export const verifyDerivation = (start, target, steps) => {
  let state = start;
  let correctSteps = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const rule = RULES.find((r) => r.id === step.rule);
    if (!rule) return { ok: false, correctSteps, reachedTarget: false, lastState: state, firstBadStep: i };
    const occs = rule.match(state);
    const occ = occs.find((o) => o.start === step.start);
    if (!occ) return { ok: false, correctSteps, reachedTarget: false, lastState: state, firstBadStep: i };
    const next = rule.apply(state, occ);
    if (next !== step.next) return { ok: false, correctSteps, reachedTarget: false, lastState: state, firstBadStep: i };
    state = next;
    correctSteps++;
  }
  return { ok: true, correctSteps, reachedTarget: state === target, lastState: state, firstBadStep: null };
};