// The publication gate — the criteria a run must clear before the suite ships.
//
//   node bin/acceptance.mjs --strong <model> --weak <model>
//
// "If any criterion fails, the evaluation is not published. An evaluation
// that does not discriminate is worse than no evaluation, because it
// manufactures false confidence."
//
// Checks, in order:
//
//   1. the full self-test passes
//   2. a dry run on the chain pool scores 50/50: the reference solver wins
//      every chain across all five bands
//   3. a chain-naive (empty-array) submission scores 0 with chainEngagement
//      Rate 0 — exactly the "free points earned by doing nothing" condition
//      the clawback in the adjusted formula targets
//   4. each band carries exactly 10 chains (band-partition regression guard)
//   5. each model is scored `--runs` times (default 3) through the normal
//      run-all path, and its SEE and DO totals must agree within 2 points
//   6. the strong model outscores the weak one on BOTH evals
//
// Cost: 12 model calls per SEE (3 tasks × 4 levels) + 1 per DO, so 13 per
// run, 78 total at the defaults. Writes results/acceptance-<date>.json.
//
// --quick skips pool regeneration and plays a subset, for rehearsing the
// gate. A quick run can never report the gate as passed.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runSelfTest } from "../src/self-test.mjs";
import { runChainDo, REFERENCE_SOLVER_SOURCE } from "../src/do/chain/run.mjs";
import { dryRunVerdict } from "../src/do/chain/dry-run.mjs";
import { loadPublishedPool } from "../src/do/chain/pool.mjs";
import { chainEngagementRate } from "../src/do/chain/score.mjs";
import { runAll } from "../src/run-all.mjs";
import { parseArgs, prepareModel } from "../src/cli.mjs";
import { adjustedTotal } from "../src/adjusted.mjs";
import { LIMITATIONS } from "../src/report.mjs";

