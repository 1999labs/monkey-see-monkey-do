// Diagnostic: WHY do results move between runs?
//
// The stability check reports a spread but not a cause. Two very different
// explanations produce the same symptom:
//
//   1. the endpoint is genuinely non-deterministic (routed free tier,
//      quantisation varying between backends) — the model's fault
//   2. our own harness is non-deterministic — our bug
//
// Only (1) is acceptable, and we cannot tell them apart without looking at
// what the model actually returned. This script runs each task N times,
// saves the raw response, and reports whether identical inputs produced
// identical outputs.
//
//   node bin/diagnose.mjs -m openrouter/dots-3-note-preview:free -r 3
//
// It costs N x 3 model calls.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveModel, complete } from "../src/adapters/registry.mjs";
import { tasks } from "../src/see/tasks.mjs";
import { buildPrompt, promptDigest } from "../src/see/prompt.mjs";
import { compileCandidate, runCandidate } from "../src/sandbox.mjs";
import { scoreTask } from "../src/see/score.mjs";
import { describeCallFailure } from "../src/call-failure.mjs";
import { printVerdict } from "../src/fingerprint.mjs";
import { resolveKey } from "../src/key.mjs";

const parseArgs = (argv) => {
  const args = { runs: 3, model: null, key: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--key" || a === "-k") args.key = argv[++i];
    else if (a === "--runs" || a === "-r") args.runs = Number(argv[++i]) || 3;
  }
  return args;
};

const shortHash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error("usage: node bin/diagnose.mjs -m <provider/model> [-r 3]");
    process.exit(1);
  }
  const config = resolveModel(args.model);
  let source = "not required";
  if (config.apiKeyEnv) {
    const found = await resolveKey(config.apiKeyEnv, { flagValue: args.key });
    if (!found.key) {
      console.error(`no API key found for ${config.apiKeyEnv} — see: npm run see -- --help`);
      process.exit(1);
    }
    process.env[config.apiKeyEnv] = found.key;
    source = found.source;
  }
  console.log(`\nDIAGNOSE ${args.model}`);
  console.log(`key from: ${source}`);
  console.log(`running each task ${args.runs} time(s) with an identical prompt\n`);

  const save = { model: args.model, promptDigest: {}, responses: [] };

  // Dated AND named per model, written after every task: a diagnostic run is
  // exactly the thing a flaky endpoint will interrupt, and the first version
  // serialized only at the very end — so the evidence it existed to collect
  // was lost to the very instability it was diagnosing. It also overwrote one
  // fixed responses.json on every run.
  const slug = args.model.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const outPath = fileURLToPath(new URL(`../results/diagnose-${slug}-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url));
  const writeOut = () => {
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(save, null, 2));
    } catch {
      console.log(`Could not write ${outPath} (directory may not be writable).`);
    }
  };

  for (const task of tasks) {
    const promptText = buildPrompt(task);
    save.promptDigest[task.id] = promptDigest(task);
    console.log(`--- Task ${task.id} ---`);

    const hashes = []; // one per ANSWERED run; a failed run contributes nothing
    let failed = 0;
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`  run ${i + 1}: `);
      // One failed call is DATA — the reason and the wait are the diagnostic —
      // not a reason to throw away every response collected so far.
      let completion = null;
      let failure = null;
      const startedAt = Date.now();
      try {
        completion = await complete(config, promptText);
      } catch (err) {
        failure = describeCallFailure(err, { startedAt, timeoutMs: config?.timeoutMs ?? null });
      }
      if (failure) {
        failed++;
        console.log(`CALL FAILED (${failure.reason} after ${(failure.elapsedMs / 1000).toFixed(1)}s): ${String(failure.message).slice(0, 120)}`);
        save.responses.push({ taskId: task.id, run: i + 1, callFailure: failure, text: "" });
        writeOut();
        continue;
      }

      const compiled = compileCandidate(completion.text, { entry: "f", isolateCalls: true });
      const h = shortHash(completion.text);
      hashes.push(h);

      let score = "n/a";
      if (compiled.ok) {
        const fn = (input) => {
          const r = runCandidate(compiled, input);
          if (!r.ok) throw new Error(r.error);
          return r.value;
        };
        const s = scoreTask(task, fn);
        score = `${s.correct}/50 (${Math.round(s.rate * 100)}%)  throws=${s.threw}`;
      } else {
        score = `UNUSABLE: ${compiled.error}`;
      }

      console.log(`${score}  response#${h}`);

      save.responses.push({ taskId: task.id, run: i + 1, hash: h, text: completion.text, score });
      writeOut();
    }

    // "Identical" means every ANSWERED run produced the SAME hash. An earlier
    // version only flagged a repeat (three DIFFERENT responses reported as
    // IDENTICAL), and counting failed runs' empty responses would certify
    // three timeouts as identical answers — the same confluence the main
    // suite's reproducibility check had to be fixed against.
    const verdict = printVerdict(hashes);
    if (verdict === null) {
      console.log(`  => NO ANSWERED RUN (${failed} of ${args.runs} call(s) failed). Nothing to compare.`);
    } else if (verdict === "REPRODUCIBLE") {
      console.log(`  => IDENTICAL every answered run (${new Set(hashes).size} distinct response).`);
    } else {
      console.log(
        `  => RESPONSE DIFFERS between runs (${new Set(hashes).size} distinct of ${hashes.length}).\n` +
          `     The endpoint returned different code for the same prompt, so any\n` +
          `     score difference is the endpoint's, not ours.`
      );
    }
    console.log("");
  }

  writeOut();
  console.log(`Saved raw responses to ${outPath}`);
  console.log(
    "\nIf every response is identical and scores still move, the harness is at fault.\n" +
      "If responses differ, temperature 0 is not being honoured upstream and no score\n" +
      "from this endpoint is comparable to any other."
  );
};

main().catch((err) => {
  console.error(`\nSomething went wrong: ${err?.message ?? err}\n`);
  process.exit(1);
});
