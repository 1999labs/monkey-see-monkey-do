// MONKEY DO v2 — chain generator.
//
// Given a seed and a target length L, deterministically produces ONE chain:
//   { start: string, target: string, length: L, steps: [{rule, start, next}, ...] }
//
// The reference solver (`./reference.mjs`) independently derives the same
// shortest path from (start, target); the generator stores the steps here
// only as the committed evidence that this chain IS solvable.
//
// Algorithm (BFS-for-target):
//   1. Pick a starting string: a short, valid mix of symbols. Deterministic
//      from (seed, attempt).
//   2. BFS forward from `start` up to depth L, with the same caps as the
//      reference solver. At each BFS layer k, every state at that layer is
//      a candidate target whose shortest path from `start` is exactly k.
//   3. Pick a target at layer L that is "interesting" (not all one symbol,
//      not the start string, not a trivial suffix-extension of start).
//   4. The committed `length` is the BFS distance start→target. If a deeper
//      generator attempt finds a target at the same layer L, the generator
//      keeps the FIRST one in the deterministic scan.
//
// BFS blowup mitigation: same MAX_STATES and MAX_STEPS caps as the reference
// solver. A band whose quota cannot be filled inside the cap rejects the
// attempt and tries another starting string.

import { SYMBOLS, allApplicable, isValidString } from "./rules.mjs";
import { MAX_STATES, MAX_STEPS, MAX_STRING_LENGTH, solveChain, verifyDerivation } from "./reference.mjs";

/**
 * Mulberry32 PRNG (same shape the mine-pool-builder used). Each
 * seed → deterministic stream. Used here and only here; the published
 * pool's reproducibility depends on it.
 */
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The default per-chain generation budget. Smaller than the BFS cap so a
 * single chain that requires deep BFS doesn't stall the whole pool. */
export const CHAIN_GEN_BUDGET_MS = 2000;

/** Pool-time seed. The pool file's seed. */
export const POOL_SEED = 0xc0ffee;

/** Per-band chain counts and target derivation lengths. Frozen at Phase 1. */
export const POOL_BANDS = [
  { name: "L5",  length: 5,  count: 10 },
  { name: "L10", length: 10, count: 10 },
  { name: "L20", length: 20, count: 10 },
  { name: "L30", length: 30, count: 10 },
  { name: "L50", length: 50, count: 10 },
];

/** Generate one starting string for a given attempt and band.
 *  Deterministic from (seed, bandIndex, attempt).
 *
 *  Length range: 4-6 symbols. Mix of A/B/C/D and X/Y/Z so both swap rules
 *  and length-extending rules have something to fire on. Crucially, the
 *  string must have at least one applicable rule at depth 0, otherwise the
 *  BFS layer at length L is empty (no rule fires → no state at layer 1+).
 *  The function draws symbols until the start has at least one rule that
 *  fires; the BFS handles the rest.
 *
 *  The attempt counter guarantees determinism: the same (seed, attempt)
 *  draws the same stream even when the while-loop iterates.
 */
const pickStart = (rng, { minLen = 4, maxLen = 6, maxDraws = 50 } = {}) => {
  for (let draw = 0; draw < maxDraws; draw++) {
    const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    let out = "";
    for (let i = 0; i < len; i++) out += SYMBOLS[Math.floor(rng() * SYMBOLS.length)];
    if (!isValidString(out)) continue;
    // If at least one rule applies, we can build chains; otherwise draw again.
    if (allApplicable(out).length > 0) return out;
  }
  // Fallback "AXBX" — provably has R1 and R5.
  return "AXBX";
};

/**
 * BFS from `start` and return the set of states reachable at EXACTLY depth k.
 *
 * Returns null if BFS hits the cap before reaching that layer, or if no
 * state at depth k exists. Layer k includes the start only when k === 0.
 *
 * `maxStates` and `maxSteps` are inherited from the reference solver so a
 * chain that survives this BFS is one the reference solver can also find.
 */
const layerAt = (start, k, { maxStates = MAX_STATES, maxSteps = MAX_STEPS } = {}) => {
  if (k === 0) return new Set([start]);
  let frontier = [start];
  let visited = new Set([start]);
  let depth = 0;
  while (frontier.length && depth < k) {
    const next = [];
    for (const state of frontier) {
      if (state.length > MAX_STRING_LENGTH) continue;
      for (const occ of allApplicable(state)) {
        if (visited.has(occ.next)) continue;
        visited.add(occ.next);
        next.push(occ.next);
        if (visited.size >= maxStates) return null;
      }
    }
    if (next.length === 0) return new Set(); // dead end — no layer here
    if (depth + 1 === k) return new Set(next);
    frontier = next;
    depth++;
    if (depth > maxSteps) return null;
  }
  if (depth >= k) return new Set(next ?? []);
  return new Set();
};

