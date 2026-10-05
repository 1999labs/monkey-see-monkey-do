process.env.FAKE_KEY = "fake-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSeeLevelsReport, writeSeeLevelsReport, buildChainDoReport, writeChainDoReport, computeCost, ratesTable, rateFor } from "../src/report.mjs";
import { runSee } from "../src/see/run.mjs";
import { groundTruth } from "../src/see/reference.mjs";
import { taskById } from "../src/see/tasks.mjs";
import { allPromptDigests } from "../src/see/prompt.mjs";

// The same injected-fake-fetch pattern as run.test.mjs: no API key, no network.
const fakeConfig = (answers) => ({
  endpoint: "https://fake.test/v1/chat/completions",
  model: "fake/model",
  apiKeyEnv: "FAKE_KEY",
  maxRetries: 0,
  seed: 42,
  provider: { only: ["AtlasCloud"], allowFallbacks: false },
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: answers.shift() }, finish_reason: "stop" }],
        model: "fake/model",
      }),
  }),
});

// A model that has learned nothing. Its own response is recorded as evidence.
const NAIVE = [
  "function f(n) { return n*n; }",
  "function f(s) { return s[0].toUpperCase() + s.slice(1); }",
  "function f(a) { return a.slice().sort((x,y)=>y-x)[a.length-2]; }",
];

// SEE report tests route through the new builder names. The schema
// monkey-see/report@2 and the per-task / per-run / per-level-8 layout are
// gone — monkey-see/levels@1 carries perLevel and perTask directly.
const syntheticLast = async () => {
  const { runAllLevels } = await import("../src/see/run-levels.mjs");
  return await runAllLevels(null, { dryRun: true });
};

test("report records the headline numbers from the run summary", async () => {
  const last = await syntheticLast();
  const r = buildSeeLevelsReport({
    model: "openrouter/dots-3-note-preview:free",
    last,
    reproducibility: null,
    config: { endpoint: "https://fake.test/v1/chat/completions", seed: 42, provider: { only: ["AtlasCloud"] } },
    keySource: "key file",
    runs: [],
  });
  assert.equal(r.schema, "monkey-see/levels@1");
  const expectedPoints = Object.values(last.perTask).reduce((s, t) => s + t.weightedRate * 15, 0);
  assert.ok(Math.abs(r.score.points - expectedPoints) < 1e-9, `r.score.points=${r.score.points} vs expected ${expectedPoints}`);
  assert.equal(r.score.robustnessPoints, last.robustness.points);
  assert.equal(r.score.total, Math.round(expectedPoints + last.robustness.points));
  assert.equal(r.score.maxTotal, 50);
  assert.equal(r.model.requested, "openrouter/dots-3-note-preview:free");
  assert.equal(r.score.robustness.max, 5);
  assert.equal(r.score.robustness.threw, last.robustness.threw);
  assert.equal(r.score.robustness.total, last.robustness.total);
  assert.equal(r.score.robustness.crashed, last.robustness.crashed);
});

test("report includes a SHA-256 for every task prompt", async () => {
  const last = await syntheticLast();
  const r = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: {}, runs: [] });
  const digests = allPromptDigests();
  assert.equal(r.prompts.length, digests.length);
  for (let i = 0; i < digests.length; i++) {
    assert.match(digests[i].digest, /^[0-9a-f]{64}$/);
            assert.equal(r.prompts[i].sha256, digests[i].digest);
            assert.equal(r.prompts[i].taskId, digests[i].taskId);
  }
});

test("report stores raw responses so a surprising score can be explained", async () => {
  const last = await syntheticLast();
  const runs = last.runs.map((out, i) => ({
    taskId: out.task.id,
    level: out.level,
    response: NAIVE[i % NAIVE.length],
    usable: out.out?.usable ?? true,
    seen: { correct: 5, total: out.level, rate: 5 / out.level },
    heldOut: { correct: 20, total: 50, rate: 0.4 },
    responseFingerprint: `fp${i}`,
  }));
  const r = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: {}, runs });
  assert.equal(r.runs.length, 12, "3 tasks × 4 levels");
  for (let i = 0; i < r.runs.length; i++) {
    assert.ok(r.runs[i].response);
    assert.equal(r.runs[i].responseFingerprint, `fp${i}`);
  }
});

