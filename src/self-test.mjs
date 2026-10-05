// Self-test for MONKEY SEE and MONKEY DO.
//
// Validates the eval itself before any model is scored. A failing self-test
// blocks scoring — there is no override. Every runner calls runSelfTest() before
// contacting a model (see cli.mjs selfTestGate), and `npm run self-test` prints
// the full report.
//
// `full: true` adds the slow check: regenerating the entire published pool and
// comparing it byte for byte (success criterion 4). It takes a few minutes, so
// it is `npm run self-test -- --full`, not part of the gate.
//
// This module is both the library the runners gate on and the command-line entry
// point, so there is only one self-test file to look for.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { tasks } from "./see/tasks.mjs";
import { buildPrompt, promptDigest, allPromptDigests, PREAMBLE } from "./see/prompt.mjs";
import { scoreTask, scoreSeen, generalizationIndex, heldOutCases, robustnessBonus, ROBUSTNESS_POINTS, unusableResult } from "./see/score.mjs";
import { compileCandidate, runCandidate } from "./sandbox.mjs";
import { RECORDED_DIGESTS } from "./prompt-digests.mjs";
import { adjustedTotal, adjustedTotal_1_0_0 } from "./adjusted.mjs";

const BAND_MIN = 20;
const BAND_MAX = 45;

/**
 * Run every check.
 *
 * @param {object} opts
 * @param {(line: string) => void} opts.log  where to print; a no-op for the gate
 * @param {boolean} opts.full  also regenerate the whole pool (slow)
 * @returns {Promise<{ ok: boolean, passed: number, failures: string[] }>}
 */
