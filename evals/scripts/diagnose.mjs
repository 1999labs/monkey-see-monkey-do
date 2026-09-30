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
//   node scripts/diagnose.mjs -m openrouter/dots-3-note-preview:free -r 3
//
// It costs N x 3 model calls.

import { writeFileSync } from "node:fs";

import { resolveModel, complete } from "../src/adapters/registry.mjs";
import { tasks } from "../src/see/tasks.mjs";
import { buildPrompt, promptDigest } from "../src/see/prompt.mjs";
import { compileCandidate, runCandidate } from "../src/sandbox.mjs";
import { scoreTask } from "../src/see/score.mjs";
import { resolveKey } from "../src/see/key.mjs";

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
    console.error("usage: node scripts/diagnose.mjs -m <provider/model> [-r 3]");
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

  for (const task of tasks) {
    const promptText = buildPrompt(task);
    save.promptDigest[task.id] = promptDigest(task);
    console.log(`--- Task ${task.id} ---`);

    const hashes = []; // one per run
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`  run ${i + 1}: `);
      const completion = await complete(config, promptText);
      const compiled = compileCandidate(completion.text, { entry: "f" });
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
    }

    // "Identical" means every run produced the SAME hash. An earlier version
    // of this script only flagged a repeat, so three DIFFERENT responses were
    // reported as IDENTICAL — inverting the entire finding.
    const distinct = new Set(hashes);
    const identical = distinct.size === 1;
    console.log(
      identical
        ? `  => IDENTICAL every run (${distinct.size} distinct response).`
        : `  => RESPONSE DIFFERS between runs (${distinct.size} distinct of ${hashes.length}).\n` +
            `     The endpoint returned different code for the same prompt, so any\n` +
            `     score difference is the endpoint's, not ours.`
    );
    console.log("");
  }

  const out = new URL("../results/responses.json", import.meta.url);
  try {
    writeFileSync(out, JSON.stringify(save, null, 2));
    console.log(`Saved raw responses to ${out.pathname}`);
  } catch {
    console.log("Could not write results/responses.json (directory may not exist).");
  }
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