test("NEITHER the key NOR any held-out answer can reach the report", async () => {
  const last = await syntheticLast();
  const r = buildSeeLevelsReport({
    model: "m", last, reproducibility: null,
    config: { apiKey: "sk-or-v1-pear-peach", seed: 42 },
    keySource: "env", runs: [],
  });
  const serialised = JSON.stringify(r);
  assert.ok(!serialised.includes("sk-or-v1"), "no key-shaped string may appear");
  assert.ok(!/"expected"/.test(serialised), "the report must not contain any \"expected\" field");
  for (const id of ["A", "B", "C"]) {
    const ref = groundTruth[id].reference;
    const shownKeys = new Set(taskById[id].shown.map((c) => JSON.stringify(c.input)));
    const heldOut = Object.values(taskById[id].heldOut).flat()
      .filter((input) => !shownKeys.has(JSON.stringify(input)));
    assert.ok(heldOut.length > 0);
    for (const input of heldOut.slice(0, 5)) {
      assert.ok(!serialised.includes(`"expected":${JSON.stringify(ref(input))}`));
    }
  }
});

test("temperature is not claimed honoured unless reproducibility proves it", () => {
  const baseLast = {
    perTask: {
      A: { taskId: "A", name: "A", levels: {}, weightedRate: 0.6, gzMean: 0 },
      B: { taskId: "B", name: "B", levels: {}, weightedRate: 0.6, gzMean: 0 },
      C: { taskId: "C", name: "C", levels: {}, weightedRate: 0.6, gzMean: 0 },
    },
    perLevel: {},
    robustness: { points: 5, threw: 0, total: 150, rate: 1, crashed: false },
  };
  const base = { model: "m", last: baseLast, config: {}, runs: [] };
  assert.equal(buildSeeLevelsReport({ ...base, reproducibility: null }).generation.temperatureHonoured, null);
  assert.equal(buildSeeLevelsReport({ ...base, reproducibility: { seeVerdict: "NOT_REPRODUCIBLE" } }).generation.temperatureHonoured, false);
  assert.equal(buildSeeLevelsReport({ ...base, reproducibility: { seeVerdict: "REPRODUCIBLE" } }).generation.temperatureHonoured, true);
  assert.equal(buildSeeLevelsReport({ ...base, reproducibility: { seeVerdict: "NO_VERDICT" } }).generation.temperatureHonoured, null);
});

test("writeSeeLevelsReport writes a dated, model-named JSON file", async () => {
  const last = await syntheticLast();
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-report-"));
  const r = buildSeeLevelsReport({ model: "openrouter/dots-3-note-preview:free", last, reproducibility: null, config: {}, runs: [] });
  const path = writeSeeLevelsReport(r, dir);
  assert.match(readdirSync(dir)[0], /^openrouter-dots-3-note-preview-free-.*\.json$/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, "monkey-see/levels@1");
});

test("a model id with path separators cannot escape the output directory", async () => {
  const last = await syntheticLast();
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-report-"));
  const r = buildSeeLevelsReport({ model: "../../etc/passwd", last, reproducibility: null, config: {}, runs: [] });
  const path = writeSeeLevelsReport(r, dir);
  assert.equal(readdirSync(dir).length, 1);
  assert.ok(path.startsWith(dir));
});

test("writeSeeLevelsReport refuses to clobber an existing report", async () => {
  const last = await syntheticLast();
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-clobber-"));
  const r = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: {}, runs: [] });
  writeSeeLevelsReport(r, dir);
  assert.throws(() => writeSeeLevelsReport(r, dir), /already exists, refusing to overwrite/);
});

test("overwrite: true replaces an existing report", async () => {
  const last = await syntheticLast();
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-overwrite-"));
  const r = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: {}, runs: [] });
  writeSeeLevelsReport(r, dir);
  writeSeeLevelsReport(r, dir, { overwrite: true });
  assert.equal(readdirSync(dir).length, 1);
});

