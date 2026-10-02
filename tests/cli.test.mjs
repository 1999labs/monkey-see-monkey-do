// End-to-end tests of the three command-line runners, as a user runs them.
//
// Each test spawns the real script with a stubbed network (tests/fixtures/
// stub-fetch.mjs, loaded via --import) that answers every prompt correctly. So
// these exercise everything a unit test cannot: argument parsing, the
// self-test gate, model resolution, key loading, both evals, and report
// writing — and they are the regression tests for the DO runner crashing with
// "source is not defined" after every real run, which no unit test could see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STUB = fileURLToPath(new URL("./fixtures/stub-fetch.mjs", import.meta.url));

const run = (script, args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", STUB, script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const readReport = (dir, prefix) => {
  const file = readdirSync(dir).find((f) => f.startsWith(prefix));
  assert.ok(file, `no ${prefix}* report in ${dir}: ${readdirSync(dir).join(", ")}`);
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
};

test("the CLI runners work end to end, write their reports, and score a correct model perfectly", async () => {
  const doDir = mkdtempSync(join(tmpdir(), "md-cli-do-"));
  const allDir = mkdtempSync(join(tmpdir(), "md-cli-all-"));
  const seeDir = mkdtempSync(join(tmpdir(), "md-cli-see-"));
  const log = join(seeDir, "requests.jsonl");

  // Run concurrently: each child pays for the self-test gate.
  const [doRun, allRun, seeRun] = await Promise.all([
    run("src/do/run.mjs", ["-m", "openrouter/stub-model", "--key", "sk-test", "--per-tier", "1", "--out", doDir]),
    run("src/run-all.mjs", ["-m", "openrouter/stub-model", "--key", "sk-test", "--per-tier", "1", "--out", allDir]),
    // Ollama needs no key at all.
    run("src/see/run.mjs", ["-m", "ollama/stub-model", "-s", "7", "--out", seeDir], { STUB_FETCH_LOG: log }),
  ]);

  // --- DO: the crash regression -------------------------------------------
  assert.equal(doRun.code, 0, `DO run failed:\n${doRun.stdout}\n${doRun.stderr}`);
  assert.doesNotMatch(doRun.stderr + doRun.stdout, /is not defined/);
  const doReport = readReport(doDir, "do-");
  assert.equal(doReport.score.total, 50, "a correct solver must score 50/50 on the subset");
  assert.equal(doReport.pool.full, false, "a --per-tier run is marked as a subset");
  assert.equal(doReport.generation.keySource, "--key flag");
  assert.ok(doReport.limitations.length >= 4);

  // --- run-all: three reports and a combined 100 --------------------------
  assert.equal(allRun.code, 0, `run-all failed:\n${allRun.stdout}\n${allRun.stderr}`);
  assert.match(allRun.stdout, /combined 100\/100/);
  const combined = readReport(allDir, "combined-");
  assert.equal(combined.combined.total, 100);
  assert.equal(combined.see.total, 50);
  assert.equal(combined.do.total, 50);
  // The order of a report's sections is fixed, and pinned by the tests below.
  assert.deepEqual(
    Object.keys(combined).slice(0, 8),
    ["schema", "model", "date", "temperature", "callFailure", "see", "do", "limitations"],
    "sections must appear in the order the report contract requires"
  );
  assert.ok(readReport(allDir, "openrouter-stub-model-").limitations.length >= 4, "the SEE report carries limitations too");

  // --- SEE over Ollama ------------------------------------------------------
  assert.equal(seeRun.code, 0, `SEE run failed:\n${seeRun.stdout}\n${seeRun.stderr}`);
  const seeReport = readReport(seeDir, "ollama-stub-model-");
  assert.equal(seeReport.score.total, 50, "prose-wrapped and console.log-laden correct answers must still score");
  assert.equal(seeReport.generation.keySource, "not required");
  const requests = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(requests.length, 3);
  for (const { url, body } of requests) {
    assert.match(url, /localhost:11434\/api\/chat/);
    assert.equal(body.options.temperature, 0);
    assert.equal(body.options.seed, 7);
    assert.equal(body.stream, false);
  }
});