export const runSelfTest = async ({ log = console.log, full = false } = {}) => {
  let passed = 0;
  const failures = [];
  const check = (label, condition, detail = "") => {
    const ok = Boolean(condition);
    if (ok) passed++;
    else failures.push(detail ? `${label} — ${detail}` : label);
    const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log(`  ${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  log("\n\x1b[1mMONKEY SEE · self-test\x1b[0m\n");

  // --- 1. Ground truth correctness ----------------------------------------
  log("1. Ground truth correctness");
  for (const task of tasks) {
    const cases = heldOutCases(task);
    check(`Task ${task.id} derives an expected value for all ${cases.length} cases`, cases.length === 50);
    const shownOk = task.shown.every(({ input, output }) => {
      try {
        return JSON.stringify(task.reference(input)) === JSON.stringify(output);
      } catch {
        return false;
      }
    });
    check(`Task ${task.id} reference reproduces its 8 documented shown outputs`, shownOk);
  }

  // --- 2. Naive baseline band ---------------------------------------------
  log("\n2. Naive baseline band (each task must land 20-45%)");
  for (const task of tasks) {
    const r = scoreTask(task, task.naive);
    const pct = (r.rate * 100).toFixed(1);
    check(
      `Task ${task.id} naive scores ${pct}%`,
      r.rate * 100 >= BAND_MIN && r.rate * 100 <= BAND_MAX,
      `${r.correct}/${r.total}`
    );
    const buckets = Object.entries(r.perBucket)
      .map(([k, v]) => `${k} ${v.correct}/${v.total}`)
      .join("  ");
    log(`        ${buckets}`);
  }

  // --- 3. Naive < perfect --------------------------------------------------
  log("\n3. Reference is perfect on every held-out case");
  for (const task of tasks) {
    const r = scoreTask(task, task.reference);
    check(`Task ${task.id} reference scores ${r.correct}/${r.total}`, r.correct === r.total);
  }

  // --- 4. Shown examples expose the rule ----------------------------------
  log("\n4. Shown examples expose the rule (naive must FAIL them)");
  // Exact counts, not just "less than 8". A drifting count means the shown
  // examples were edited, and the Generalization Index would shift with them.
  const EXPECTED_NAIVE_SEEN = { A: 5, B: 5, C: 4 };
  for (const task of tasks) {
    // Only this task's naive is supplied; the other two ids resolve to
    // undefined and would score 0/8 spuriously. Select this task's own row.
    const seen = scoreSeen({ [task.id]: task.naive });
    const row = seen.perTask.find((p) => p.taskId === task.id);
    const expected = EXPECTED_NAIVE_SEEN[task.id];
    check(
      `Task ${task.id} naive passes only ${row.correct}/${row.total} shown examples`,
      row.correct === expected && row.correct < row.total,
      `expected ${expected}/${row.total}`
    );
  }

  // --- 5. Held-out sets are the right size --------------------------------
  log("\n5. Held-out set shape");
  for (const task of tasks) {
    const cases = heldOutCases(task);
    const sizes = ["core", "boundary", "adversarial"].map((b) => task.heldOut[b].length);
    check(
      `Task ${task.id} has 20/15/15 across three buckets`,
      sizes[0] === 20 && sizes[1] === 15 && sizes[2] === 15,
      `got ${sizes.join("/")}, total ${cases.length}`
    );
    check(`Task ${task.id} totals 50 held-out cases`, cases.length === 50);
  }

  // --- 6. A surface-fit strategy produces a high Generalization Index ---------------
  log("\n6. A surface-fit strategy is detected (naive as stand-in)");
  const mimicResults = tasks.map((t) => scoreTask(t, t.naive));
  const mimicSeen = scoreSeen(Object.fromEntries(tasks.map((t) => [t.id, t.naive])));
  const mimic = generalizationIndex(mimicSeen, mimicResults);
  log(`        SEEN ${(mimic.seen * 100).toFixed(0)}%  HELD-OUT ${(mimic.heldOut * 100).toFixed(0)}%  INDEX ${(mimic.index * 100).toFixed(0)}`);
  check(
    "Surface-fit index is meaningfully above zero",
    mimic.index > 0.05,
    `index ${(mimic.index * 100).toFixed(0)}`
  );

  // --- 7. A perfect solver produces a zero index --------------------------
  log("\n7. A perfect solver is not penalised");
  const perfectResults = tasks.map((t) => scoreTask(t, t.reference));
  const perfectSeen = scoreSeen(Object.fromEntries(tasks.map((t) => [t.id, t.reference])));
  const perfect = generalizationIndex(perfectSeen, perfectResults);
  check(
    "Perfect solver scores 100% held-out",
    perfect.heldOut === 1,
    `${(perfect.heldOut * 100).toFixed(0)}%`
  );
  check("Perfect solver index is 0", perfect.index === 0, `index ${perfect.index}`);

  // --- 8. Data/ground-truth separation -----------------------------------
  // The integrity property the file split exists to provide. If prompt
  // construction ever imports reference.mjs, the true rule can leak into a
  // prompt. Assert the split rather than trusting the comment.
  log("\n8. Ground truth is isolated from task data");
  const refSrc = readFileSync(new URL("../src/see/reference.mjs", import.meta.url), "utf8");
  check(
    "reference.mjs contains no case data (no 'shown' or 'heldOut' keys)",
    !/"shown"|"heldOut"|\bshown:|\bheldOut:/.test(refSrc)
  );
  for (const task of tasks) {
    // A held-out entry must be a bare input, never an answer pair. An array
    // input (Task C) is still a bare input, so test for the pair shape
    // specifically: a plain object with input/expected keys.
    const isAnswerPair = (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v) && ("input" in v || "expected" in v);
    const offenders = ["core", "boundary", "adversarial"]
      .flatMap((b) => task.heldOut[b])
      .filter(isAnswerPair);
    check(
      `Task ${task.id} held-out entries are bare inputs, not answer pairs`,
      offenders.length === 0,
      offenders.length ? `e.g. ${JSON.stringify(offenders[0])}` : `${task.heldOut.core.length} core inputs checked`
    );
  }
  check(
    "expected values are derived, not read from the JSON",
    typeof tasks[0].reference === "function" && tasks[0].reference(11) === 21,
    "reference(11) must be computed at runtime"
  );

  // --- 9. Prompt construction and digests ---------------------------------
  // Check 7 in the design doc. Two scores are only comparable if every model
  // was shown byte-identical text, so the digests are recorded in every report
  // and verified here.
  log("\n9. Prompt construction and digests");
  check(
    "preamble matches the design doc byte for byte",
    PREAMBLE ===
      "Below are input->output examples of a single function f. The rule is\n" +
        "consistent across all examples. Write the function f in JavaScript.\n" +
        "Output only the code, no explanation."
  );
  const digests = new Set();
  for (const task of tasks) {
    const p = buildPrompt(task);
    const exampleLines = p.split("\n").slice(6);
    check(
      `Task ${task.id} prompt has preamble + hint + 8 examples`,
      p.startsWith(PREAMBLE) && exampleLines.length === 8 && !p.endsWith("\n"),
      `${exampleLines.length} example lines`
    );
    const d = promptDigest(task);
    check(`Task ${task.id} digest is 64-char hex and unique`, /^[0-9a-f]{64}$/.test(d) && !digests.has(d), d.slice(0, 12) + "...");
    digests.add(d);
    // No held-out input may appear in anything the model sees.
    // Match on the rendered ARGUMENT, not a bare substring: "1" is a substring
    // of "f(11) -> 21", and "2" of "f(2) -> 4", so includes() alone produces
    // false positives. Require the argument to be delimited on both sides.
    const shownJson = new Set(task.shown.map((s) => JSON.stringify(s.input)));
    const renderArg = (input) => (Array.isArray(input) ? `[${input.join(", ")}]` : JSON.stringify(input));
    const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const leaked = ["core", "boundary", "adversarial"]
      .flatMap((b) => task.heldOut[b])
      .filter((input) => !shownJson.has(JSON.stringify(input)))
      .filter((input) => {
        const arg = escaped(renderArg(input));
        return new RegExp(`f\\(${arg}\\)`).test(p);
      });
    check(
      `Task ${task.id} prompt leaks no held-out argument`,
      leaked.length === 0,
      leaked.length ? `leaked ${JSON.stringify(leaked[0])}` : `${task.heldOut.core.length + 30} held-out inputs checked`
    );
  }
  check("prompt construction is deterministic", allPromptDigests().length === 3 && new Set(allPromptDigests().map((p) => p.digest)).size === 3);
  // Check 7 proper: the digests must equal the RECORDED values, so a mismatch
  // means the prompt changed rather than that a reconstruction drifted.
  for (const { taskId, digest } of allPromptDigests()) {
    check(`Task ${taskId} prompt matches its recorded digest`, digest === RECORDED_DIGESTS[taskId], `${digest.slice(0, 12)}... vs recorded ${RECORDED_DIGESTS[taskId].slice(0, 12)}...`);
  }

  // --- 10. Robustness bonus calibration ------------------------------------
  // The bonus is proportional to non-throwing held-out cases. These checks pin
  // the calibration, because a drifting bonus silently rescales every score:
  // the naive baseline must keep its full 5 (it never throws), and the perfect
  // solver must reach exactly 50/50.
  log("\n10. Robustness bonus calibration");
  const naiveResults = tasks.map((t) => scoreTask(t, t.naive));
  const naiveBonus = robustnessBonus(naiveResults);
  check(
    "naive baseline never throws, so it keeps the full bonus",
    naiveBonus.threw === 0 && naiveBonus.points === ROBUSTNESS_POINTS,
    `threw ${naiveBonus.threw}/${naiveBonus.total}, +${naiveBonus.points}`
  );
  const refResults = tasks.map((t) => scoreTask(t, t.reference));
  const refBonus = robustnessBonus(refResults);
  check(
    "reference never throws, earning the full bonus",
    refBonus.threw === 0 && refBonus.points === ROBUSTNESS_POINTS,
    `+${refBonus.points}`
  );

  // A model that learned a task perfectly but omitted one guard must not be
  // punished as though it had learned nothing. This is the exact regression the
  // proportional rule replaced.
  const oneThrow = robustnessBonus([{ threw: 0, total: 50 }, { threw: 1, total: 50 }, { threw: 0, total: 50 }]);
  check(
    "one throw in 150 costs a sliver, not the whole bonus",
    oneThrow.points > 4.9 && oneThrow.crashed === true,
    `+${oneThrow.points.toFixed(3)} of 5, crashed=${oneThrow.crashed}`
  );
  check(
    "a single input can no longer be worth 10% of the score",
    ROBUSTNESS_POINTS - oneThrow.points < 0.1,
    `worst case for one input: ${(ROBUSTNESS_POINTS - oneThrow.points).toFixed(3)} points`
  );
  check(
    "throwing on everything still scores zero",
    robustnessBonus([{ threw: 50, total: 50 }, { threw: 50, total: 50 }, { threw: 50, total: 50 }]).points === 0
  );

  // Headline calibration, recomputed under the new rule.
  const naiveTotal = naiveResults.reduce((s, r) => s + r.rate * 15, 0) + naiveBonus.points;
  const refTotal = refResults.reduce((s, r) => s + r.rate * 15, 0) + refBonus.points;
  log(`        naive baseline total ${naiveTotal.toFixed(1)}/50   reference total ${refTotal.toFixed(1)}/50`);
  check("naive baseline total lands in the 20/50 documented band", naiveTotal >= 18 && naiveTotal <= 24, naiveTotal.toFixed(1));
  check("reference reaches a full 50/50", refTotal === 50, refTotal.toFixed(1));

  {
    // An unusable response is 50 failed, thrown cases — in the held-out arm AND
    // the robustness bonus. Leaving it out reported a Generalization Index of -33 and a
    // full bonus for a model that answered one task in prose.
    const results = [unusableResult(tasks[0]), scoreTask(tasks[1], tasks[1].reference), scoreTask(tasks[2], tasks[2].reference)];
    const seen = scoreSeen({ B: tasks[1].reference, C: tasks[2].reference });
    const idx = generalizationIndex(seen, results);
    const rb = robustnessBonus(results);
    check("an unusable task counts against the held-out arm, so the index is not negative",
      Math.round(idx.index * 100) === 0 && results[0].total === 50, `index ${Math.round(idx.index * 100)}, held-out ${(idx.heldOut * 100).toFixed(0)}%`);
    check("an unusable task costs its share of the robustness bonus", Math.abs(rb.points - 5 * 100 / 150) < 1e-9, `+${rb.points.toFixed(2)} of 5`);
  }

  // --- Sandbox containment -------------------------------------------
  log("\nSandbox containment");
  {
    const loop = compileCandidate("function f(n) { while (true) {} }");
    const t0 = Date.now();
    const r = runCandidate(loop, 1);
    const ms = Date.now() - t0;
    // A wall-clock bound on a timer, so it is the one check here that can fail
    // for reasons unrelated to correctness: a loaded machine can overshoot a
    // 1000ms timeout by hundreds of ms. The property that matters is that the
    // loop is interrupted AT ALL and reported as a timeout (checked above); the
    // bound only catches a timeout that never fires, which takes seconds, not
    // milliseconds. Kept generous so a busy CI runner does not fail the gate
    // every runner depends on.
    check("an infinite loop is interrupted in under 5s", loop.ok && r.timedOut === true && ms < 5000, `${ms}ms`);

    const req = compileCandidate("function f(n) { return require('fs').readFileSync('/etc/passwd', 'utf8'); }");
    const rr = runCandidate(req, 1);
    check("code calling require is rejected", req.ok && rr.ok === false, rr.error ?? "returned a value");

    const globals = compileCandidate("function f() { return [typeof require, typeof process, typeof fetch].join('/'); }");
    check("the sandbox has no require, process or fetch", runCandidate(globals, 0).value === "undefined/undefined/undefined");

    const chatty = compileCandidate("```js\nfunction f(n) { console.log(n); return n <= 10 ? n*n : n*n-100; }\nconsole.log(f(11));\n```");
    check("console.log does not void a correct answer", chatty.ok && runCandidate(chatty, 11).value === 21, chatty.ok ? "" : chatty.error);

    const prose = compileCandidate("Here is the function:\n\n```javascript\nfunction f(n) { return n * 2; }\n```\n\nIt doubles n.");
    check("a code block wrapped in prose is still extracted", prose.ok && runCandidate(prose, 4).value === 8, prose.ok ? "" : prose.error);

    const helper = compileCandidate("function f(x) { return x; }\nfunction solve(board, mines) { return { row: 0, col: mines }; }", { entry: "solve" });
    const hr = runCandidate(helper, [[null]], 3);
    check("DO calls solve, not a helper named f", hr.ok && hr.value?.col === 3, JSON.stringify(hr.value));
  }

  // ===================================================================
  // MONKEY SEE — sample efficiency (Phase 4, suite 1.0.0)
  //
  // The runner loops over sample levels 2, 4, 8, 16. Level 8 is the
  // backward-compat slot — its prompt and digest must be unchanged from
  // suite 0.x.x so every old SEE score remains comparable to a new run.
  // Levels 2, 4, 16 are NEW prompt slots; their digests are pinned in
  // src/prompt-digests.mjs and the runner produces per-level metrics.
  // ===================================================================
  log("\n\n\x1b[1mMONKEY SEE — sample levels · self-test\x1b[0m\n");

  const { SAMPLE_LEVELS, SAMPLE_WEIGHTS, weightedSum, scoreTaskAcrossLevels } =
    await import("./see/score.mjs");

  // (a) Levels are exactly the four pinned in Phase 1, with the right
  // weights and the right order.
  check("SAMPLE_LEVELS is [2, 4, 8, 16]",
    JSON.stringify(SAMPLE_LEVELS) === "[2,4,8,16]",
    JSON.stringify(SAMPLE_LEVELS));
  check("SAMPLE_WEIGHTS sums to 1.0",
    Math.abs(Object.values(SAMPLE_WEIGHTS).reduce((s, w) => s + w, 0) - 1.0) < 1e-9,
    `sum=${Object.values(SAMPLE_WEIGHTS).reduce((s, w) => s + w, 0)}`);

  // (b) Level-8 prompt digests match the recorded (backward-compat gate).
  for (const task of tasks) {
    const actual = promptDigest(task, 8);
    check(`task ${task.id} level-8 prompt digest is unchanged (backward-compat)`,
      actual === RECORDED_DIGESTS[task.id],
      `recorded=${RECORDED_DIGESTS[task.id].slice(0, 16)}…, actual=${actual.slice(0, 16)}…`);
  }

  // (c) The new levels (2, 4, 16) have digests pinned in SEE_LEVEL_DIGESTS
  // and each prompt's actual digest matches the pin.
  const { SEE_LEVEL_DIGESTS } = await import("./prompt-digests.mjs");
  for (const level of [2, 4, 16]) {
    for (const task of tasks) {
      const key = `${task.id}-${level}`;
      const expected = SEE_LEVEL_DIGESTS[key];
      const actual = promptDigest(task, level);
      check(`level ${level} digest for task ${task.id} matches the pinned value`,
        actual === expected,
        `recorded=${expected?.slice(0, 16) ?? "MISSING"}…, actual=${actual.slice(0, 16)}…`);
    }
  }

  // (d) Each task now has 16 shown examples (was 8). The first 8 are the
  // old suite-0.x.x examples — verified by re-rendering the level-8 prompt
  // and checking its digest against the recorded pin. (Already covered by
  // (b).)
  check("each task ships 16 shown examples (Phase 4 raised the ceiling from 8)",
    tasks.every((t) => t.shown.length === 16),
    `lengths=${tasks.map((t) => t.shown.length).join(", ")}`);

  // (e) A synthetic audit: the reference oracle, run through the same
  // scoring path a real model would take (sandbox compile + per-case call),
  // scores 50/50 at every level. This proves the per-level path is sound
  // end to end.
  const runLevelsModule = await import("./see/run-levels.mjs");
  const audit = await runLevelsModule.runAllLevels(null, { dryRun: true });

  for (const id of ["A", "B", "C"]) {
    const t = audit.perTask[id];
    check(`synthetic audit: task ${id} weighted rate is 100% (reference oracle)`,
      t.weightedRate > 0.999,
      `weightedRate=${t.weightedRate.toFixed(4)}`);
    check(`synthetic audit: task ${id} gzMean is 0 (oracle matches itself on every level)`,
      Math.abs(t.gzMean) < 1e-9,
      `gzMean=${t.gzMean.toFixed(6)}`);
  }

  // (f) Per-level GZ pooled across tasks is 0 (reference oracle matches
  // held-out perfectly at every level).
  for (const [level, e] of Object.entries(audit.perLevel)) {
    check(`synthetic audit: pooled GZ at level ${level} is 0`,
      Math.abs(e.gz) < 1e-9,
      `gz=${e.gz?.toFixed(6)}`);
  }

  // (g) Robustness bonus is 5/5 against the reference oracle (no throws).
  check("synthetic audit: robustness is 5/5 against the reference oracle",
    audit.robustness.points === 5,
    `points=${audit.robustness.points}, threw=${audit.robustness.threw}/${audit.robustness.total}`);

  // (h) The synthetic audit's total = 45 (weighted rates × 15) + 5 = 50.
  const expectedPoints = Object.values(audit.perTask).reduce((s, t) => s + t.weightedRate * 15, 0);
  check("synthetic audit: 45 + 5 = 50/50 against the reference oracle",
    Math.abs(expectedPoints + audit.robustness.points - 50) < 1e-9,
    `taskPoints=${expectedPoints.toFixed(2)}, robustness=${audit.robustness.points}`);

  // ===================================================================
  // MONKEY DO — adjusted total + chain eval
  //
  // Section 18 pins the audit.
  // ===================================================================


  // --- 18. The adjusted total (reported, never scored) -------------------
  // Suite 1.0.0: the formula uses the SEE gzMean and the DO chain
  // engagement rate. See the long header in src/adjusted.mjs for the
  // rationale behind the weights.
  log("\n18. The adjusted total");

  {
    // The new-field shortcut mirrors the old one for symmetry with the
    // rest of the test block.
    const adj = (seeTotal, doTotal, gzMean, chainEngagementRate) =>
      adjustedTotal({ seeTotal, doTotal, gzMean, chainEngagementRate });

    // The load-bearing invariant: a perfect run must still be 100 under
        // both 1.0.0 and 1.1.0 formulas. This is what lets the adjusted
        // figure exist at all — it is reported beside SEE + DO rather than
        // replacing them, and the oracle is not penalised for any progress
        // metric it has no use for. The 1.1.0 formula scales the GZ
        // penalty by the earned fraction; with base=100 the factor is 1.0
        // and the two formulas agree.
        check("1.1.0: a perfect run still scores 100/100 adjusted",
          adj(50, 50, 0, 1).total === 100, `${adj(50, 50, 0, 1).total}/100`);
        check("1.1.0: the reference solver is not penalised by the chain-engagement clawback",
          adj(50, 50, 0, 1).unearnedPenalty === 0);
        check("1.1.0: a perfect run with no engagement supplied is not penalised either",
          adjustedTotal({ seeTotal: 50, doTotal: 50, gzMean: 0 }).total === 100);

        // Bounded on both sides.
        check("1.1.0: a surface-fitter floors at 0 rather than going negative", adj(0, 0, 100, 0).total === 0);
        check("1.1.0: the total is clamped at 100 even if a base ever exceeded it",
          adjustedTotal({ seeTotal: 80, doTotal: 80, gzMean: 0, chainEngagementRate: 1 }).total === 100);

        // Both adjustments actually bite, and in the right direction.
        check("1.1.0: the Generalization Index is subtracted, so the same scores score lower at a higher index",
          adj(24, 10, 25, 1).total < adj(24, 10, 9, 1).total);
        check("1.1.0: a solver that never engaged has the unearned points clawed back",
          adj(24, 10, 9, 0).unearnedPenalty === 10, `${adj(24, 10, 9, 0).unearnedPenalty}`);
        check("1.1.0: a solver that engaged on every chain keeps the no-confident-error points",
          adj(24, 10, 9, 1).unearnedPenalty === 0);
        check("1.1.0: engagement claws back proportionally, not all-or-nothing",
          adj(24, 10, 9, 0.5).unearnedPenalty === 5, `${adj(24, 10, 9, 0.5).unearnedPenalty}`);

        // The clawback can never exceed the component it corrects.
        check("1.1.0: the clawback never exceeds the 10 points it is correcting",
          adjustedTotal({ seeTotal: 0, doTotal: 0, gzMean: 0, chainEngagementRate: -5 }).unearnedPenalty <= 10);
        check("1.1.0: a negative Generalization Index is treated as zero rather than a bonus",
          adj(24, 10, -30, 1).total === 34, `${adj(24, 10, -30, 1).total}`);

        // Three edge-case pins the user named in the Phase 5 spec, now
        // asserted under BOTH suite versions. The 1.1.0 formula scales the
        // GZ penalty by the earned fraction; with GZ=0 the two formulas
        // agree exactly on the unearnedPenalty field (the engagement
        // clawback is FIXED and unscaled by design — see the asymmetry
        // note in src/adjusted.mjs). The 1.1.0 column also pins the
        // total figure (unearnedPenalty alone is invariant; the total
        // differs because the GZ penalty is scaled).
        check("1.1.0 all-engaged (chainEngagementRate=1) → no clawback, unearnedPenalty=0",
          adj(45, 50, 0, 1).unearnedPenalty === 0,
          `unearnedPenalty=${adj(45, 50, 0, 1).unearnedPenalty}, total=${adj(45, 50, 0, 1).total}`);
        check("1.0.0 all-engaged (chainEngagementRate=1) → no clawback, unearnedPenalty=0",
          adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 1 }).unearnedPenalty === 0,
          `unearnedPenalty=${adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 1 }).unearnedPenalty}, total=${adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 1 }).total}`);
        check("1.1.0 never-engaged (chainEngagementRate=0) → full claw, unearnedPenalty=10",
          adj(45, 50, 0, 0).unearnedPenalty === 10,
          `unearnedPenalty=${adj(45, 50, 0, 0).unearnedPenalty}, total=${adj(45, 50, 0, 0).total}`);
        check("1.0.0 never-engaged (chainEngagementRate=0) → full claw, unearnedPenalty=10",
          adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 0 }).unearnedPenalty === 10,
          `unearnedPenalty=${adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 0 }).unearnedPenalty}, total=${adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 0 }).total}`);
        check("1.1.0 partially-engaged (chainEngagementRate=0.5) → linear half-claw, unearnedPenalty=5",
          adj(45, 50, 0, 0.5).unearnedPenalty === 5,
          `unearnedPenalty=${adj(45, 50, 0, 0.5).unearnedPenalty}, total=${adj(45, 50, 0, 0.5).total}`);
        check("1.0.0 partially-engaged (chainEngagementRate=0.5) → linear half-claw, unearnedPenalty=5",
          adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 0.5 }).unearnedPenalty === 5,
          `unearnedPenalty=${adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 0.5 }).unearnedPenalty}, total=${adjustedTotal_1_0_0({ seeTotal: 45, doTotal: 50, gzMean: 0, chainEngagementRate: 0.5 }).total}`);

        // 1.1.0 floor-saturation tripwire. The qwen shape (SEE 19, DO 1,
        // GZ 26.7, eng 0.04) resolves to 8 under 1.1.0 and 0 under 1.0.0.
        // The tripwire breaks if either formula is silently re-shaped.
        check("1.1.0: the qwen shape (SEE 19, DO 1, GZ 26.7, eng 0.04) resolves to 8 (the floor-saturation fix)",
          adj(19, 1, 26.7, 0.04).total === 8,
          `total=${adj(19, 1, 26.7, 0.04).total}, base=${adj(19, 1, 26.7, 0.04).base}, gzPenalty=${adj(19, 1, 26.7, 0.04).gzMeanPenalty}`);
        check("1.0.0: the qwen shape (SEE 19, DO 1, GZ 26.7, eng 0.04) floors at 0",
          adjustedTotal_1_0_0({ seeTotal: 19, doTotal: 1, gzMean: 26.7, chainEngagementRate: 0.04 }).total === 0,
          `total=${adjustedTotal_1_0_0({ seeTotal: 19, doTotal: 1, gzMean: 26.7, chainEngagementRate: 0.04 }).total}`);

        // Synthetic combined-report round-trip: SEE 50 + DO 50 + gzMean 0 +
        // engagement 1 → adjusted 100/100. The gate the user named in the
        // Phase 5 spec. Must hold under both formulas.
        const synthetic = adjustedTotal({ seeTotal: 50, doTotal: 50, gzMean: 0, chainEngagementRate: 1 });
        const synthetic10 = adjustedTotal_1_0_0({ seeTotal: 50, doTotal: 50, gzMean: 0, chainEngagementRate: 1 });
        check("1.1.0 synthetic round-trip (SEE 50, DO 50, gzMean 0, engagement 1) → 100/100 adjusted",
          synthetic.total === 100 && synthetic.max === 100,
          `total=${synthetic.total}, max=${synthetic.max}`);
        check("1.0.0 synthetic round-trip (SEE 50, DO 50, gzMean 0, engagement 1) → 100/100 adjusted",
          synthetic10.total === 100 && synthetic10.max === 100,
          `total=${synthetic10.total}, max=${synthetic10.max}`);

        // It must stay a reporting layer: SEE + DO are untouched.
        check("1.1.0: the adjusted figure does not change the SEE + DO base",
          adj(45, 50, 100, 0).base === 95, `base=${adj(45, 50, 100, 0).base}`);
      }


  // ===================================================================
  // MONKEY DO (chain eval)
  //
  // Exercises the prompt + scorer + reference-solver path on the
  // published chain pool, pins the recorded prompt digest, and
  // verifies the dry-run path scores 50/50.
  // ===================================================================
  log("\n\n\x1b[1mMONKEY DO · self-test\x1b[0m\n");

  // 19. Prompt digest pin
  const chainPromptModule = await import("./do/chain/prompt.mjs");
  const chainPoolModule = await import("./do/chain/pool.mjs");
  const chainRunModule = await import("./do/chain/run.mjs");

  const chainDigest = chainPromptModule.promptDigest();
  check("the DO prompt digest matches the recorded value",
    chainDigest === RECORDED_DIGESTS.DO,
    `digest=${chainDigest.slice(0, 16)}…, recorded=${RECORDED_DIGESTS.DO.slice(0, 16)}…`);

  check("the DO prompt's canary carries the suite version and seed",
    chainPromptModule.CANARY === "monkey-do-chain@1.0.0" &&
      chainPromptModule.SEED_CANARY === `monkey-do-chain-seed:${chainPromptModule.POOL_SEED_HEX}`,
    `canary=${chainPromptModule.CANARY}, seed=${chainPromptModule.SEED_CANARY}`);

  // 20. The reference solver, run through the SAME model path a real model
  // call would take (compile + per-chain call + score), must score 50/50.
  // The chain POOL_FILE may legitimately be missing during a fresh
  // checkout, so loadPublishedPool throws if so. The harness has run gen-
  // chain-pool already (npm scripts order), so this is informational.
  let chainPool;
  try {
    chainPool = chainPoolModule.loadPublishedPool();
  } catch (err) {
    failures.push(`DO chain pool missing — run npm run gen-chain-pool: ${err.message}`);
    log(`  \x1b[31mFAIL\x1b[0m  DO chain pool missing — run npm run gen-chain-pool: ${err.message}`);
  }

  if (chainPool) {
    check("the published chain pool loads 50 chains", chainPool.chains.length === 50,
      `loaded ${chainPool.chains.length} chains`);
    const dryOut = await chainRunModule.runChainDo(null, {
      chains: chainPool.chains,
      seed: chainPool.seed,
      dryRun: true,
      modelText: chainRunModule.REFERENCE_SOLVER_SOURCE,
    });
    check("the stubbed-model dry-run scores 50/50 (Phase 3 gate)",
      dryOut.score.total === 50,
      `scored ${dryOut.score.total}/50`);
    check("every chain is full credit in the dry-run",
      dryOut.score.perChain.every((c) => c.fullCredit),
      `${dryOut.score.perChain.filter((c) => c.fullCredit).length}/${dryOut.score.perChain.length} chains full credit`);
    check("the dry-run is usable (no compile / sandbox failure)",
      dryOut.usable && dryOut.compileError === null,
      `usable=${dryOut.usable}, compileError=${dryOut.compileError}`);
    check("no chain ends in protocol_violation in the dry-run",
      dryOut.score.perChain.every((c) => c.outcome !== "protocol_violation"),
      `${dryOut.score.perChain.filter((c) => c.outcome === "protocol_violation").length} protocol_violation`);
  }

  return { ok: failures.length === 0, passed, failures };
};

// Command-line entry point. Only runs when this file is invoked directly, so
// importing runSelfTest() from the runners does not trigger the report.
// `import.meta.main` would be tidier but needs Node 24.2; this needs Node 20.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const full = process.argv.includes("--full");
  const { ok, passed, failures } = await runSelfTest({ full });

  if (ok) {
    console.log(`\n\x1b[1mMONKEY SEE and MONKEY DO are calibrated and safe to score.\x1b[0m`);
    console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m${full ? "" : "  (Add --full to regenerate the whole pool as well.)"}\n`);
    process.exit(0);
  }
  // Printed ONLY on success now. It used to print "calibrated and safe to score"
  // unconditionally, directly above the line reporting failed checks.
  console.log(`\n\x1b[31m\x1b[1m${failures.length} check(s) failed.\x1b[0m Scoring is blocked. Do not trust any score until these pass.\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log("");
  process.exit(1);
}
