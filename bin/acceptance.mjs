// The publication gate — the criteria a run must clear before the suite ships.
//
//   node bin/acceptance.mjs --strong <model> --weak <model>
//
// "If any criterion fails, the eval is not published. An eval that does not
// discriminate is worse than no eval, because it manufactures false confidence."
//
// Checks, in order:
//
//   1. the full self-test passes, including regenerating the whole board pool
//      byte for byte (success criteria 1 and 4)
//   2. a dry run on the full pool scores 50/50: the reference solver wins every
//      Pool A board and stops correctly on every Pool B board
//   3. each model is scored `--runs` times (default 3) through the normal
//      run-all path, and its SEE and DO totals must agree within 2 points
//   4. the strong model outscores the weak one on BOTH evals
//
// Cost: 4 model calls per model per run (3 SEE + 1 DO), so 24 calls at the
// defaults. Writes results/acceptance-<date>.json.
//
// --quick skips the pool regeneration and plays a subset (--per-tier), for
// rehearsing the gate. A quick run can never report the gate as passed.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runSelfTest } from "../src/self-test.mjs";
import { runDo, loadPool, dryRunVerdict } from "../src/do/run.mjs";
import { runAll } from "../src/run-all.mjs";
import { parseArgs, prepareModel } from "../src/cli.mjs";
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
const common = parseArgs(argv.filter((a) => a !== "--quick"));
const runs = argv.includes("--runs") || argv.includes("-r") ? common.runs : 3;

if (!strong || !weak || common.help) {
  console.log(`
MONKEY SEE / MONKEY DO · acceptance gate (publication criteria)

  node bin/acceptance.mjs --strong <model> --weak <model> [--runs 3]

  --strong MODEL   a model known to be strong (e.g. a frontier model)
  --weak MODEL     a small model (e.g. ollama/qwen2.5-coder:7b)
  --runs N         runs per model (default 3; the gate requires 3)
  --quick          rehearsal: skip pool regeneration, play --per-tier boards.
                   A quick run never reports the gate as passed.
  --per-tier N     with --quick, boards per tier per pool
  --config FILE    model registry (default config/models.json)
  --seed, --only-provider, --no-fallback, --key   as for run-all
`);
  process.exit(strong && weak ? 0 : 1);
}

const criteria = [];
// Declared up front: finish() can run early (a failed self-test), and must be
// able to read these without hitting the temporal dead zone.
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

// 1. Self-test, with the full pool regeneration unless rehearsing.
console.log(`1. self-test${quick ? "" : " (with full pool regeneration — a few minutes)"}...`);
const st = await runSelfTest({ log: () => {}, full: !quick });
record("self-test passes", st.ok, st.ok ? `${st.passed} checks` : st.failures.join("; "));
if (!st.ok) finish();

// 2. Dry run on the pool.
pool = loadPool({ perTier: quick ? common.perTier ?? 2 : null });
console.log(`\n2. dry run on ${pool.boards.length} boards...`);
const dry = await runDo(null, { boards: pool.boards, seed: pool.seed, dryRun: true });
const verdict = dryRunVerdict(dry);
record("the reference solver wins every Pool A board and stops correctly on every Pool B board",
  verdict.ok && verdict.perfect, `${dry.score.total}/50, outcomes ${JSON.stringify(dry.score.outcomes)}`);

// 3 + 4. Score both models.
for (const [role, model] of [["strong", strong], ["weak", weak]]) {
  console.log(`\n3. scoring the ${role} model, ${model}, ${runs} times...`);
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
    monkeyIndex: results.map((r) => Math.round(r.see.index.index * 100)),
    reproducible: stability ? { see: stability.seeReproducible, do: stability.doReproducible } : null,
  };
  const s = scored[role];
  console.log(`    SEE ${s.see.join(", ")}   DO ${s.do.join(", ")}`);
  if (runs >= 2) {
    record(`${role} model is stable across ${runs} runs (within 2 points on each eval)`,
      spread(s.see) <= 2 && spread(s.do) <= 2, `SEE spread ${spread(s.see)}, DO spread ${spread(s.do)}`);
  }
}

console.log(`\n4. discrimination`);
record("the strong model outscores the weak one on SEE",
  mean(scored.strong.see) > mean(scored.weak.see), `${mean(scored.strong.see).toFixed(1)} vs ${mean(scored.weak.see).toFixed(1)}`);
record("the strong model outscores the weak one on DO",
  mean(scored.strong.do) > mean(scored.weak.do), `${mean(scored.strong.do).toFixed(1)} vs ${mean(scored.weak.do).toFixed(1)}`);
if (runs < 3) record("the acceptance gate requires three runs per model", false, `ran ${runs}`);

finish();

function finish() {
  const passed = criteria.every((c) => c.ok) && !quick;
  const report = {
    schema: "monkey-see-monkey-do/acceptance@1",
    date: new Date().toISOString(),
    quick,
    verdict: passed ? "PASS" : quick ? "REHEARSAL" : "FAIL",
    pool: { sha256: pool?.sha256 ?? null, full: pool?.full ?? null },
    criteria,
    models: scored,
    limitations: LIMITATIONS,
  };
  mkdirSync(common.out, { recursive: true });
  const path = join(common.out, `acceptance-${report.date.slice(0, 10)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `\n  ${passed ? "\x1b[32m\x1b[1mGATE PASSED\x1b[0m — the suite may be published." : quick ? "\x1b[33mREHEARSAL\x1b[0m — rerun without --quick for a real verdict." : "\x1b[31m\x1b[1mGATE FAILED\x1b[0m — do not publish."}`
  );
  console.log(`  ${path}\n`);
  process.exit(passed || (quick && criteria.every((c) => c.ok)) ? 0 : 1);
}