test("a model configured without temperature-0 support is refused unless the awkward flag is passed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-cli-temp-"));
  const config = join(dir, "models.json");
  const log = join(dir, "requests.jsonl");
  writeFileSync(
    config,
    JSON.stringify({
      models: {
        "hot/model": {
          adapter: "openai",
          endpoint: "https://hot.example/v1/chat/completions",
          model: "model",
          apiKeyEnv: "HOT_API_KEY",
          supportsTemperatureZero: false,
        },
      },
    })
  );
  const args = ["-m", "hot/model", "--config", config, "--key", "sk-test", "--out", dir];
  const [refused, allowed] = await Promise.all([
    run("src/see/run.mjs", args),
    run("src/see/run.mjs", [...args, "--i-cannot-control-temperature"], { STUB_FETCH_LOG: log }),
  ]);

  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--i-cannot-control-temperature/);
  assert.match(refused.stderr, /not comparable/);

  assert.equal(allowed.code, 0, allowed.stderr);
  const report = readReport(dir, "hot-model-");
  assert.equal(report.generation.temperatureControl.supported, false);
  assert.equal(report.generation.temperatureControl.comparable, false);
  assert.equal(report.generation.temperatureControl.override, true);
  // The parameter is omitted rather than sent: such endpoints reject it.
  const bodies = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).body);
  for (const b of bodies) assert.equal(b.temperature, undefined);
});

test("a dry run passes its safety gate and scores 50/50", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-cli-dry-"));
  const r = await run("src/do/run.mjs", ["--dry-run", "--per-tier", "2", "--out", dir]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PASS/);
  assert.match(r.stdout, /50\/50/);
  const report = readReport(dir, "do-dry-run");
  assert.equal(report.model.dryRun, true);
  assert.equal(report.score.outcomes.detonation ?? 0, 0);
  assert.equal(report.score.outcomes.unproven_move ?? 0, 0);
});

test("the acceptance gate survives a setup failure mid-run and still writes its report", async () => {
  // The regression: prepareModel used to process.exit on an unknown model, so
  // a gate that died scoring the strong model wrote NO report at all —
  // indistinguishable from a gate nobody ran, and it lost the self-test and
  // dry-run evidence already collected.
  const dir = mkdtempSync(join(tmpdir(), "md-cli-accept-fail-"));
  const r = await run("bin/acceptance.mjs", [
    "--strong", "no-such-provider/model", "--weak", "openrouter/stub-weak",
    "--quick", "--per-tier", "1", "--runs", "2", "--key", "sk-test", "--out", dir,
  ]);
  assert.equal(r.code, 1, "a gate with a failed criterion exits non-zero");
  assert.match(r.stdout, /the strong model could be scored/);
  assert.match(r.stdout, /the gate compared both models/);
  const report = readReport(dir, "acceptance-");
  const byName = Object.fromEntries(report.criteria.map((c) => [c.name, c.ok]));
  assert.equal(byName["self-test passes"], true, "the earlier evidence is not lost");
  assert.equal(byName["the strong model could be scored"], false, "the setup failure is recorded");
  assert.equal(byName["the gate compared both models"], false, "the missing arm is named");
});

test("the acceptance gate rehearses end to end and tells a strong model from a weak one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-cli-accept-"));
  const r = await run("bin/acceptance.mjs", [
    "--strong", "openrouter/stub-strong", "--weak", "openrouter/stub-weak",
    "--quick", "--per-tier", "1", "--runs", "2", "--key", "sk-test", "--out", dir,
  ]);
  const report = readReport(dir, "acceptance-");
  assert.equal(report.verdict, "REHEARSAL", "a --quick run can never pass the gate");
  const byName = Object.fromEntries(report.criteria.map((c) => [c.name, c.ok]));
  assert.equal(byName["the strong model outscores the weak one on SEE"], true, JSON.stringify(report.models));
  assert.equal(byName["the strong model outscores the weak one on DO"], true, JSON.stringify(report.models));
  assert.equal(byName["the acceptance gate requires three runs per model"], false, "two runs must be flagged as short of the requirement");
  assert.equal(r.code, 1, "an unmet criterion fails the rehearsal too");
  assert.deepEqual(report.models.strong.see, [50, 50]);
  assert.ok(report.models.weak.see.every((t) => t < 30), `a surface-fit strategy should land near the naive band: ${report.models.weak.see}`);
});
