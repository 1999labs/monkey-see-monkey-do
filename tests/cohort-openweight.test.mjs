// The Cohort 1 builder (scripts/build-cohort-openweight.py).
//
// Two behaviours matter, and which one is live depends on whether the sweep has
// run in this checkout:
//
//   reports absent (fresh clone, pre-sweep) -> LOUD, named failure, no file
//   reports present (post-sweep)            -> writes the cohort, and every
//                                              point carries the honesty flags
//                                              that keep a route-failed DO zero
//                                              from reading as a model score
//
// The earlier version of this test guarded on one hard-coded filename that
// never existed, so it always asserted the failure branch and broke the moment
// the sweep produced reports. It now detects the real state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESULTS = join(ROOT, "results");
const OUT = join(ROOT, "docs/openweight-frontier-models.json");

// The cohort's five model slugs, as src/report.mjs would slug them.
const COHORT_SLUGS = [
  "openrouter-qwen-qwen3.8-27b",
  "openrouter-deepseek-deepseek-v4.1-flash",
  "openrouter-z-ai-glm-5.3",
  "openrouter-xiaomi-mimo-v2.6-pro",
  "openrouter-tencent-hy3",
];

const reportsPresent = () =>
  COHORT_SLUGS.every((slug) =>
    readdirSync(RESULTS).some((f) => f.startsWith(`combined-${slug}-`) && f.endsWith(".json"))
  );

const runBuilder = () =>
  new Promise((resolve) => {
    const child = spawn("python3", [join(ROOT, "scripts/build-cohort-openweight.py")], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("the open-weight builder matches the checkout state, loudly in both directions", async () => {
  const present = reportsPresent();
  const r = await runBuilder();

  if (!present) {
    // Fresh clone before a sweep: refuse, name the missing report, say how to
    // produce it, and write nothing.
    assert.equal(r.code, 1, "absent reports must be a non-zero exit");
    assert.match(r.stderr, /no combined@5 report for openrouter\//);
    assert.match(r.stderr, /run the sweep first/, "the error must say how to produce the reports");
    assert.ok(!existsSync(OUT) || r.stdout === "", "nothing may be written when the reports are absent");
    return;
  }

  // Post-sweep: it must write the cohort.
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(OUT), "with reports present the builder must write the cohort");

  const cohort = JSON.parse(readFileSync(OUT, "utf8"));
  assert.equal(cohort.xAxis, "costUsd", "Cohort 1 plots dollars per run, not parameters");
  assert.equal(cohort.points.length, 5, "all five cohort models must be present");

  for (const p of cohort.points) {
    assert.ok(p.costUsd > 0, `${p.model} must carry a measured cost`);
    assert.equal(typeof p.doRouteFailed, "boolean", `${p.model} must state whether its DO call returned`);
    assert.equal(typeof p.costComplete, "boolean", `${p.model} must state whether its cost is complete`);
    assert.ok("adjustedComparable" in p, `${p.model} must state whether its adjusted figure is comparable`);
    // The two are the same fact: a route-failed DO means the adjusted figure
    // inherits a zero and is not a model reading.
    assert.equal(
      p.adjustedComparable,
      !p.doRouteFailed,
      `${p.model}: adjustedComparable must agree with doRouteFailed`
    );
    if (p.doRouteFailed) {
      assert.equal(p.do, 0, `${p.model}: a route-failed DO must read 0`);
      assert.ok(p.doFailureReason, `${p.model}: a route failure must name its reason`);
      assert.equal(p.doFullCreditChains, null, `${p.model}: no fullCredit claim from a failed call`);
    }
  }

  // The cohort must state the DO situation at the top level, so a reader who
  // only opens the JSON cannot miss it.
  assert.ok(cohort.doMeasurementCaveat, "the cohort must carry the DO caveat");
  const failed = cohort.points.filter((p) => p.doRouteFailed).length;
  assert.match(
    cohort.doMeasurementCaveat,
    new RegExp(`${failed} of 5 models`),
    "the caveat must count the route-failed models"
  );
});


test("each cohort point's host matches the committed rate table's row for that model", async () => {
  // The defect this pins: the builder spec hardcoded "DeepSeek" for
  // deepseek/deepseek-v4.1-flash while the rate table, the README table and the
  // run's own generation.providerPin all said DeepInfra. The cohort's whole
  // claim is "pinned to one host, so the number is a measurement", so a chart
  // naming the host that served nothing cannot be audited.
  //
  // The invariant is checked against the RATE TABLE, not against a per-eval
  // report: the per-eval reports are gitignored, so a test that read them would
  // silently pass in a fresh clone. Both the cohort JSON and the rate table are
  // committed, and they are the two places the host is named.
  const cohortPath = join(ROOT, "docs/openweight-frontier-models.json");
  const ratesPath = join(ROOT, "config/openrouter-rates.json");
  if (!existsSync(cohortPath) || !existsSync(ratesPath)) return;
  const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
  const rates = JSON.parse(readFileSync(ratesPath, "utf8"));

  for (const point of cohort.points) {
    // The cohort stores the CLI id ("openrouter/vendor/slug"); the rate table is
    // keyed by the bare model id ("vendor/slug").
    const bare = point.model.replace(/^openrouter\//, "");
    const row = rates.models[bare];
    assert.ok(row, `${point.label}: no rate-table row for ${bare}`);
    assert.equal(
      point.provider,
      row.provider,
      `${point.label}: the cohort names host "${point.provider}" but the rate table (which priced the run) says "${row.provider}"`
    );
  }
});
