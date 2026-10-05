// The chart is a publication artifact: an input it cannot plot must fail
// loudly, not render NaN coordinates into a "successful" SVG.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "bin/chart.mjs"), ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("the committed cohort chart regenerates cleanly", async () => {
  const out = join(tmpdir(), `md-chart-${Date.now()}.svg`);
  const r = await run([join(ROOT, "docs/ollama-local-models.json"), out]);
  assert.equal(r.code, 0, r.stderr);
  const svg = readFileSync(out, "utf8");
  assert.match(svg, /<svg/);
  assert.ok(!svg.includes("NaN"), "no NaN coordinate may reach the SVG");
  assert.equal((svg.match(/<circle/g) ?? []).length, 5, "all five models plotted");
});

test("an empty points array is an error, not an empty chart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-chart-bad-"));
  const empty = join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify({ points: [] }));
  const r = await run([empty, join(dir, "out.svg")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no points array/);
  assert.ok(!existsSync(join(dir, "out.svg")), "nothing must be written on failure");
});

test("a point without numeric coordinates is named and refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-chart-bad-"));
  const malformed = join(dir, "bad.json");
  writeFileSync(malformed, JSON.stringify({ points: [{ model: "m1", paramsB: 7, adjusted: 55 }, { model: "m2", paramsB: 7 }] }));
  const r = await run([malformed, join(dir, "out.svg")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /m2 has no numeric adjusted/);
});

test("a hand-edited cohort using the wrong field names is refused", async () => {
  // paramsB/adjusted are the chart's contract; a cohort JSON renamed by hand
  // used to render NaN silently.
  const dir = mkdtempSync(join(tmpdir(), "md-chart-bad-"));
  const renamed = join(dir, "renamed.json");
  writeFileSync(renamed, JSON.stringify({ points: [{ model: "m", sizeB: 7, score: 55 }] }));
  const r = await run([renamed, join(dir, "out.svg")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no numeric paramsB/);
});

// --- x-axis mode: paramsB (local cohort) vs costUsd (frontier cohort) -----

test("a costUsd cohort with no paramsB draws, on a dollar axis", async () => {
  // The frontier cohort's x-axis is dollars per run, not parameters. A cohort
  // that declares costUsd must plot even when no point carries paramsB.
  const dir = mkdtempSync(join(tmpdir(), "md-chart-cost-"));
  const f = join(dir, "cost.json");
  writeFileSync(
    f,
    JSON.stringify({
      xAxis: "costUsd",
      points: [
        { model: "a", costUsd: 0.0021, adjusted: 38, color: "#111" },
        { model: "b", costUsd: 0.0046, adjusted: 44, color: "#222" },
        { model: "c", costUsd: 2.81, adjusted: 71, color: "#333" },
      ],
    })
  );
  const out = join(dir, "out.svg");
  const r = await run([f, out]);
  assert.equal(r.code, 0, r.stderr);
  const svg = readFileSync(out, "utf8");
  assert.ok(!svg.includes("NaN"), "no NaN coordinate may reach the SVG");
  assert.equal((svg.match(/<circle/g) ?? []).length, 3, "all three models plotted");
  assert.match(svg, /cost per run \(USD\)/, "the x-axis title names dollars");
});

test("a paramsB cohort still draws after the x-axis switch", async () => {
  // Regression guard: the local cohort's declared axis must keep working.
  const dir = mkdtempSync(join(tmpdir(), "md-chart-params-"));
  const f = join(dir, "params.json");
  writeFileSync(
    f,
    JSON.stringify({
      xAxis: "paramsB",
      points: [
        { model: "a", paramsB: 3, adjusted: 40, color: "#111" },
        { model: "b", paramsB: 7, adjusted: 50, color: "#222" },
      ],
    })
  );
  const out = join(dir, "out.svg");
  const r = await run([f, out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(out, "utf8"), /parameters \(billions\)/);
});

test("a costUsd cohort missing costUsd on a point is named and refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-chart-bad-"));
  const f = join(dir, "bad.json");
  writeFileSync(
    f,
    JSON.stringify({ xAxis: "costUsd", points: [{ model: "a", costUsd: 0.5, adjusted: 50 }, { model: "b", adjusted: 40 }] })
  );
  const r = await run([f, join(dir, "out.svg")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /b has no numeric costUsd/);
  assert.ok(!existsSync(join(dir, "out.svg")), "nothing must be written on failure");
});

test("an unknown xAxis is refused by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-chart-bad-"));
  const f = join(dir, "bad.json");
  writeFileSync(f, JSON.stringify({ xAxis: "flops", points: [{ model: "a", adjusted: 50 }] }));
  const r = await run([f, join(dir, "out.svg")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown xAxis "flops"/);
});
