process.env.FAKE_KEY = "fake-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReport, writeReport, buildDoReport, writeDoReport } from "../src/report.mjs";
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

test("report records the headline numbers from the run summary", async () => {
  const last = await runSee(fakeConfig([...NAIVE]));
  const r = buildReport({
    model: "openrouter/dots-3-note-preview:free",
    taskRuns: last.taskRuns,
    last,
    indices: [15, 20, 31],
    reproducibility: null,
    config: { endpoint: "https://fake.test/v1/chat/completions", seed: 42, provider: { only: ["AtlasCloud"] } },
    keySource: "key file",
    startedAt: new Date().toISOString(),
  });
  assert.equal(r.schema, "monkey-see/report@2");
  assert.equal(r.score.points, last.points);
  // The report rounds the bonus to 4dp for readability, so compare against the
  // rounded value rather than asserting bit-equality on a float.
  assert.equal(r.score.noCrash, Number(last.noCrash.toFixed(4)));
  assert.equal(r.score.total, Math.round(last.points + last.noCrash));
  assert.equal(r.score.maxTotal, 50);
  assert.deepEqual(r.score.perRunGeneralizationIndex, [15, 20, 31]);
  assert.equal(r.model.requested, "openrouter/dots-3-note-preview:free");
  // Robustness detail, and the categorical flag kept separate from the score.
  assert.equal(r.score.robustness.points, Number(last.robustness.points.toFixed(4)));
  assert.equal(r.score.robustness.max, 5);
  assert.equal(r.score.robustness.threw, last.robustness.threw);
  assert.equal(r.score.robustness.total, 150);
  assert.equal(r.score.robustness.crashed, last.robustness.threw > 0);
});

test("report includes a SHA-256 for every task prompt", () => {
  const r = buildReport({ model: "m", taskRuns: [], last: null, indices: [], reproducibility: null, config: {} });
  const digests = allPromptDigests();
  assert.equal(r.prompts.length, digests.length);
  for (let i = 0; i < digests.length; i++) {
    assert.match(digests[i].digest, /^[0-9a-f]{64}$/, `${digests[i].taskId} digest must be a real SHA-256`);
    assert.equal(r.prompts[i].sha256, digests[i].digest, `${digests[i].taskId} digest must match`);
    assert.equal(r.prompts[i].taskId, digests[i].taskId);
  }
});

test("report stores raw responses so a surprising score can be explained", async () => {
  const last = await runSee(fakeConfig([...NAIVE]));
  const r = buildReport({ model: "m", taskRuns: last.taskRuns, last, indices: [], reproducibility: null, config: {} });
  assert.equal(r.tasks.length, 3);
  for (let i = 0; i < r.tasks.length; i++) {
    assert.equal(r.tasks[i].response, NAIVE[i]);
    assert.ok(r.tasks[i].responseFingerprint.length > 0);
    assert.equal(r.tasks[i].usable, true);
    assert.equal(r.tasks[i].heldOut.total, 50);
  }
});

test("NEITHER the key NOR any held-out answer can reach the report", async () => {
  const last = await runSee(fakeConfig([...NAIVE]));
  const secret = "sk-or-v1-SECRET-should-never-appear";
  const r = buildReport({
    model: "m",
    taskRuns: last.taskRuns,
    last,
    indices: [],
    reproducibility: null,
    // The adapter config can carry a key in principle. It must not be copied.
    config: { apiKey: secret, key: secret, seed: 42 },
    keySource: "env",
  });
  const serialised = JSON.stringify(r);
  assert.ok(!serialised.includes(secret), "the API key must never be written to results");
  assert.ok(!serialised.includes("sk-or-v1"), "no key-shaped string may appear");
  // Stronger than checking values: the key itself must never appear either.
  assert.ok(!/"expected"/.test(serialised), 'the report must not contain any "expected" field');

  // Held-out answers are derived at runtime, so they are never in the file.
  // Sample failures are recorded, so this checks the real risk: that recording
  // them quietly wrote the answer key alongside the inputs.
  for (const t of r.tasks) {
    for (const f of t.heldOut.sampleFailures) {
      assert.ok("input" in f && "got" in f, "a sample failure must record input and got");
      assert.ok(!("expected" in f), "a sample failure must NOT record the expected value");
    }
  }

  // And no held-out answer is inferable: run the reference ourselves and check
  // the report never spells out the pairing.
  for (const id of ["A", "B", "C"]) {
    const ref = groundTruth[id].reference;
    const shownKeys = new Set(taskById[id].shown.map((c) => JSON.stringify(c.input)));
    const heldOut = Object.values(taskById[id].heldOut)
      .flat()
      .filter((input) => !shownKeys.has(JSON.stringify(input)));
    assert.ok(heldOut.length > 0, `task ${id} should have held-out cases`);
    for (const input of heldOut.slice(0, 5)) {
      assert.ok(
        !serialised.includes(`"expected":${JSON.stringify(ref(input))}`),
        `held-out answer for task ${id} on ${JSON.stringify(input)} leaked into the report`
      );
    }
  }
});