const argv = process.argv.slice(2);
const take = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const strong = take("--strong");
const weak = take("--weak");
const quick = argv.includes("--quick");
// Bad arguments are a setup error and must not become an unhandled crash: the
// parse is strict (unknown flags throw), so catch it, say which token, exit 1.
let common;
try {
  common = parseArgs(argv.filter((a) => a !== "--quick"));
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
const runs = common.runs ?? 3;

if (!strong || !weak || common.help) {
  console.log(`
MONKEY SEE / MONKEY DO · acceptance gate (publication criteria)

  node bin/acceptance.mjs --strong <model> --weak <model> [--runs 3]

  --strong MODEL   a model known to be strong (e.g. a frontier model)
  --weak MODEL     a small model (e.g. ollama/qwen2.5-coder:7b)
  --runs N         runs per model (default 3; the gate requires 3)
  --quick          rehearsal: skip the model-runs; just self-test + dry-run.
                   A quick run never reports the gate as passed. Every
                   criterion clearing exits 2, so a wrapper reading exit
                   codes can tell a clean rehearsal (2) from a passed gate (0)
                   and from a failure (1).
  --config FILE    model registry (default config/models.json)
  --seed, --only-provider, --no-fallback, --key   as for run-all
`);
  process.exit(strong && weak ? 0 : 1);
}

const criteria = [];
let pool = null;
const scored = {};
const record = (name, ok, detail) => {
  criteria.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name} — ${detail}`);
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spread = (xs) => Math.max(...xs) - Math.min(...xs);

console.log(`\nMONKEY SEE / MONKEY DO · acceptance gate${quick ? " (QUICK REHEARSAL — cannot pass the gate)" : ""}`);
console.log(`  strong: ${strong}\n  weak:   ${weak}\n  runs:   ${runs} per model\n`);

// 1. Self-test, no pool regeneration (the gate itself runs the
//    regeneration nightly / on demand via npm run self-test:full).
console.log(`1. self-test...`);
try {
  const st = await runSelfTest({ log: () => {} });
  record("self-test passes", st.ok, st.ok ? `${st.passed} checks` : st.failures.join("; "));
  if (!st.ok) finish();
} catch (err) {
  record("self-test passes", false, String(err?.message ?? err));
  finish();
}

// 2. Reference solver wins every chain in the published pool.
try {
  pool = loadPublishedPool({});
  console.log(`\n2. dry run on ${pool.chains.length} chains...`);
  const dry = await runChainDo(null, {
    chains: pool.chains, seed: pool.seed, dryRun: true, modelText: REFERENCE_SOLVER_SOURCE,
  });
  const verdict = dryRunVerdict(dry);
  record("the reference solver wins every chain across all five bands",
    verdict.ok, `${dry.score.total}/${pool.chains.length}, ${verdict.failures.length} chain failures`);
} catch (err) {
  record("the reference solver wins every chain across all five bands", false, String(err?.message ?? err));
  finish();
}

// 3. Chain-naive (empty-array) submission scores 0 with engagement 0.
//    A solver that emits [] everywhere must score 0 on the chain portion
//    and the engagement must be exactly 0 — otherwise the clawback
//    fails to fire on the trivial "do nothing" submission, which the
//    Phase 5 adjusted formula was designed to prevent.
try {
  const naive = await runChainDo(null, {
    chains: pool.chains, seed: pool.seed, dryRun: true,
    modelText: "function solve(){ return []; }",
  });
  const engagement = chainEngagementRate(naive.score.perChain);
  const total = naive.score.total;
  // Adjusted with SEE=0, DO=0, gzMean=0, engagement=0 must equal 0
  // (raw = 0 - 0 - 10 = -10, clamped to 0).
  const adj = adjustedTotal({ seeTotal: 0, doTotal: total, gzMean: 0, chainEngagementRate: engagement });
  record("a chain-naive (empty) solver scores 0 with engagement=0",
    total === 0 && engagement === 0, `total=${total}, engagement=${engagement}`);
  record("an empty-solver adjusted total is 0 (the clawback fires)",
    adj.total === 0, `adjusted.total=${adj.total}`);
} catch (err) {
  record("a chain-naive (empty) solver scores 0 with engagement=0", false, String(err?.message ?? err));
  finish();
}

// 4. Per-band partition. The 5 bands (L5..L50) each carry 10 chains; the
//    pool must have exactly 50 chains split evenly. A regression that
//    breaks the pool's partition must fail the gate.
try {
  const bands = new Map();
  for (const c of pool.chains) {
    if (!bands.has(c.band)) bands.set(c.band, []);
    bands.get(c.band).push(c);
  }
  const bandSummary = Array.from(bands.entries()).map(([b, c]) => `${b}=${c.length}`).join(", ");
  record("each band carries exactly 10 chains",
    bands.size === 5 && Array.from(bands.values()).every((b) => b.length === 10), `bands: ${bandSummary}`);
} catch (err) {
  record("each band carries exactly 10 chains", false, String(err?.message ?? err));
  finish();
}

// 5 + 6. Score both models. A model that cannot be resolved, keyed or scored is
// a failed criterion, not a lost report.
for (const [role, model] of [["strong", strong], ["weak", weak]]) {
  console.log(`\n5. scoring the ${role} model, ${model}, ${runs} times...`);
  try {
    const { config } = await prepareModel({ ...common, model });
    const { runs: results, stability } = await runAll(config, {
      runs,
      pool,
      onProgress: (m) => console.log(`    ${m}`),
    });
    scored[role] = {
      model,
      see: results.map((r) => r.seeTotal),
      do: results.map((r) => r.doTotal),
      gzMean: results.map((r) => Math.round((r.see?.gzMean ?? 0) * 100)),
      engagement: results.map((r) => Number((r.chainEngagementRate ?? 0).toFixed(2))),
      adjusted: results.map((r) => r.adjusted),
      reproducible: stability ? { see: stability.seeReproducible, do: stability.doReproducible } : null,
    };
    const s = scored[role];
    console.log(`    SEE ${s.see.join(", ")} DO ${s.do.join(", ")} adjusted ${s.adjusted.join(", ")}`);
    if (runs >= 2) {
      record(`${role} model is stable across ${runs} runs (within 2 points on each eval)`,
        spread(s.see) <= 2 && spread(s.do) <= 2, `SEE spread ${spread(s.see)}, DO spread ${spread(s.do)}`);
    }
  } catch (err) {
    record(`the ${role} model could be scored`, false, String(err?.message ?? err).split("\n")[0]);
  }
}

console.log(`\n6. discrimination`);
// Both models must actually have been scored; a missing arm means the
// comparison cannot be made, which is a failed criterion, not a crash on
// undefined property access.
if (scored.strong && scored.weak) {
  record("the strong model outscores the weak one on SEE",
    mean(scored.strong.see) > mean(scored.weak.see), `${mean(scored.strong.see).toFixed(1)} vs ${mean(scored.weak.see).toFixed(1)}`);
  record("the strong model outscores the weak one on DO",
    mean(scored.strong.do) > mean(scored.weak.do), `${mean(scored.strong.do).toFixed(1)} vs ${mean(scored.weak.do).toFixed(1)}`);
} else {
  const missing = [!scored.strong && "strong", !scored.weak && "weak"].filter(Boolean).join(" and ");
  record("the gate compared both models", false, `the ${missing} model could not be scored, so there is nothing to compare`);
}
if (runs < 3) record("the acceptance gate requires three runs per model", false, `ran ${runs}`);

finish();

function finish() {
  const passed = criteria.every((c) => c.ok) && !quick;
  const report = {
    schema: "monkey-see-monkey-do/acceptance@2",
    date: new Date().toISOString(),
    quick,
    verdict: passed ? "PASS" : quick ? "REHEARSAL" : "FAIL",
    pool: { sha256: pool?.sha256 ?? null, full: pool?.full ?? null, seed: pool?.seed ?? null },
    criteria,
    models: scored,
    limitations: LIMITATIONS,
  };
  mkdirSync(common.out, { recursive: true });
  // Dated AND timed: a same-day re-run of the gate must not overwrite the
  // earlier evidence (writeFileSync truncates silently).
  const path = join(common.out, `acceptance-${report.date.slice(0, 10)}-${report.date.slice(11, 19).replace(/:/g, "")}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `\n  ${passed ? "\x1b[32m\x1b[1mGATE PASSED\x1b[0m — the suite may be published." : quick ? "\x1b[33mREHEARSAL\x1b[0m — rerun without --quick for a real verdict." : "\x1b[31m\x1b[1mGATE FAILED\x1b[0m — do not publish."}`
  );
  console.log(`  ${path}\n`);
  // Three outcomes, three exit codes: 0 PASS, 2 a clean rehearsal (all
  // criteria cleared but --quick), 1 anything else. A wrapper reading exit
  // codes used to be unable to tell a clean rehearsal from a passed gate.
  process.exit(passed ? 0 : quick && criteria.every((c) => c.ok) ? 2 : 1);
}