/**
 * Heuristic: a "boring" target is one whose derivation would not actually
 * exercise deduction. The plan's eval is "sustained deduction", so a chain
 * whose entire derivation is "apply R4 at position 0 fifty times" does not
 * test it. Patterns filtered out:
 *
 *   - the same string as start (length-0 derivation, never useful)
 *   - a target whose derivation uses only ONE rule id (a single rule applied
 *     many times is a memory, not a deduction)
 *   - a target that is a single rule-application from start (length-1)
 *   - strings that are pure single-character (degenerate)
 *
 * The "two distinct rules" floor is hand-chosen. The chains at L=5 still
 * average 2.5 distinct rules under this filter (verified by measurement on
 * the published pool; see calibration.md for the count after Phase 7).
 *
 * Beyond that, we keep the FIRST target in deterministic insertion order
 * that satisfies the heuristic. The pool's reproducibility requires the
 * choice to be a pure function of (seed, bandIndex, attempt, layer).
 */
const isBoringTarget = (start, target, _derivableAt, steps) => {
  if (target === start) return true;
  if (target.length < 2) return true;
  if (new Set(target).size === 1) return true;
  if (steps) {
    const distinct = new Set(steps.map((s) => s.rule));
    if (distinct.size < 2) return true; // single-rule derivations are memorisable
    // A second heuristic: even a mixed derivation is memorisable if one
    // rule accounts for >= 90% of the steps. The plan measures sustained
    // deduction, and "do R4 49 times then R5 once" is a memorised two-step
    // pattern, not a 50-step deduction. We require at least 3 distinct rule
    // ids AND no rule over 85% of steps. The 85% (not 80%) is a deliberate
    // trade: an 80% floor made L50 generation time out at the pool level
    // (a handful of chains took 60s+ to find); 85% still keeps derivations
    // demonstrably mixed without paying that cost.
    if (distinct.size < 3) return true;
    const counts = {};
    for (const s of steps) counts[s.rule] = (counts[s.rule] || 0) + 1;
    const maxCount = Math.max(...Object.values(counts));
    if (maxCount / steps.length >= 0.85) return true;
  }
  return false;
};

/**
 * Generate one chain in a given band. The `attempt` argument is the
 * rejection-sampling index — bumped on every failed attempt until either a
 * chain is produced or `maxAttempts` is exceeded.
 *
 * Returns null on rejection (no chain found in this attempt), or
 *   { start, target, length, steps, attempt, ms }
 * on completion. `length` is the BFS distance start→target, which by
 * construction equals the band's nominal length.
 */
export const generateChain = ({ bandIndex, seed, attempt = 1, maxAttempts = 1 } = {}) => {
  const band = POOL_BANDS[bandIndex];
  if (!band) throw new Error(`unknown band ${bandIndex}`);
  const rng = makeRng((seed ^ Math.imul(bandIndex + 1, 0x9e3779b1) ^ Math.imul(attempt, 0x85ebca6b)) >>> 0);

  const t0 = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() - t0 > CHAIN_GEN_BUDGET_MS) return { ok: false, reason: "budget_exceeded" };
    const start = pickStart(rng);
    const layer = layerAt(start, band.length);
    if (!layer) continue;
    if (layer.size === 0) continue; // BFS died before reaching this depth

    // For each candidate target at this layer, run the reference solver
    // and apply the boring-target filter. Pick the FIRST non-boring one
    // in deterministic insertion order.
    let accepted = null;
    for (const cand of layer) {
      const solved = solveChain(start, cand);
      if (!solved.ok) continue;
      if (solved.steps.length !== band.length) continue;
      const v = verifyDerivation(start, cand, solved.steps);
      if (!v.ok || !v.reachedTarget) continue;
      if (isBoringTarget(start, cand, band.length, solved.steps)) continue;
      accepted = { start, target: cand, length: solved.steps.length, steps: solved.steps, attempt, ms: Date.now() - t0 };
      break;
    }
    if (accepted) return { ok: true, ...accepted };
  }
  return { ok: false, reason: "no_chain" };
};

/**
 * Generate the full pool by rejection sampling. Deterministic: the same
 * seed produces the same chains, byte for byte.
 *
 * Returns { chains, stats } where stats counts attempts / failures per
 * band. The pool writer (./pool.mjs) decides the JSON layout.
 */
export const generatePool = ({ seed = POOL_SEED } = {}) => {
  const chains = [];
  const stats = POOL_BANDS.map(() => ({ attempts: 0, generated: 0 }));
  for (let bandIndex = 0; bandIndex < POOL_BANDS.length; bandIndex++) {
    const band = POOL_BANDS[bandIndex];
    let attempts = 0;
    while (chains.filter((c) => c.bandIndex === bandIndex).length < band.count) {
      if (++attempts > 200000) {
        throw new Error(`band ${band.name}: only generated ${chains.filter((c) => c.bandIndex === bandIndex).length} of ${band.count} after 200000 attempts`);
      }
      const out = generateChain({ bandIndex, seed, attempt: attempts, maxAttempts: 1 });
      stats[bandIndex].attempts = attempts;
      if (!out.ok) continue;
      stats[bandIndex].generated++;
      chains.push({
        bandIndex,
        band: band.name,
        length: band.length,
        start: out.start,
        target: out.target,
        steps: out.steps,
        attempt: out.attempt,
      });
    }
  }
  return { chains, stats };
};