test("temperature is not claimed honoured unless reproducibility proves it", () => {
  const base = { model: "m", taskRuns: [], last: null, indices: [], config: {} };
  // No reproducibility check at all -> must be null, not true.
  assert.equal(buildReport({ ...base, reproducibility: null }).generation.temperatureHonoured, null);
  // Checked and found unstable -> false.
  const unstable = buildReport({
    ...base,
    reproducibility: {
      reproducible: false,
      verdict: "NOT_REPRODUCIBLE",
      perTask: { A: { distinct: 3, runs: 3, failedRuns: 0, prints: [] } },
    },
  });
  assert.equal(unstable.generation.temperatureHonoured, false);
  assert.equal(unstable.reproducibility.verdict, "NOT_REPRODUCIBLE");
  // Checked and stable -> true.
  const stable = buildReport({
    ...base,
    reproducibility: {
      reproducible: true,
      verdict: "REPRODUCIBLE",
      perTask: { A: { distinct: 1, runs: 3, failedRuns: 0, prints: [] } },
    },
  });
  assert.equal(stable.generation.temperatureHonoured, true);
  assert.equal(stable.reproducibility.verdict, "REPRODUCIBLE");
  // No answered pair to compare -> unknown, which is null, not false.
  const noVerdict = buildReport({
    ...base,
    reproducibility: {
      reproducible: false,
      verdict: null,
      perTask: { A: { distinct: 0, runs: 0, failedRuns: 3, prints: [] } },
    },
  });
  assert.equal(noVerdict.generation.temperatureHonoured, null);
  assert.equal(noVerdict.reproducibility.verdict, "NO_VERDICT");
  assert.equal(noVerdict.reproducibility.perTask.A.failedRuns, 3);
});

test("writeReport writes a dated, model-named JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-report-"));
  const r = buildReport({ model: "openrouter/dots-3-note-preview:free", taskRuns: [], last: null, indices: [], reproducibility: null, config: {} });
  const path = writeReport(r, dir);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^openrouter-dots-3-note-preview-free-.*\.json$/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, "monkey-see/report@2");
});

test("a model id with path separators cannot escape the output directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-report-"));
  const r = buildReport({ model: "../../etc/passwd", taskRuns: [], last: null, indices: [], reproducibility: null, config: {} });
  const path = writeReport(r, dir);
  assert.equal(readdirSync(dir).length, 1, "must not write outside the chosen directory");
  assert.ok(path.startsWith(dir), `wrote to ${path}, expected under ${dir}`);
});

test("writeReport refuses to clobber an existing report", () => {
  // Two runs of the same model in the same second share a filename, and
  // writeFileSync truncates. For a combined report that is committed evidence,
  // so the collision silently discarded a score. Fail loudly instead.
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-clobber-"));
  const r = buildReport({ model: "m", taskRuns: [], last: null, indices: [], reproducibility: null, config: {} });
  const first = writeReport(r, dir);
  assert.throws(
    () => writeReport(r, dir),
    /already exists, refusing to overwrite/,
    "a second report at the same path must not silently replace the first"
  );
  assert.equal(readdirSync(dir).length, 1, "the original file must survive");
  assert.equal(readFileSync(first, "utf8").length > 0, true);
});

test("overwrite: true replaces an existing report", () => {
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-overwrite-"));
  const r = buildReport({ model: "m", taskRuns: [], last: null, indices: [], reproducibility: null, config: {} });
  writeReport(r, dir);
  writeReport(r, dir, { overwrite: true });
  assert.equal(readdirSync(dir).length, 1, "an explicit overwrite replaces rather than adds");
});

test("writeDoReport and writeCombinedReport refuse to clobber too", () => {
  const dir = mkdtempSync(join(tmpdir(), "monkeydo-clobber2-"));
  const boardResults = [{ pool: "A", tier: "poolA-small", attempt: 1, outcome: "won", calls: 3 }];
  const doReport = buildDoReport({
    model: "m",
    result: { boardResults, score: { total: 0 } },
    config: {},
    keySource: "env",
    pool: { boards: [], full: false, seed: 1, sha256: "test" },
    baseline: {},
  });
  writeDoReport(doReport, dir);
  assert.throws(() => writeDoReport(doReport, dir), /refusing to overwrite/);

  const combined = { model: { requested: "m" }, date: new Date().toISOString() };
  writeCombinedReport(combined, dir);
  assert.throws(() => writeCombinedReport(combined, dir), /refusing to overwrite/);
  assert.equal(readdirSync(dir).length, 2, "one DO and one combined, neither replaced");
});

