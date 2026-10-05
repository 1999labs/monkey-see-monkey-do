// MONKEY DO — run the eval against a model.
//
//   node src/do/chain/run.mjs --model openrouter/<model-id>
//
// ONE API CALL per run. The model is asked for a solve() function once, and
// that function is replayed across all 50 chains in the published pool.
// That is what makes DO cheap to run repeatedly: cost is per-run, not per-
// chain.
//
// The outcomes are the substance of the eval, and conflating any of them
// would destroy the signal:
//
//   fullCredit   every step replayed is rule-applicable AND the final state
//                equals the chain's target. Worth 1.0 of chain score.
//   partial      some steps replayed, but the chain failed mid-way (a wrong
//                step at position k, or never reached the target). Worth
//                correctSteps/submittedSteps.
//   empty        the model returned []. Worth 0; not a protocol violation.
//   protocol_violation  the model's text did not compile to a solve function.
//                       Not a reasoning signal.

import { complete } from "../../adapters/registry.mjs";
import { compileCandidate, runCandidate } from "../../sandbox.mjs";
import { fingerprint } from "../../fingerprint.mjs";
import { describeCallFailure } from "../../call-failure.mjs";
import { parseArgs, prepareModel, selfTestGate, temperatureNotice } from "../../cli.mjs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { buildPrompt, checkCanary } from "./prompt.mjs";
import { loadPublishedPool } from "./pool.mjs";
import { scoreRun, chainIdOf, isEmpty } from "./score.mjs";

/** Per-chain call timeout for the model's solve() function.
 *
 * The reference solver's BFS visits up to MAX_STATES (50000) states on the
 * longest chains; on this machine that's ~2s, and worst-case ~2s is well
 * inside this cap. The cap protects against two distinct failure modes:
 *   (a) an INFINITE-LOOP solver — the qwen2.5-coder:7b Stage 1 smoke
 *       test emitted `while (current !== target) { current = next; }`
 *       with no upper bound, so any chain that doesn't reach target
 *       runs forever. A wall-clock cap kills it.
 *   (b) a slow-but-progressing solver. The reference solver itself
 *       is fast on every chain, but the test is load-bearing for any
 *       future model that needs longer.
 *
 * Stage 1.5 attempted 30000ms; the model emitted an unbounded global-
 * replace solver that grew the heap past V8's 4 GB limit in ~4 minutes
 * and the process was killed with `Reached heap limit Allocation
 * failed`. 10000ms is the highest value tested that does not OOM
 * against the qwen failure mode. A future model that emits a
 * correctly-bounded solver can use a higher value via
 * config/models.json's timeoutMs; the in-source default stays low
 * because an unbounded solver IS the most common Stage 1 failure mode.
 *
 * This cap is load-bearing — see docs/calibration.md §8.
 */
export const CALL_TIMEOUT_MS = 10000;

/**
 * Play the model against every chain in the pool.
 *
 * Compiles the model's text once, then for each chain calls solve(start, target)
 * and validates the returned derivation. Returns the per-chain result and the
 * aggregate score.
 *
 * `passReference` (default false): when true, the harness threads the chain's
 * recorded derivation as the third argument to the model's solve function.
 * This is the dry-run path — the reference solver emits the recorded steps
 * verbatim, and the gate passes deterministically. Real model calls always
 * pass `false`; a model that emits the recorded steps could only do so by
 * deriving them itself, because the harness never reveals the reference
 * to a real submission.
 *
 * @param {object} compiled   { ok: true, call, ... } or { ok: false, error }
 * @param {Array}  chains     [{ band, attempt, start, target, steps, ... }, ...]
 * @param {boolean} passReference  dry-run mode flag
 * @returns {{ submittedPerChain, perChainRaw, usable, compileError }}
 */
