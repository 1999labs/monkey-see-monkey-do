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

test("the chart is white with no grid or score bands", async () => {
  // Publication styling: a plain white background, the two axis lines, the
  // dashed reference ceiling, and nothing else ruling the plot. Score bands and
  // gridlines were removed because they competed with the points.
  const out = join(tmpdir(), `md-chart-clean-${Date.now()}.svg`);
  const r = await run([join(ROOT, "docs/ollama-local-models.json"), out]);
  assert.equal(r.code, 0, r.stderr);
  const svg = readFileSync(out, "utf8");
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/, "white background");
  // No shaded band rects (a band carried fill-opacity; the background does not).
  assert.equal((svg.match(/<rect[^>]*fill-opacity/g) ?? []).length, 0, "no score bands");
  // Only the x-axis, the y-axis, and the dashed ceiling: three <line> elements.
  assert.equal((svg.match(/<line/g) ?? []).length, 3, "two axis lines plus the ceiling, no grid");
  assert.ok(!svg.includes('stroke-opacity="0.14"'), "the old gridlines are gone");
});

test("no score label is drawn beside a dot, and no two names overlap", async () => {
  // The score lives in the cohort tables; repeating it beside each dot crowded
  // the names. And names must be laid out so none is printed over another.
  const out = join(tmpdir(), `md-chart-names-${Date.now()}.svg`);
  const r = await run([join(ROOT, "docs/ollama-local-models.json"), out]);
  assert.equal(r.code, 0, r.stderr);
  const svg = readFileSync(out, "utf8");
  // A bare integer in the plot area would be a score label; the only bare
  // integers are the axis ticks (font-size 16), so font-size 15 must be absent.
  assert.ok(!svg.includes('font-size="15"'), "no score label beside the dots");

  // Every model name is present, and no two name boxes overlap.
  const names = ["gemma2:2b", "llama3.2:3b", "deepseek-coder:6.7b", "mistral:7b-instruct", "qwen2.5-coder:7b"];
  const boxes = [];
  for (const n of names) {
    const m = svg.match(new RegExp(`<text\\b([^>]*)>${n.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}</text>`));
    assert.ok(m, `${n} is labelled`);
    const attrs = m[1];
    const x = Number(attrs.match(/x="([\d.]+)"/)[1]);
    const y = Number(attrs.match(/y="([\d.]+)"/)[1]);
    const fs = Number(attrs.match(/font-size="([\d.]+)"/)[1]);
    const anchor = attrs.match(/text-anchor="(\w+)"/)[1];
    const w = n.length * fs * 0.58;
    const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    boxes.push({ n, l: left, r: left + w, t: y - fs, b: y });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = !(a.r < b.l || a.l > b.r || a.b < b.t || a.t > b.b);
      assert.ok(!overlap, `${a.n} and ${b.n} must not overlap`);
    }
  }
});

test("an oversized point label is flipped inside the canvas, not clipped", async () => {
  // A start-anchored label on the rightmost point used to run off the right
  // edge at the larger font sizes. It must flip to the other side of its dot.
  const dir = mkdtempSync(join(tmpdir(), "md-chart-label-"));
  const f = join(dir, "label.json");
  writeFileSync(
    f,
    JSON.stringify({
      xAxis: "costUsd",
      points: [
        { model: "cheap", costUsd: 0.01, adjusted: 40, color: "#111" },
        { model: "a-very-long-model-name-here", costUsd: 1.0, adjusted: 60, color: "#222" },
      ],
    })
  );
  const out = join(dir, "out.svg");
  const r = await run([f, out]);
  assert.equal(r.code, 0, r.stderr);
  const svg = readFileSync(out, "utf8");
  const m = svg.match(/<text[^>]*>a-very-long-model-name-here<\/text>/);
  assert.ok(m, "the label is present");
  assert.match(m[0], /text-anchor="end"/, "the overflowing label was flipped to the left of its dot");
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
