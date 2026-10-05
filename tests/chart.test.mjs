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
