// MONKEY DO v2 — the dry-run entry point.
//
// `node src/do/chain/dry-run.mjs` loads the published chain pool, runs a
// STUBBED MODEL (the reference solver, as sandbox source) through the
// SAME path a real model call would take, scores the run, and exits non-
// zero unless the result is 50/50.
//
// This is the Phase 3 gate: the model path (sandbox compile + per-chain
// call + score) is exercised end-to-end without a network call. A real
// model submission and the dry-run both go through runChainDo, so passing
// here means the harness soundness the scoring path depends on is real.

import { loadPublishedPool, POOL_FILE } from "./pool.mjs";
import { runChainDo, REFERENCE_SOLVER_SOURCE } from "./run.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Verdict for the dry-run gate: PASS iff the run scored 50/50 AND every
 * chain is full credit AND no chain ended in protocol_violation.
 *
 * Returns { ok, failures, total } so the CLI can print both a one-line
 * verdict and a list of any missing components.
 */
export const dryRunVerdict = (out) => {
  const failures = [];
  if (out.score.total !== 50) {
    failures.push(`scored ${out.score.total}/50; expected 50/50`);
  }
  for (const r of out.score.perChain) {
    if (!r.fullCredit) {
      failures.push(`chain ${r.id}: scored ${r.chainScore}, not full credit (1.0)`);
    }
    if (r.outcome === "protocol_violation") {
      failures.push(`chain ${r.id}: protocol_violation — the sandbox-compiled solver failed`);
    }
  }
  if (!out.usable) failures.push(`the compiled solver did not load: ${out.compileError}`);
  return { ok: failures.length === 0, failures, total: out.score.total };
};

// CLI entry point. Run with `node src/do/chain/dry-run.mjs` to print the
// Phase 3 gate verdict.
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
    console.log(`  stubbed model: reference solver (sandbox source, no network)`);

    // Exercise the SAME path a real model would take: complete() is skipped
    // because modelText is supplied, but compileCandidate + runCandidate +
    // scoreRun all run exactly as they would in a real run.
    const out = await runChainDo(null, {
      chains: pool.chains,
      seed: pool.seed,
      dryRun: true,
      modelText: REFERENCE_SOLVER_SOURCE,
    });

    const verdict = dryRunVerdict(out);
    if (verdict.ok) {
      console.log(`\n  \x1b[32mPASS\x1b[0m  the reference solver (sandbox-compiled) scores ${verdict.total}/50 across all bands.`);
      console.log(`         the model path is sound end to end.\n`);
    } else {
      console.log(`\n  \x1b[31mFAIL\x1b[0m  scored ${verdict.total}/50; the dry-run did not reach 50/50:`);
      for (const f of verdict.failures) console.log(`      - ${f}`);
      console.log();
      process.exit(1);
    }
  })();
}