test("writeChainDoReport and writeCombinedReport refuse to clobber too", () => {
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-clobber2-"));
  const perChain = [
    { band: "L5", id: 1, start: "AB", target: "BA", length: 2, score: 1, fullCredit: true, partial: false, steps: [{ rule: "R1", start: "AB", next: "BA" }], outcome: "filled" },
  ];
  const perBand = { L5: { score: 1, points: 10, max: 10, chains: [{ fullCredit: true }] } };
  const doReport = buildChainDoReport({
    model: "m",
    result: { score: { total: 50, perChain, perBand } },
    config: {},
    keySource: "env",
    pool: { chains: [], full: true, seed: 0xC0FFEE, sha256: "test", chainsSha256: "test2" },
  });
  writeChainDoReport(doReport, dir);
  assert.throws(() => writeChainDoReport(doReport, dir), /refusing to overwrite/);

  const combined = { model: { requested: "m" }, timestamp: new Date().toISOString() };
  writeCombinedReport(combined, dir);
  assert.throws(() => writeCombinedReport(combined, dir), /refusing to overwrite/);
  assert.equal(readdirSync(dir).length, 2, "one DO and one combined, neither replaced");
});

// --- Limitations and the combined report -----------------------------------

import { LIMITATIONS, buildCombinedReport, writeCombinedReport } from "../src/report.mjs";

test("every SEE report carries the full limitations list", async () => {
  const last = await syntheticLast();
  const r = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: {}, runs: [] });
  assert.deepEqual(r.limitations, LIMITATIONS);
  const text = LIMITATIONS.join(" ");
  assert.match(text, /saturates/i);
  assert.match(text, /Not a coding benchmark/);
});

test("a SEE report states what the config says about temperature", async () => {
  const last = await syntheticLast();
  const unknown = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: { supportsTemperatureZero: null }, runs: [] });
  assert.equal(unknown.generation.temperatureControl.supported, null);
  const refused = buildSeeLevelsReport({ model: "m", last, reproducibility: null, config: { supportsTemperatureZero: false, temperatureOverride: true }, runs: [] });
  assert.equal(refused.generation.temperatureControl.comparable, false);
  assert.match(refused.generation.temperatureControl.statement, /NOT comparable/);
});

test("the combined report adds up, and follows the required section order", async () => {
  const see = await syntheticLast();
  const doo = {
    score: {
      total: 38,
      perChain: Array(38).fill({ fullCredit: true, partial: false }).concat(Array(12).fill({ fullCredit: false, partial: false })),
      perBand: {},
    },
  };
  const r = buildCombinedReport({
    model: "openrouter/x",
    config: { supportsTemperatureZero: true },
    keySource: "env",
    see,
    doo,
    pool: { sha256: "abc", full: true },
    reading: ["line"],
  });
  assert.equal(r.combined.total, r.see.total + 38);
  assert.equal(r.combined.max, 100);
  // Schema is at 0. Section order is fixed and pinned by the test.
  assert.deepEqual(Object.keys(r).slice(1, 9), [
    "eval",
    "timestamp",
    "model",
    "date",
    "temperature",
    "callFailure",
    "see",
    "do",
  ]);
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-combined-"));
  const path = writeCombinedReport(r, dir);
  assert.match(path, /combined-openrouter-x-/);
});