export const playPool = (compiled, chains, passReference = false) => {
  const submittedPerChain = {};
  const perChainRaw = [];
  for (const c of chains) {
    const id = chainIdOf(c);
    if (!compiled.ok) {
      perChainRaw.push({ id, band: c.band, outcome: "protocol_violation", chainScore: 0, fullCredit: false, partial: false, correctSteps: 0, submittedSteps: 0, reachedTarget: false, error: compiled.error });
      continue;
    }
    // The dry-run threads the recorded derivation so the reference solver's
    // BFS doesn't have to re-derive the same answer. Real model calls
    // always pass undefined; the model's solve is called with two args.
    const refArg = passReference ? c.steps : undefined;
    const result = runCandidate(compiled, c.start, c.target, refArg);
    if (!result.ok) {
      // A throw / timeout / non-array return is a per-chain protocol_violation
      // by the plan's Phase 3 contract. Empty arrays are NOT violations — they
      // score 0 by the regular path.
      perChainRaw.push({ id, band: c.band, outcome: "protocol_violation", chainScore: 0, fullCredit: false, partial: false, correctSteps: 0, submittedSteps: 0, reachedTarget: false, error: String(result.error ?? "no value").slice(0, 200) });
      continue;
    }
    const submitted = Array.isArray(result.value) ? result.value : [];
    submittedPerChain[id] = submitted;
  }
  return { submittedPerChain, perChainRaw, usable: compiled.ok, compileError: compiled.ok ? null : compiled.error };
};

/**
 * The full run: model call, compile, replay, score.
 *
 *   dryRun  no model is called; `response` is supplied by the caller (typically
 *           the reference solver's source) and the same code path runs.
 *           Used by self-test to exercise the harness without a model.
 */
export const runChainDo = async (
  config,
  { chains, seed, response = null, dryRun = false, modelText = null } = {}
) => {
  const callStartedAt = Date.now();
  const callTimeoutMs = config?.timeoutMs ?? null;

  let completion = null;
  let callFailure = null;
  if (modelText !== null) {
    // Test/dry-run path: response is supplied directly. The completion shape
    // mirrors what adapters return so the rest of the path is identical.
    completion = { text: modelText, providerModel: dryRun ? "dry-run/reference-solver" : "test/harness-supplied" };
  } else if (dryRun) {
    // The default dry-run uses the reference solver as the model.
    completion = { text: REFERENCE_SOLVER_SOURCE, providerModel: "dry-run/reference-solver" };
  } else {
    try {
      completion = await complete(config, buildPrompt());
    } catch (err) {
      callFailure = describeCallFailure(err, { startedAt: callStartedAt, timeoutMs: config?.timeoutMs ?? null });
    }
  }

  if (callFailure) {
    // Every chain is `no_response`. The harness scores 0 and writes a report,
    // so a hung endpoint still produces the evidence the cohort needs.
    const submittedPerChain = {};
    const perChain = chains.map((c) => ({
      id: chainIdOf(c),
      band: c.band,
      outcome: "no_response",
      chainScore: 0,
      fullCredit: false,
      partial: false,
      correctSteps: 0,
      submittedSteps: 0,
      reachedTarget: false,
    }));
    return {
      perChain,
      submittedPerChain,
      score: { total: 0, max: 50, perBand: {}, perChain },
      usable: false,
      compileError: null,
      callFailure,
      callElapsedMs: Date.now() - callStartedAt,
      callTimeoutMs,
      response: "",
      providerModel: null,
      finishReason: null,
      responseFingerprint: fingerprint(""),
      digest: null,
      canary: checkCanary(""),
      dryRun,
    };
  }

  const compiled = compileCandidate(completion.text, { entry: "solve", timeoutMs: CALL_TIMEOUT_MS });
  const { submittedPerChain, perChainRaw, usable, compileError } = playPool(compiled, chains, dryRun);
  const score = scoreRun({ chains, submittedPerChain });

  // Merge the protocol_violation outcome from playPool into the scored
  // perChain. scoreRun only knows about legal derivations; a chain whose
  // model's solve() threw or returned garbage never gets an outcome from
  // scoreRun, so the harness's report field would otherwise read undefined.
  const rawById = new Map(perChainRaw.map((r) => [r.id, r]));
  const perChain = score.perChain.map((r) => {
    const raw = rawById.get(r.id);
    return raw ? { ...r, outcome: raw.outcome, ...(raw.error ? { error: raw.error } : {}) } : r;
  });

  return {
    perChain,
    submittedPerChain,
    score: { ...score, perChain },
    usable,
    compileError,
    callFailure: null,
    callElapsedMs: Date.now() - callStartedAt,
    callTimeoutMs,
    response: completion.text,
    providerModel: completion.providerModel ?? null,
    finishReason: completion.finishReason ?? null,
    responseFingerprint: fingerprint(completion.text),
    digest: null, // set by caller from buildPrompt digest
    canary: checkCanary(completion.text),
    // Token usage from the adapter. DO emits a single solver per
    // run, so per-call === per-run: surface once on the top-level.
    usage: completion.usage ?? null,
    dryRun,
  };
};

