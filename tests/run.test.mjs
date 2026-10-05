// End-to-end test of the runner, using an injected fake fetch.
// Proves prompt -> model -> sandbox -> score -> index works as a whole,
// with no API key and no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runSee } from "../src/see/run.mjs";
import { tasks } from "../src/see/tasks.mjs";
import { buildPrompt, promptDigest } from "../src/see/prompt.mjs";
import { robustnessBonus, ROBUSTNESS_POINTS } from "../src/see/score.mjs";
import { runAll } from "../src/run-all.mjs";
import { loadPublishedPool } from "../src/do/chain/pool.mjs";
import { REFERENCE_SOLVER_SOURCE } from "../src/do/chain/run.mjs";

process.env.FAKE_KEY = "fake-key";

const CORRECT = {
  A: "function f(n) { return n <= 10 ? n*n : n*n-100; }",
  B: `function f(s) {
    if (typeof s !== "string" || s.length === 0) return s;
    if ("aeiou".includes(s[0].toLowerCase())) return s;
    return s[0].toUpperCase() + s.slice(1);
  }`,
  C: `function f(arr) {
    const d = [...new Set(arr)];
    if (d.length < 2) return null;
    d.sort((a,b) => b-a);
    return d[1];
  }`,
};

const NAIVE = { A: "function f(n){ return n*n; }", B: "function f(s){ return s[0].toUpperCase()+s.slice(1); }", C: "function f(a){ return a.slice().sort((x,y)=>y-x)[a.length-2]; }" };

const fakeConfig = (answers) => ({
  endpoint: "https://fake.test/v1/chat/completions",
  model: "fake/model",
  apiKeyEnv: "FAKE_KEY",
  maxRetries: 0,
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

test("a model that solves every task scores 50/50 with index 0", async () => {
  const out = await runSee(fakeConfig([...Object.values(CORRECT)]));
  assert.equal(out.taskRuns.length, 3);
  for (const t of out.taskRuns) {
    assert.equal(t.result.correct, 50, `task ${t.taskId} scored ${t.result.correct}/50`);
  }
  assert.equal(out.noCrash, 5);
  assert.equal(Math.round(out.points), 45);
  assert.equal(Math.round(out.points + out.noCrash), 50);
  assert.equal(Math.round(out.index.index * 100), 0);
});

test("a naive model lands in the 20-45% band per task and shows mimicry", async () => {
  const out = await runSee(fakeConfig([...Object.values(NAIVE)]));
  for (const t of out.taskRuns) {
    const r = t.result.rate * 100;
    assert.ok(r >= 20 && r <= 45, `task ${t.taskId} scored ${r}%, outside the band`);
  }
  // The headline: a model that never learned the rules still aces the shown
  // examples, so the index is materially above zero.
  assert.ok(out.index.index * 100 > 5, `index was ${out.index.index * 100}`);
  assert.ok(Math.round(out.points + out.noCrash) < 50);
});

test("a model returning prose scores zero without crashing the run", async () => {
  const out = await runSee(
    fakeConfig([
      "I'm sorry, I can't help with that.",
      "Sure! Here is a function:\nActually, let me explain first...",
      "```\nnot code\n```",
    ])
  );
  assert.equal(out.taskRuns.length, 3);
  for (const t of out.taskRuns) {
    assert.equal(t.result, null, "unusable response must not produce a score");
    assert.ok(t.compileError, "must record why it could not be compiled");
  }
  assert.equal(out.noCrash, 0);
  assert.equal(out.points, 0);
});

test("a model that throws on every call forfeits the robustness bonus", async () => {
  const boom = "function f(n) { throw new Error('nope'); }";
  const out = await runSee(fakeConfig([boom, boom, boom]));
  for (const t of out.taskRuns) {
    assert.equal(t.result.correct, 0);
    assert.equal(t.result.threw, 50);
  }
  assert.equal(out.noCrash, 0, "throwing on everything forfeits the whole bonus");
  assert.equal(out.robustness.crashed, true);
  assert.equal(out.points, 0);
});

test("a single throw costs a proportional sliver, not the whole bonus", async () => {
  // The regression this guards: under the old all-or-nothing rule, missing one
  // empty-string guard cost 5 of 50 points. It should now cost 5/150.
  const unguarded = CORRECT.B.replace('if (typeof s !== "string" || s.length === 0) return s;\n    ', "");
  const out2 = await runSee(fakeConfig([CORRECT.A, unguarded, CORRECT.C]));
  // The perfect model, for comparison.
  const out = await runSee(fakeConfig([...Object.values(CORRECT)]));
  const rb = out2.robustness;
  assert.equal(rb.total, 150);
  assert.ok(rb.threw >= 1, `expected at least one throw, got ${rb.threw}`);
  assert.ok(rb.threw <= 2, `the near-miss should throw on very few cases, got ${rb.threw}`);
  assert.ok(
    out2.noCrash > 4.9 && out2.noCrash < 5,
    `one throw must cost ~0.03 points, not 5. Got ${out2.noCrash}`
  );
  assert.equal(rb.crashed, true, "the categorical flag still records that it threw");
  // The perfect model keeps the full bonus.
  assert.equal(out.noCrash, 5);
  assert.equal(out.robustness.crashed, false);
});

test("each task is sent its own prompt, exactly once", async () => {
  const sent = [];
  const cfg = {
    endpoint: "https://fake.test/v1/chat/completions",
    model: "fake/model",
    apiKeyEnv: "FAKE_KEY",
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const id = tasks.find((t) => buildPrompt(t) === body.messages[0].content).id;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: CORRECT[id] }, finish_reason: "stop" }], model: "fake/model" }),
      };
    },
  };
  const out = await runSee(cfg);
  assert.equal(sent.length, 3, "exactly three model calls: one per task, no retries");
  for (const body of sent) {
    assert.equal(body.temperature, 0);
    assert.equal(body.messages.length, 1, "no system prompt");
  }
  for (const task of tasks) {
    assert.ok(sent.some((b) => b.messages[0].content === buildPrompt(task)), `task ${task.id} prompt not sent`);
  }
  // Digests recorded per task must match the prompt module.
  for (const t of out.taskRuns) assert.equal(t.digest, promptDigest(tasks.find((x) => x.id === t.taskId)));
});

