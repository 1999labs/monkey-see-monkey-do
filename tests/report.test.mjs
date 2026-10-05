process.env.FAKE_KEY = "fake-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSeeLevelsReport, writeSeeLevelsReport, buildChainDoReport, writeChainDoReport } from "../src/report.mjs";
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
