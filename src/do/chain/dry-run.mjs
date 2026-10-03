// MONKEY DO v2 — the dry-run entry point.
//
// `node src/do/chain/dry-run.mjs` loads the published chain pool, runs the
// reference solver over every chain, scores the run, and exits non-zero
// unless the result is 50/50 (the Phase 2 gate).
//
// The harness is intentionally minimal here. Phase 3 replaces the model
// invocation; Phase 5 wires up reporting. For now this module is JUST the
// Phase 2 gate: prove the reference solver scores 50/50 on the published
// pool.

import { loadPublishedPool, POOL_FILE } from "./pool.mjs";
import { solveChain } from "./reference.mjs";
import { scoreRun, chainIdOf } from "./score.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Play the reference solver against every chain in the pool.
 *
 * @param {object} opts
 * @param {Array} opts.chains
 * @returns {{ submittedPerChain, perChain, total }}
 */
export const dryRun = ({ chains }) => {
  const submittedPerChain = {};
  const perChain = [];
  for (const c of chains) {
    const solved = solveChain(c.start, c.target);
    if (!solved.ok) {
      // Should never happen: every chain in the published pool is solvable
      // by construction (the generator's reference-solver step requires it).
      throw new Error(`chain ${chainIdOf(c)} is not solvable: ${solved.reason}`);
    }
    submittedPerChain[chainIdOf(c)] = solved.steps;
  }
  const scored = scoreRun({ chains, submittedPerChain });
  return {
    submittedPerChain,
    perChain: scored.perChain,
    total: scored.total,
    perBand: scored.perBand,
  };
};

/**
 * The verdict for the Phase 2 gate: PASS iff the reference solver scores
 * 50/50 on every chain in the published pool.
 *
 * Returns { ok, failures, total } so the CLI can print both a one-line
 * verdict and a list of any missing components.
 */
export const dryRunVerdict = (out) => {
  const failures = [];
  if (out.total !== 50) {
    failures.push(`reference solver scored ${out.total}/50; expected 50/50`);
  }
  for (const r of out.perChain) {
    if (r.chainScore < 1) {
      failures.push(`chain ${r.id}: scored ${r.chainScore} (expected 1.0)`);
    }
  }
  return { ok: failures.length === 0, failures, total: out.total };
};

// CLI entry point. Run with `node src/do/chain/dry-run.mjs` to print the
// Phase 2 gate verdict.
const isMain = (() => {
  try {
    return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href);
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    console.log(`\nMONKEY DO v2 · chain dry-run`);
    let pool;
    try {
      pool = loadPublishedPool({ path: POOL_FILE });
    } catch (err) {
      console.error(`\n  \x1b[31mFAIL\x1b[0m  ${err.message}\n`);
      process.exit(1);
    }
    console.log(`  pool sha256 ${pool.sha256.slice(0, 16)}…  ·  ${pool.chains.length} chains`);
    const out = dryRun({ chains: pool.chains });
    const verdict = dryRunVerdict(out);
    if (verdict.ok) {
      console.log(`\n  \x1b[32mPASS\x1b[0m  the reference solver scores ${verdict.total}/50 across all bands.\n`);
    } else {
      console.log(`\n  \x1b[31mFAIL\x1b[0m  scored ${verdict.total}/50; the reference solver did not reach 50/50:`);
      for (const f of verdict.failures) console.log(`      - ${f}`);
      console.log();
      process.exit(1);
    }
  })();
}

// Local helpers for the isMain guard. Kept at the bottom so the rest of the
// module reads as a pure library.