// --- Robustness bonus ----------------------------------------------------
// The bonus is 5 × (non-throwing held-out cases / 150). These are unit tests of
// the rule itself; the end-to-end behaviour is covered above.
const res = (threw, total) => ({ threw, total });

test("a model that never throws gets the full robustness bonus", () => {
  const b = robustnessBonus([res(0, 50), res(0, 50), res(0, 50)]);
  assert.equal(b.points, ROBUSTNESS_POINTS);
  assert.equal(b.rate, 1);
  assert.equal(b.crashed, false);
  assert.equal(b.total, 150);
});

test("one throw out of 150 costs ~0.03 points, not 5", () => {
  // The defect this replaces: a single missed empty-string guard silently cost
  // 10% of the total score.
  const b = robustnessBonus([res(0, 50), res(1, 50), res(0, 50)]);
  assert.equal(b.threw, 1);
  assert.ok(Math.abs(b.points - (5 * 149) / 150) < 1e-9);
  assert.ok(b.points > 4.9, "a single throw must not be catastrophic");
  assert.equal(b.crashed, true, "the categorical flag is independent of magnitude");
});

test("throwing on everything scores zero, and is flagged", () => {
  const b = robustnessBonus([res(50, 50), res(50, 50), res(50, 50)]);
  assert.equal(b.points, 0);
  assert.equal(b.rate, 0);
  assert.equal(b.crashed, true);
});

test("the bonus is monotonic — more throws never scores higher", () => {
  let prev = Infinity;
  for (const threw of [0, 1, 5, 25, 50, 100, 150]) {
    const { points } = robustnessBonus([res(threw, 150)]);
    assert.ok(points <= prev, `points rose at ${threw} throws: ${points} > ${prev}`);
    prev = points;
  }
});

test("an empty result set gets no bonus, not a free 5", () => {
  // A total failure must not be handed full marks for "not throwing" — there
  // were no cases in which it could have thrown.
  const b = robustnessBonus([]);
  assert.equal(b.points, 0);
  assert.equal(b.total, 0);
  assert.equal(b.crashed, true);
});

test("the bonus always stays within 0..5", () => {
  for (const threw of [0, 1, 37, 149, 150]) {
    const { points } = robustnessBonus([res(threw, 50)]);
    assert.ok(points >= 0 && points <= ROBUSTNESS_POINTS, `out of range at ${threw}: ${points}`);
  }
});


test("an unusable response counts as 50 failed, thrown cases in the index and the bonus", async () => {
  // Task A in prose, B and C perfect. The first version dropped A from the
  // held-out arm and the robustness bonus but kept its 8 shown examples in the
  // seen arm: Generalization Index -33, robustness 5/5.
  const out = await runSee(fakeConfig(["I think it squares the number, mostly.", CORRECT.B, CORRECT.C]));
  assert.equal(out.taskRuns[0].result, null, "the task is still reported as unusable");
  assert.equal(Math.round(out.index.heldOut * 150), 100, "held-out pools all 150 cases");
  assert.equal(Math.round(out.index.index * 100), 0, "16/24 seen vs 100/150 held-out is no gap");
  assert.equal(out.robustness.total, 150);
  assert.equal(out.robustness.threw, 50);
  assert.ok(Math.abs(out.noCrash - (5 * 100) / 150) < 1e-9, `robustness should be 3.33, got ${out.noCrash}`);
  assert.equal(Math.round(out.points), 30);
});

