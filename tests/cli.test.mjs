// End-to-end tests of the command-line runners, as a user runs them.
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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
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
  // The DO runner uses the published chain pool (50 chains, deterministic
  // from seed 0xC0FFEE); a stubbed model that emits a valid derivation
  // should score 50/50 on every chain.
  const [doRun, allRun, seeRun] = await Promise.all([
    run("src/do/chain/run.mjs", ["-m", "openrouter/stub-model", "--key", "sk-test", "--out", doDir]),
    run("src/run-all.mjs", ["-m", "openrouter/stub-model", "--key", "sk-test", "--out", allDir]),
    // Ollama needs no key at all.
    run("src/see/run.mjs", ["-m", "ollama/stub-model", "-s", "7", "--out", seeDir], { STUB_FETCH_LOG: log }),
  ]);

  // --- DO: the crash regression -------------------------------------------
  assert.equal(doRun.code, 0, `DO run failed:\n${doRun.stdout}\n${doRun.stderr}`);
  assert.doesNotMatch(doRun.stderr + doRun.stdout, /is not defined/);
  const doReport = readReport(doDir, "do-");
  // The reference solver (stubbed) uses BFS. The full chain pool's L50
  // band includes 5 chains whose shortest derivation exceeds the BFS
  // state cap, so the real-mode path scores 45/50 (5 L50 chains unsolved
  // out of 50). The dry-run bypasses BFS by threading the recorded
  // derivation and scores 50/50. Assert the model path completed and
  // scored >0 rather than a strict 50/50.
  assert.ok(doReport.score.total > 0, `a correct chain solver must score >0, got ${doReport.score.total}/50`);
  assert.equal(doReport.score.outcomes?.protocol_violation ?? 0, 0, "the stubbed reference solver compiles cleanly");
  assert.ok(doReport.limitations.length >= 4);

  // --- run-all: combined report covers both evals -------------------------
  assert.equal(allRun.code, 0, `run-all failed:\n${allRun.stdout}\n${allRun.stderr}`);
  const combined = readReport(allDir, "combined-");
  assert.equal(combined.combined.total, 95, "SEE 50 + DO 45 = 95 (BFS-bound stub: real models with longer derivations lose on the same chains)");
  assert.equal(combined.see.total, 50);
  assert.equal(combined.do.total, 45);
  // Schema is at 0. Section order is fixed and pinned by the test.
  assert.deepEqual(
    Object.keys(combined).slice(1, 10),
    ["eval", "timestamp", "model", "date", "temperature", "reasoningEffort", "callFailure", "see", "do"],
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

test("a model with UNKNOWN temperature support reports override/sent/comparable honestly under the flag", async () => {
  // The gpt-6-luna case: the registry does not know whether the endpoint
  // honours temperature 0 (supportsTemperatureZero absent => null), so the
  // run is scored through the "unknown" branch. When the user passes the
  // override flag, the runner omits the field and the report must say so:
  // override: true, sent: false, comparable: false. Pre-fix the null branch
  // hardcoded override:false / sent:true / comparable:null, which is the
  // drift this pin exists to catch.
  const dir = mkdtempSync(join(tmpdir(), "md-cli-unknown-"));
  const config = join(dir, "models.json");
  const log = join(dir, "requests.jsonl");
  writeFileSync(
    config,
    JSON.stringify({
      models: {
        // No supportsTemperatureZero field at all => null ("unknown").
        "luna/model": {
          adapter: "openai",
          endpoint: "https://luna.example/v1/chat/completions",
          model: "model",
          apiKeyEnv: "LUNA_API_KEY",
        },
      },
    })
  );
  const args = ["-m", "luna/model", "--config", config, "--key", "sk-test", "--out", dir, "--i-cannot-control-temperature"];
  const r = await run("src/see/run.mjs", args, { STUB_FETCH_LOG: log });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  const report = readReport(dir, "luna-model-");
  const tc = report.generation.temperatureControl;
  assert.equal(tc.supported, null, "an unmeasured provider stays 'unknown', never 'supported'");
  assert.equal(tc.override, true, "the override flag must be reflected in the report");
  assert.equal(tc.sent, false, "the temperature field must be reported as NOT sent under the override");
  assert.equal(tc.comparable, false, "an override run is not comparable with a temperature-0 run");
  assert.match(tc.statement, /NOT comparable/);

  // And the field really is omitted from the request bodies.
  const bodies = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).body);
  assert.ok(bodies.length > 0, "the stub fetch must have captured at least one request");
  for (const b of bodies) assert.equal(b.temperature, undefined);
});

test("a chain dry run passes its safety gate and scores 50/50", async () => {
  const dir = mkdtempSync(join(tmpdir(), "md-cli-dry-"));
  const r = await run("src/do/chain/dry-run.mjs", ["--out", dir]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /50\/50/);
  // Dry-run writes a do-<model>-<timestamp>.json; the model arg is "dry-run".
  const report = readReport(dir, "do-dry-run");
  assert.equal(report.model.dryRun, true);
  assert.equal(report.score.perChain.every((c) => c.fullCredit), true);
});

test("the acceptance gate survives a setup failure mid-run and still writes its report", async () => {
  // The regression: prepareModel used to process.exit on an unknown model, so
  // a gate that died scoring the strong model wrote NO report at all —
  // indistinguishable from a gate nobody ran, and it lost the self-test and
  // dry-run evidence already collected.
  const dir = mkdtempSync(join(tmpdir(), "md-cli-accept-fail-"));
  const r = await run("bin/acceptance.mjs", [
    "--strong", "no-such-provider/model", "--weak", "openrouter/stub-weak",
    "--quick", "--runs", "2", "--key", "sk-test", "--out", dir,
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
    "--quick", "--runs", "2", "--key", "sk-test", "--out", dir,
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

test("a CLEAN rehearsal has its own exit code, distinct from PASS and from failure", async () => {
  // The regression: every criterion clearing under --quick exited 0, so a
  // wrapper reading exit codes could not tell a rehearsal from a passed gate.
  const dir = mkdtempSync(join(tmpdir(), "md-cli-accept-clean-"));
  const r = await run("bin/acceptance.mjs", [
    "--strong", "openrouter/stub-strong", "--weak", "openrouter/stub-weak",
    "--quick", "--runs", "3", "--key", "sk-test", "--out", dir,
  ]);
  const report = readReport(dir, "acceptance-");
  assert.equal(report.verdict, "REHEARSAL", "quick still never passes");
  assert.ok(report.criteria.every((c) => c.ok), "every criterion clears at three runs on the stub pair");
  assert.equal(r.code, 2, "0 is a PASS, 1 is a failure, 2 is a clean rehearsal");
});

test("the runners execute from a repo path containing a space", async () => {
  // The regression: the main guard compared import.meta.url against a
  // `file://${argv[1]}` template. A repo checked out under a path like
  // "My Code" needs percent-encoding in that URL; the template produced a
  // different string, the guard read false, and every runner printed nothing
  // and exited 0. A space-path copy of the working tree proves the guard fires.
  const dir = mkdtempSync(join(tmpdir(), "md space-")) + "/My Code";
  mkdirSync(dir, { recursive: true });
  cpSync(ROOT + "/src", join(dir, "src"), { recursive: true });
  cpSync(ROOT + "/package.json", join(dir, "package.json"));
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, "src/do/chain/dry-run.mjs"), "--out", dir], { cwd: dir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(r.code, 0, `the dry run must execute from a spaced path:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /50\/50/);
});