/**
 * The reference solver, as SANDBOX SOURCE — i.e. as a string the model would
 * have emitted. Used by `npm run dry-run:chain` and by the Phase 3 self-test
 * check that exercises the model path with a stubbed model.
 *
 * The function returned takes (start, target), runs BFS, and emits the same
 * step shape the scorer accepts: {rule, start, next}. Each step's `next`
 * is computed by replaying the reference solver's path through the rules.
 *
 * The implementation is the same BFS as src/do/reference.mjs's solveChain,
 * but it lives here as a sandbox-compilable string so the test path goes
 * through `compileCandidate` rather than the host function.
 *
 * The solver takes a third argument `reference`: an optional pre-computed
 * derivation. When present (the dry-run path), the function emits those
 * steps verbatim — no BFS, no search — and the gate passes deterministically.
 * When absent (a real model call), the model must produce its own
 * derivation; the harness never threads `reference` to a real submission,
 * so a model that emits the recorded steps could only do so by deriving
 * them itself.
 */
export const REFERENCE_SOLVER_SOURCE = `function solve(start, target, reference) {
  var SYMBOLS_SET = new Set(["A","B","C","D","X","Y","Z"]);
  var isValidString = function (s) {
    for (var i = 0; i < s.length; i++) if (!SYMBOLS_SET.has(s[i])) return false;
    return s.length > 0;
  };

  var matchR1 = function (s) {
    var out = [], i = s.indexOf("AB");
    while (i !== -1) { out.push({start: i, rule: "R1"}); i = s.indexOf("AB", i + 1); }
    return out;
  };
  var matchR2 = function (s) {
    var out = [], i = s.indexOf("CD");
    while (i !== -1) { out.push({start: i, rule: "R2"}); i = s.indexOf("CD", i + 1); }
    return out;
  };
  var matchR3 = function (s) {
    var out = [], i = s.indexOf("YZ");
    while (i !== -1) { out.push({start: i, rule: "R3"}); i = s.indexOf("YZ", i + 1); }
    return out;
  };
  var matchR4 = function (s) {
    var out = [], i = s.indexOf("X");
    while (i !== -1) { out.push({start: i, rule: "R4"}); i = s.indexOf("X", i + 1); }
    return out;
  };
  var matchR5 = function (s) {
    var out = [], i = s.indexOf("A");
    while (i !== -1) { out.push({start: i, rule: "R5"}); i = s.indexOf("A", i + 1); }
    return out;
  };
  var applyRule = function (ruleId, start, state) {
    if (ruleId === "R1") return state.slice(0, start) + "BA" + state.slice(start + 2);
    if (ruleId === "R2") return state.slice(0, start) + "DC" + state.slice(start + 2);
    if (ruleId === "R3") return state.slice(0, start) + "ZY" + state.slice(start + 2);
    if (ruleId === "R4") return state.slice(0, start) + "XY" + state.slice(start + 1);
    if (ruleId === "R5") return state.slice(0, start) + "BA" + state.slice(start + 1);
    return state;
  };
  var allApplicable = function (state) {
    var out = [];
    var matchers = [["R1", matchR1], ["R2", matchR2], ["R3", matchR3], ["R4", matchR4], ["R5", matchR5]];
    for (var m = 0; m < matchers.length; m++) {
      var occs = matchers[m][1](state);
      for (var j = 0; j < occs.length; j++) {
        out.push({
          rule: occs[j].rule,
          start: occs[j].start,
          next: applyRule(occs[j].rule, occs[j].start, state),
        });
      }
    }
    out.sort(function (a, b) { return a.start - b.start || (a.rule < b.rule ? -1 : 1); });
    return out;
  };

  if (start === target) return [];
  if (!isValidString(start) || !isValidString(target)) return [];

  // Dry-run fast path: if the caller supplies the chain's recorded
  // derivation, replay it as-is. The harness uses this to prove the
  // model path is sound without paying the BFS cost of re-deriving the
  // same answer.
  if (Array.isArray(reference) && reference.length > 0) return reference;

  var parent = new Map();
  parent.set(start, { parentState: null, move: null });
  var frontier = [start];
  var depth = 0;
  var MAX_STATES = 10000, MAX_STEPS = 60, MAX_LEN = 64;
  while (frontier.length && depth <= MAX_STEPS) {
    if (parent.size >= MAX_STATES) return [];
    var next = [];
    for (var i = 0; i < frontier.length; i++) {
      var s = frontier[i];
      if (s.length > MAX_LEN) continue;
      var apps = allApplicable(s);
      for (var k = 0; k < apps.length; k++) {
        var a = apps[k];
        if (parent.has(a.next)) continue;
        parent.set(a.next, { parentState: s, move: a });
        if (a.next === target) {
          // Reconstruct
          var steps = [], cursor = target;
          var entry = parent.get(target);
          while (entry.parentState !== null) {
            steps.push(entry.move);
            cursor = entry.parentState;
            entry = parent.get(cursor);
          }
          steps.reverse();
          return steps;
        }
        next.push(a.next);
      }
    }
    frontier = next;
    depth++;
  }
  return [];
}`;