// --- Limitations and the combined report -----------------------------------

import { LIMITATIONS, buildCombinedReport, writeCombinedReport } from "../src/report.mjs";

test("every SEE report carries the full limitations list", () => {
  const r = buildReport({ model: "m", taskRuns: [], last: null, indices: [], reproducibility: null, config: {} });
  assert.deepEqual(r.limitations, LIMITATIONS);
  const text = LIMITATIONS.join(" ");
  assert.match(text, /saturates/i);
  assert.match(text, /Not a coding benchmark/);
});

test("a SEE report states what the config says about temperature", () => {
  const unknown = buildReport({ model: "m", taskRuns: [], last: null, indices: [], reproducibility: null, config: { supportsTemperatureZero: null } });
  assert.equal(unknown.generation.temperatureControl.supported, null);
  const refused = buildReport({ model: "m", taskRuns: [], last: null, indices: [], reproducibility: null, config: { supportsTemperatureZero: false, temperatureOverride: true } });
  assert.equal(refused.generation.temperatureControl.comparable, false);
  assert.match(refused.generation.temperatureControl.statement, /NOT comparable/);
});

test("the combined report adds up, and follows the required section order", async () => {
  const see = await runSee(fakeConfig([...NAIVE]));
  const doo = {
    score: {
      total: 38,
      poolA: { won: 0.9, noDetonation: 1 },
      poolB: { correctStop: 0.2 },
      index: { "poolA-small": 0.9 },
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
  assert.deepEqual(Object.keys(r).slice(1, 8), [
    "model",
    "date",
    "temperature",
    "callFailure",
    "see",
    "do",
    "limitations",
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
      points: 0,
      noCrash: 0,
      index: { index: 0, heldOut: 0 },
      seen: { rate: 0 },
      reading: "",
      taskRuns: [
        {
          taskId: "A",
          callFailure: { reason: "timeout", message: "Request timed out after 420000ms", elapsedMs: 420001 },
        },
      ],
    },
    doo: {
      score: {
        total: 0,
        poolA: { won: 0, noDetonation: 0 },
        poolB: { correctStop: 0 },
        index: {},
      },
      callFailure: {
        reason: "timeout",
        message: "Request timed out after 420000ms",
        elapsedMs: 420001,
        timeoutMs: 420000,
        attempts: 1,
      },
      progressIndex: null,
    },
    pool: { sha256: "abc", full: true },
    reading: ["line"],
  });
  assert.equal(r.schema, "monkey-see-monkey-do/combined@4");
  assert.equal(r.callFailure.do.reason, "timeout");
  assert.equal(r.callFailure.do.attempts, 1);
  assert.equal(r.callFailure.do.timeoutMs, 420000);
  assert.equal(r.callFailure.see.length, 1);
  assert.equal(r.callFailure.see[0].taskId, "A");
  assert.equal(r.callFailure.see[0].reason, "timeout");
  // And a run without failures carries an empty block, not a missing one.
  const clean = buildCombinedReport({
    model: "x",
    config: {},
    keySource: "env",
    see: { points: 40, noCrash: 5, index: { index: 0, heldOut: 0.8 }, seen: { rate: 0.9 }, reading: "", taskRuns: [] },
    doo: {
      score: { total: 38, poolA: { won: 0.9, noDetonation: 1 }, poolB: { correctStop: 0.2 }, index: {} },
      progressIndex: null,
    },
    pool: { sha256: "abc", full: true },
    reading: ["line"],
  });
  assert.deepEqual(clean.callFailure.see, []);
  assert.equal(clean.callFailure.do, null);
});

test("with runs > 1 the combined headline is the median, not the last run", async () => {
  // Measured failure this replaces: unpinned -r 3 gave DO 21, 50, 50, and the
  // run that happened to be last became the committed number.
  const see = await runSee(fakeConfig([...NAIVE]));
  const doo = {
    score: {
      total: 50,
      poolA: { won: 0.9, noDetonation: 1 },
      poolB: { correctStop: 0.2 },
      index: { "poolA-small": 0.9 },
    },
    progressIndex: null,
  };
  const r = buildCombinedReport({
    model: "x",
    config: {},
    keySource: "env",
    see,
    doo,
    pool: { sha256: "abc", full: true },
    reading: ["line"],
    stability: { seeTotals: [21, 40, 40], doTotals: [21, 50, 50] },
  });
  assert.equal(r.see.total, 40, "median of [21, 40, 40] is 40, whatever the last run scored");
  assert.equal(r.do.total, 50, "median of [21, 50, 50] is 50");
  assert.equal(r.combined.total, 90);
  assert.equal(r.adjusted.base, 90);
  assert.deepEqual(r.stability.seeTotals, [21, 40, 40], "every per-run total stays in the file");
});