test("the combined report carries route failures, so a zero is never a plain zero", () => {
  // A DO timeout used to reach the COMMITTED file as a bare do.total: 0 with no
  // indication the call never returned. The per-eval report that carries the
  // detail is gitignored, so the combined report must carry it too.
  const r = buildCombinedReport({
    model: "openrouter/x",
    config: {},
    keySource: "env",
    see: {
      perTask: {
        A: { weightedRate: 0, gzMean: 0 },
        B: { weightedRate: 0, gzMean: 0 },
        C: { weightedRate: 0, gzMean: 0 },
      },
      perLevel: {
        "2": { seen: { correct: 0, total: 50, rate: 0 }, heldOut: { correct: 0, total: 50, rate: 0 }, gz: 0 },
        "4": { seen: { correct: 0, total: 50, rate: 0 }, heldOut: { correct: 0, total: 50, rate: 0 }, gz: 0 },
        "8": { seen: { correct: 0, total: 50, rate: 0 }, heldOut: { correct: 0, total: 50, rate: 0 }, gz: 0 },
        "16": { seen: { correct: 0, total: 50, rate: 0 }, heldOut: { correct: 0, total: 50, rate: 0 }, gz: 0 },
      },
      robustness: { points: 0 },
      runs: [
        { taskId: "A", level: 8, callFailure: { reason: "timeout", message: "Request timed out after 420000ms", elapsedMs: 420001 } },
      ],
    },
    doo: {
      score: {
        total: 0,
        perChain: [{ fullCredit: false, partial: false }],
        perBand: { L5: { score: 0, points: 0, max: 10, chains: [] }, L10: { score: 0, points: 0, max: 10, chains: [] }, L20: { score: 0, points: 0, max: 10, chains: [] }, L30: { score: 0, points: 0, max: 10, chains: [] }, L50: { score: 0, points: 0, max: 10, chains: [] } },
      },
      callFailure: {
        reason: "timeout",
        message: "Request timed out after 420000ms",
        elapsedMs: 420001,
        timeoutMs: 420000,
        attempts: 1,
      },
    },
    pool: { sha256: "abc", full: true },
    reading: ["line"],
  });
  assert.equal(r.schema, "monkey-see-monkey-do/combined@5");
  assert.equal(r.callFailure.do.reason, "timeout");
  assert.equal(r.callFailure.do.attempts, 1);
  assert.equal(r.callFailure.do.timeoutMs, 420000);
  assert.equal(r.callFailure.seeCount, 1);
  // And a run without failures carries an empty block, not a missing one.
  const clean = buildCombinedReport({
    model: "x",
    config: {},
    keySource: "env",
    see: {
      perTask: { A: { weightedRate: 1, gzMean: 0 }, B: { weightedRate: 1, gzMean: 0 }, C: { weightedRate: 1, gzMean: 0 } },
      perLevel: {},
      robustness: { points: 5 },
      runs: [],
    },
    doo: {
      score: { total: 50, perChain: Array(50).fill({ fullCredit: true, partial: false }), perBand: {} },
    },
    pool: { sha256: "abc", full: true },
    reading: ["line"],
  });
  assert.equal(clean.callFailure.seeCount, 0);
  assert.equal(clean.callFailure.do, null);
});

test("with runs > 1 the combined headline is the median, not the last run", async () => {
  // Measured failure this replaces: unpinned -r 3 gave DO 21, 50, 50, and the
  // run that happened to be last became the committed number.
  const see = await runSee(fakeConfig([...NAIVE]));
  // Build a per-level/per-task shape from the legacy `see` object — we keep
  // the test from the pre-pivot era but route the data through the new
  // combined report shape.
  const perTask = {};
  for (const t of see.taskRuns) perTask[t.taskId] = { weightedRate: t.result ? (t.result.correct / t.result.total) : 0, gzMean: 0 };
  const doo = {
    score: {
      total: 50,
      perChain: Array(50).fill({ fullCredit: true, partial: false }),
      perBand: { L5: { score: 1, points: 10, max: 10, chains: Array(10).fill({}) }, L10: { score: 1, points: 10, max: 10, chains: Array(10).fill({}) }, L20: { score: 1, points: 10, max: 10, chains: Array(10).fill({}) }, L30: { score: 1, points: 10, max: 10, chains: Array(10).fill({}) }, L50: { score: 1, points: 10, max: 10, chains: Array(10).fill({}) } },
    },
  };
  const r = buildCombinedReport({
    model: "x",
    config: {},
    keySource: "env",
    see: { perTask, perLevel: {}, robustness: { points: 5 }, runs: [] },
    doo,
    pool: { sha256: "abc", full: true },
    reading: ["line"],
    stability: { seeTotals: [21, 40, 40], doTotals: [21, 50, 50] },
  });
  // The medians determine the combined headline.
  assert.equal(r.see.total, 40, "median of [21, 40, 40] is 40, whatever the last run scored");
  assert.equal(r.do.total, 50, "median of [21, 50, 50] is 50");
  assert.deepEqual(r.stability.seeTotals, [21, 40, 40], "every per-run total stays in the file");
});