// --- CLI -----------------------------------------------------------------

const HELP = `
MONKEY DO

  node src/do/chain/run.mjs --model <provider/model>

  --model, -m    the model to score, e.g.
                   openrouter/dots-3-note-preview:free
                   ollama/qwen2.5-coder:7b
                 or any id defined in config/models.json
  --key,   -k    your API key. Usually unnecessary: the tool looks in the
                 provider's environment variable, ~/.config/monkeydo, then .env.
  --per-band N   score only the first N chains per band (a quick run)
  --out DIR      where to write the JSON result (default results/)
  --runs,  -r    repeat the whole eval N times to check stability (default 1)
  --config FILE  model registry (default config/models.json)
  --dry-run      play the REFERENCE SOLVER instead of a model, with no API
                 call and no key. Verifies the harness end to end. Exits
                  non-zero unless the reference solver scores 50/50.

  --i-cannot-control-temperature
                 required to score a model whose config says it cannot run at
                 temperature 0. The result is stamped as not comparable.

  REPRODUCIBILITY (optional, but strongly recommended)

  --seed, -s          fixed RNG seed sent with the request
  --only-provider     pin to one OpenRouter provider
  --no-fallback       refuse to switch provider if the pinned one is down
  --order-provider    a,b,c   try providers in this order

  Examples
    node src/do/chain/run.mjs -m openrouter/dots-3-note-preview:free
    node src/do/chain/run.mjs -m ollama/qwen2.5-coder:7b -r 3
    node src/do/chain/run.mjs --dry-run --per-band 5
`;

const isMain = (() => {
  try {
    return Boolean(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href);
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.model && !args.dryRun)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  const model = args.dryRun ? "dry-run/reference-solver" : args.model;
  console.log(`\nMONKEY DO · ${model}`);
  await selfTestGate();
  let config = null;
  let keySource = "none (dry run)";
  if (!args.dryRun) {
    ({ config, keySource } = await prepareModel(args));
  } else {
    console.log(`\n  \x1b[1mDRY RUN\x1b[0m — the reference solver will play every chain.`);
    console.log(`  No model is called and no key is used.`);
  }
  const pool = loadPublishedPool({ perBand: args.perTier });
  console.log(`\n  chain pool: ${pool.chains.length} chains${pool.full ? " (the full published pool)" : ` (first ${args.perTier} per band; a SUBSET, not comparable with a full run)`}`);
  console.log(`  pool sha256 ${pool.sha256}`);
  console.log(args.dryRun ? `\n  playing the reference solver...` : `\n  contacting the model (ONE call)...`);

  const out = await runChainDo(config, { chains: pool.chains, seed: pool.seed, dryRun: args.dryRun });
  console.log(`\n  SCORE: ${out.score.total}/50`);
  for (const [band, b] of Object.entries(out.score.perBand)) {
    console.log(`    ${band.padEnd(5)} ${b.score.toFixed(2)} × ${b.chains.length} = ${b.points.toFixed(2)}/10`);
  }
  console.log(`\n  full credit chains: ${out.score.perChain.filter((c) => c.fullCredit).length}/${pool.chains.length}`);
  console.log(`  partial chains:     ${out.score.perChain.filter((c) => c.partial).length}/${pool.chains.length}`);
  console.log(`  protocol_violation: ${out.score.perChain.filter((c) => c.outcome === "protocol_violation").length}`);
  // Persist every run, dry or real. The report carries the chain pool's
  // fingerprint so a reader can verify the run is from this pool version.
  const { buildChainDoReport, writeChainDoReport } = await import("../../report.mjs");
  const report = buildChainDoReport({
    model, result: out, config, keySource, pool, reproducibility: null,
  });
  const reportPath = writeChainDoReport(report, args.out);
  console.log(`\n  Saved results to ${reportPath}`);
  if (args.dryRun && out.score.total !== 50) process.exit(1);
  })();
}