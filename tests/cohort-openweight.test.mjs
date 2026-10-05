// The Cohort 1 builder (scripts/build-cohort-openweight.py). There are no
// OpenRouter reports yet by design — the sweep has not run — so the property
// that matters now is that its absence is a LOUD, named failure rather than an
// empty or partial cohort file. A builder that emitted a chart from missing
// reports would publish a claim with no evidence behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs/openweight-frontier-models.json");

const runBuilder = () =>
  new Promise((resolve) => {
    const child = spawn("python3", [join(ROOT, "scripts/build-cohort-openweight.py")], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("the open-weight builder fails loudly when the cohort's reports are absent", async () => {
  // Guard against a future state where a report happens to exist: only assert
  // the loud-failure path when the first model's report is genuinely missing.
  const firstReport = join(ROOT, "results/combined-openrouter-qwen-qwen3.8-2.4t-a95b-2026-10-06-120000.json");
  const hadOut = existsSync(OUT);
  const r = await runBuilder();
  if (existsSync(firstReport)) {
    // Reports exist: the builder should have written the cohort instead.
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(OUT), "with reports present the builder must write the cohort");
  } else {
    assert.equal(r.code, 1, "absent reports must be a non-zero exit");
    assert.match(r.stderr, /no combined@5 report for openrouter\/qwen\/qwen3\.8-2\.4t-a95b/);
    assert.match(r.stderr, /run the sweep first/, "the error must say how to produce the reports");
    if (!hadOut) {
      assert.ok(!existsSync(OUT), "nothing may be written when the reports are absent");
    }
  }
});