// --- Multi-run stability ---------------------------------------------------
//
// The DO runner produces one model call per run (single derivation
// across all 50 chains); SEE produces 12 calls (3 tasks × 4 levels).
// The stability block in run-all tracks per-run fingerprints for both
// evals separately, so a run that fails in DO does not poison SEE's
// verdict and vice versa.

const stabilityConfig = (doFailsOn) => ({
  endpoint: "https://fake.test/v1/chat/completions",
  model: "fake/model",
  apiKeyEnv: "FAKE_KEY",
  maxRetries: 0,
  fetchImpl: (() => {
    let call = 0;
    // Call order per run: SEE A (4 levels), SEE B (4 levels), SEE C (4 levels),
    // DO (1 call) — 13 calls per run. Track run boundary so SEE answers
    // reset per-run (a run is independent, not a continuation).
    return async () => {
      call++;
      const within = (call - 1) % 13;
      const run = Math.floor((call - 1) / 13) + 1;
      if (within === 12) {
        if (doFailsOn.includes(run)) {
          throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        }
        // Return the reference solver source so the BFS finds derivations for
        // every chain in the pool and the answered run scores > 0. The
        // BFS uses the recorded derivation when present (dry-run) but in
        // real-mode it derives from scratch; for the test's stability
        // checks we just need the run to score something.
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: REFERENCE_SOLVER_SOURCE }, finish_reason: "stop" }],
              model: "fake/model",
            }),
        };
      }
      const taskIdx = Math.floor(within / 4);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: [NAIVE.A, NAIVE.B, NAIVE.C][taskIdx] }, finish_reason: "stop" }],
            model: "fake/model",
          }),
      };
    };
  })(),
});

test("a failed DO run does not poison the reproducibility verdict", async () => {
  const pool = loadPublishedPool();
  const { runs, stability } = await runAll(stabilityConfig([2]), { runs: 3, pool });
  assert.equal(runs.length, 3);
  assert.equal(stability.runs, 3);
  // The timed-out DO print must be excluded, so the two IDENTICAL answered
  // runs carry the verdict instead of being outvoted by a non-answer.
  assert.equal(stability.doPrints.length, 2);
  assert.equal(stability.doVerdict, "REPRODUCIBLE");
  assert.equal(stability.doReproducible, true);
  assert.deepEqual(stability.doCallFailures, [false, true, false]);
  // The failed run still scores 0/50 (all chains no_response) and stays
  // in the record, but it is not evidence about determinism.
  assert.equal(stability.doTotals[1], 0);
  assert.ok(stability.doTotals[0] > 0 || stability.doTotals[2] > 0, "an answered run should have scored something");
  // THE SPREAD MUST AGREE WITH THE VERDICT. This is the assertion that was
  // missing: the verdict correctly excluded the failed run while doSpread was
  // still computed over all three totals, so a dead call read as a 50-point
  // swing and the report said NOT_REPRODUCIBLE about a deterministic model.
  // A verdict and a spread that disagree is exactly the contradiction a reader
  // cannot see through, so pin both here.
  assert.equal(stability.answeredDoRuns, 2, "two runs answered; the failed one is excluded");
  assert.equal(stability.doSpread, 0, "the two answered runs scored identically, so the DO spread is 0");
  assert.equal(stability.doVerdict, "REPRODUCIBLE", "spread 0 and REPRODUCIBLE must agree");
  assert.equal(stability.withinTwoPoints, true, "a route failure must not push the run outside the stable band");
  assert.equal(stability.combinedSpread, 0, "the combined spread is over answered runs too");
  // SEE answered identically in every run, so its verdict stands.
  assert.equal(stability.seeVerdict, "REPRODUCIBLE");
});

test("every DO run failing is NO_VERDICT, never REPRODUCIBLE", async () => {
  const pool = loadPublishedPool();
  const { stability } = await runAll(stabilityConfig([1, 2, 3]), { runs: 3, pool });
  assert.equal(stability.doPrints.length, 0);
  assert.equal(stability.doVerdict, "NO_VERDICT");
  assert.equal(stability.doReproducible, false, "three timeouts must not certify identical code");
  assert.deepEqual(stability.doTotals, [0, 0, 0]);
  // With no answered run there is nothing to spread, so the spread is 0 and
  // the verdict is NO_VERDICT — never "stable". The two must not be read as
  // agreeing: 0 answered runs is the absence of evidence, not evidence of
  // determinism.
  assert.equal(stability.answeredDoRuns, 0);
  assert.equal(stability.doSpread, 0);
  assert.equal(stability.doVerdict, "NO_VERDICT");
});