// -------------------------------------------------------------
// Phase 8 tripwires (Fix 1 + Fix 2):
//
// (a) An all-unusable SEE run must serialise a report with rate:null
//     fields, not crash the report writer. This is the exact failure
//     the gpt-6-luna smoke run hit before the half-guarded mapper
//     was fixed.
// (b) computeCost emits exactly one of four labels:
//     pay-per-token | subscription-estimate | local | unpriced.
// -------------------------------------------------------------

test("an all-unusable SEE run serialises with rate:null fields, no crash", async () => {
  // Simulate the gpt-6-luna smoke state: every per-level entry has
  // no usable runs, so run-levels.mjs leaves rate unset on seen and
  // heldOut, and gz undefined. The pre-fix mapper threw at the
  // unguarded .toFixed call; the post-fix mapper writes null everywhere.
  const last = {
    perTask: {
      A: { taskId: "A", name: "A", levels: {}, weightedRate: 0, gzMean: 0 },
      B: { taskId: "B", name: "B", levels: {}, weightedRate: 0, gzMean: 0 },
      C: { taskId: "C", name: "C", levels: {}, weightedRate: 0, gzMean: 0 },
    },
    perLevel: {
      2:  { seen: null, heldOut: null },
      4:  { seen: null, heldOut: null },
      8:  { seen: null, heldOut: null },
      16: { seen: null, heldOut: null },
    },
    robustness: { points: 0, max: 5, threw: 0, total: 0, rate: 0, crashed: false },
    runs: [],
    usage: null,
  };
  const r = buildSeeLevelsReport({ model: "gogo/gpt-6-luna", last, config: {}, keySource: "env" });
  // The mapper must not throw, AND every perLevel rate is null:
  for (const lvl of ["2", "4", "8", "16"]) {
    const pe = r.score.perLevel[lvl];
    assert.ok(pe, "perLevel[" + lvl + "] must exist");
    assert.equal(pe.seen, null, "seen must be null when no usable runs");
    assert.equal(pe.heldOut, null, "heldOut must be null when no usable runs");
    assert.equal(pe.gz, null, "gz must be null when undefined");
    assert.equal(pe.usageIn, 0);
    assert.equal(pe.usageOut, 0);
  }
});

