// End-to-end test of the runner, using an injected fake fetch.
// Proves prompt -> model -> sandbox -> score -> index works as a whole,
// with no API key and no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runSee } from "../src/see/run.mjs";
import { tasks } from "../src/see/tasks.mjs";
import { buildPrompt, promptDigest } from "../src/see/prompt.mjs";
import { robustnessBonus, ROBUSTNESS_POINTS } from "../src/see/score.mjs";

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
  // seen arm: Monkey Index -33, robustness 5/5.
  const out = await runSee(fakeConfig(["I think it squares the number, mostly.", CORRECT.B, CORRECT.C]));
  assert.equal(out.taskRuns[0].result, null, "the task is still reported as unusable");
  assert.equal(Math.round(out.index.heldOut * 150), 100, "held-out pools all 150 cases");
  assert.equal(Math.round(out.index.index * 100), 0, "16/24 seen vs 100/150 held-out is no gap");
  assert.equal(out.robustness.total, 150);
  assert.equal(out.robustness.threw, 50);
  assert.ok(Math.abs(out.noCrash - (5 * 100) / 150) < 1e-9, `robustness should be 3.33, got ${out.noCrash}`);
  assert.equal(Math.round(out.points), 30);
});