test("computeCost emits subscription-estimate for a Go run with usage but no model.price", () => {
  const config = { adapter: "openai", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", model: { model: "gpt-6-luna" } };
  const usage = { prompt_tokens: 1000000, completion_tokens: 500000 };
  const r = computeCost(config, usage);
  // $0.10/1M prompt + $0.50/1M completion = $0.10 + $0.25 = $0.35
  assert.equal(r.pricing, "subscription-estimate");
  assert.equal(r.costUsd, 0.35, "1000000 prompt * 0.10 + 500000 completion * 0.50 = 0.35 USD");
});

test("computeCost emits pay-per-token for an OpenRouter run with usage and a rates-table entry", () => {
  // The Phase 9 cohort: OpenRouter is pay-per-token, and the rate comes from
  // the committed config/openrouter-rates.json rather than config/models.json.
  // A run with usage and a table entry must produce a NON-NULL costUsd — this
  // is the pin that would have caught the pre-fix "unpriced"/null stamp.
  const config = {
    adapter: "openai",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "z-ai/glm-5.3", // openRouterConfig stores the id as a bare string
  };
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  const r = computeCost(config, usage);
  // $0.05/1M prompt + $7.00/1M completion = 0.05 + 7.00 = 7.05
  assert.equal(r.pricing, "pay-per-token");
  assert.notEqual(r.costUsd, null, "an OpenRouter run with usage + a table entry must price");
  assert.equal(r.costUsd, 7.05, "1000000 * 0.05/1M + 1000000 * 7.00/1M = 7.05 USD");
});

test("computeCost routes OpenRouter to pay-per-token, not subscription-estimate", () => {
  // The label follows the GATEWAY, not the presence of a rate: the same model
  // id served by a subscription route would be an estimate, but OpenRouter is
  // metered, so it is the real price. A regression that dropped the source
  // routing would mislabel every frontier row.
  const or = computeCost(
    { adapter: "openai", endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "z-ai/glm-5.3" },
    { prompt_tokens: 1000, completion_tokens: 1000 }
  );
  const go = computeCost(
    { adapter: "openai", endpoint: "https://opencode.ai/zen/go/v1/chat/completions", model: { model: "gpt-6-luna" } },
    { prompt_tokens: 1000, completion_tokens: 1000 }
  );
  assert.equal(or.pricing, "pay-per-token");
  assert.equal(go.pricing, "subscription-estimate");
});

test("rateFor resolves an OpenRouter slug from the committed table and misses cleanly", () => {
  const hit = rateFor("z-ai/glm-5.3", { source: "openrouter" });
  assert.ok(hit, "the Phase 9 cohort's models must be in the committed table");
  assert.equal(hit.inputPer1M, 0.05);
  assert.equal(hit.outputPer1M, 7.0);
  // Every cohort member must resolve, or a run would stamp unpriced.
  for (const id of [
    "qwen/qwen3.8-2.4t-a95b",
    "deepseek/deepseek-v4.1-flash",
    "z-ai/glm-5.3",
    "xiaomi/mimo-v2.6-pro",
    "tencent/hy4-preview",
  ]) {
    assert.ok(rateFor(id, { source: "openrouter" }), `${id} must resolve a rate`);
  }
  assert.equal(rateFor("not/a-real-model", { source: "openrouter" }), null);
});

test("the committed OpenRouter rates table carries its as-of date", () => {
  // Rates drift; a costUsd is only auditable against a dated row.
  const t = ratesTable("openrouter");
  assert.ok(t._asOf, "the table must carry an as-of date");
  assert.match(t._asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(t._source, "https://openrouter.ai/api/v1/models");
});

test("computeCost emits pay-per-token when model.price is on the host", () => {
  const config = { adapter: "openai", model: { price: { inputPer1k: 0.003, outputPer1k: 0.015 } } };
  const usage = { prompt_tokens: 1000, completion_tokens: 500 };
  const r = computeCost(config, usage);
  // 1000 * 0.003/1000 + 500 * 0.015/1000 = 0.003 + 0.0075 = 0.0105
  assert.equal(r.pricing, "pay-per-token");
  assert.equal(r.costUsd, 0.0105);
});

test("computeCost emits local for Ollama regardless of usage", () => {
  const config = { adapter: "ollama", model: { model: "qwen2.5-coder:7b" } };
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
  const r = computeCost(config, usage);
  assert.equal(r.pricing, "local");
  assert.equal(r.costUsd, null);
});

test("computeCost emits unpriced when usage exists but no model.price and no rates-table entry", () => {
  const config = { adapter: "openai", model: { model: "no-such-model-xyz" } };
  const usage = { prompt_tokens: 100, completion_tokens: 50 };
  const r = computeCost(config, usage);
  assert.equal(r.pricing, "unpriced");
  assert.equal(r.costUsd, null);
});

test("computeCost emits unpriced when usage is null regardless of pricing", () => {
  // Use a non-Ollama adapter so we exercise the null-usage branch of
  // the function (the Ollama branch returns "local" before null is
  // checked, by design — Ollama always reports "local").
  const config = { adapter: "openai", model: { model: "gpt-6-luna" } };
  const r = computeCost(config, null);
  assert.equal(r.pricing, "unpriced");
  assert.equal(r.costUsd, null);
});

test("ratesTable returns the committed table and rateFor is case-insensitive", () => {
  const t = ratesTable();
  assert.ok(t.models, "ratesTable must expose models");
  assert.ok(t.models["gpt-6-luna"], "ratesTable must contain gpt-6-luna");
  assert.equal(rateFor("gpt-6-luna").inputPer1M, 0.10);
  // Case-insensitive lookup:
  assert.equal(rateFor("GPT-6-LUNA").inputPer1M, 0.10);
  // Unknown model returns null, not throw.
  assert.equal(rateFor("no-such-model"), null);
  // Empty / null model returns null.
  assert.equal(rateFor(null), null);
  assert.equal(rateFor(""), null);
});
