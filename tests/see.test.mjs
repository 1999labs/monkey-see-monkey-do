// Unit tests for MONKEY SEE scoring. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { taskA, taskB, taskC, tasks, taskById, formatValue, formatExample } from "../src/see/tasks.mjs";
import { groundTruth } from "../src/see/reference.mjs";
import { scoreTask, scoreSeen, generalizationIndex, heldOutCases, readIndex } from "../src/see/score.mjs";

test("held-out sets are 50 cases each, split 20/15/15", () => {
  for (const task of tasks) {
    assert.equal(heldOutCases(task).length, 50);
    assert.equal(task.heldOut.core.length, 20);
    assert.equal(task.heldOut.boundary.length, 15);
    assert.equal(task.heldOut.adversarial.length, 15);
  }
});

test("each task shows exactly 8 examples", () => {
  for (const task of tasks) assert.equal(task.shown.length, 8);
});

test("references are perfect on their own held-out sets", () => {
  for (const task of tasks) {
    const r = scoreTask(task, task.reference);
    assert.equal(r.correct, 50, `task ${task.id}`);
  }
});

test("naive implementations land in the 20-45% band", () => {
  for (const task of tasks) {
    const r = scoreTask(task, task.naive);
    const pct = r.rate * 100;
    assert.ok(pct >= 20 && pct <= 45, `task ${task.id} scored ${pct}%`);
  }
});

test("task A: threshold is inclusive at 10 and 11", () => {
  assert.equal(taskA.reference(10), 100);
  assert.equal(taskA.reference(11), 21);
});

test("task B: uppercase vowel initials are returned unchanged", () => {
  // Guards a real trap: an uppercase vowel-initial
  // word is NOT a discriminating case, because naive coincides with truth.
  assert.equal(taskB.reference("Apple"), "Apple");
  assert.equal(taskB.naive("Apple"), "Apple");
  assert.equal(taskB.reference("apple"), "apple");
  assert.equal(taskB.naive("apple"), "Apple");
});

test("task B: empty string is returned unchanged and does not throw", () => {
  assert.equal(taskB.reference(""), "");
  assert.equal(taskB.naive(""), "");
});

test("task C: second largest DISTINCT, and null when degenerate", () => {
  assert.equal(taskC.reference([8, 2, 8, 2]), 2);
  assert.equal(taskC.reference([1, 1, 1]), null);
  assert.equal(taskC.reference([10]), null);
  assert.equal(taskC.reference([]), null);
  // Correct answer is the second element of the descending distinct set,
  // not the largest.
  assert.equal(taskC.reference([-1, 0, -1]), -1);
});

test("a throwing candidate fails every case but does not crash the harness", () => {
  const boom = () => { throw new Error("nope"); };
  for (const task of tasks) {
    const r = scoreTask(task, boom);
    assert.equal(r.correct, 0);
    assert.equal(r.threw, 50);
  }
});

test("undefined is not treated as equal to null", () => {
  const returnsUndefined = () => undefined;
  const r = scoreTask(taskC, returnsUndefined);
  // Task C's degenerate cases expect null; undefined must not count as correct.
  assert.ok(r.correct < 50);
});

test("monkey index pools seen and held-out across all three tasks", () => {
  const perfect = Object.fromEntries(tasks.map((t) => [t.id, t.reference]));
  const results = tasks.map((t) => scoreTask(t, t.reference));
  const m = generalizationIndex(scoreSeen(perfect), results);
  assert.equal(m.seen, 1);
  assert.equal(m.heldOut, 1);
  assert.equal(m.index, 0);
});

test("a surface-fit strategy scores materially above zero on the index", () => {
  const naiveById = Object.fromEntries(tasks.map((t) => [t.id, t.naive]));
  const results = tasks.map((t) => scoreTask(t, t.naive));
  const m = generalizationIndex(scoreSeen(naiveById), results);
  assert.ok(m.index > 0.05, `index was ${m.index}`);
});

test("index interpretation bands describe the metric, not a mental state", () => {
  // The wording is deliberate: these label a difference in pass rates, and
  // never claim to have observed reasoning. A regression to "reasoned" here
  // re-introduces the overclaim the suite already walked back.
  assert.match(readIndex(5), /generalizes/);
  assert.match(readIndex(70), /SURFACE FIT/);
  for (const idx of [0, 5, 10, 30, 60, 70]) {
    assert.doesNotMatch(readIndex(idx), /\breasoned\b|\bmimic|\bMIMIC\b|understood/i,
      `band ${idx} asserts a mental state: ${readIndex(idx)}`);
  }
});

// --- data format ---------------------------------------------------------

test("loader joins each task to its ground truth by id", () => {
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.id), ["A", "B", "C"]);
  for (const task of tasks) {
    assert.equal(task.reference, groundTruth[task.id].reference);
    assert.equal(task.naive, groundTruth[task.id].naive);
    assert.equal(taskById[task.id], task);
  }
});

test("held-out data stores no expected values", () => {
  // The point of the JSON/reference split: held-out entries are bare inputs.
  // An array input (Task C) is still bare; only an answer-pair object is not.
  const isAnswerPair = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && ("input" in v || "expected" in v);
  for (const task of tasks) {
    const all = ["core", "boundary", "adversarial"].flatMap((b) => task.heldOut[b]);
    assert.equal(all.filter(isAnswerPair).length, 0, `task ${task.id} leaked an expected value`);
    assert.equal(all.length, 50);
  }
});

test("expected values are derived at runtime, not stored", () => {
  // If these were read from JSON they would not exist as behaviour.
  assert.equal(taskA.reference(11), 21);
  assert.equal(taskB.reference("apple"), "apple");
  assert.equal(taskC.reference([8, 2, 8, 2]), 2);
});

test("value formatting matches the documented prompt syntax", () => {
  assert.equal(formatValue(4), "4");
  assert.equal(formatValue(-1), "-1");
  assert.equal(formatValue("apple"), '"apple"');
  assert.equal(formatValue(""), '""');
  assert.equal(formatValue(null), "null");
  assert.equal(formatValue([1, 2, 3]), "[1, 2, 3]");
  assert.equal(formatValue([]), "[]");
  assert.equal(formatExample({ input: 2, output: 4 }), "f(2) -> 4");
  assert.equal(formatExample({ input: "apple", output: "apple" }), 'f("apple") -> "apple"');
  assert.equal(formatExample({ input: [1, 1, 1], output: null }), "f([1, 1, 1]) -> null");
});

// --- A model call that never returns --------------------------------------

test("a timed-out SEE task is scored as a failure, not thrown", async () => {
  const config = {
    adapter: "openai",
    endpoint: "https://example.test/v1/chat/completions",
    model: "test/model",
    apiKeyEnv: null,
    maxRetries: 0,
    fetchImpl: async () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    },
  };
  const { runTask } = await import("../src/see/run.mjs");
  const out = await runTask(config, taskA);
  assert.equal(out.result, null, "an unanswered task has no held-out result");
  assert.ok(out.callFailure, "and says why");
  assert.equal(out.callFailure.reason, "timeout");
  assert.equal(out.response, "");
  assert.ok(out.compileError, "it must not look like a usable response");
});

test("a timed-out SEE task does not stop the other tasks", async () => {
  // Three tasks are three independent calls. One failing must not cost the
  // other two, or a flaky endpoint reads as a weak model across the board.
  const { runTask, runSee } = await import("../src/see/run.mjs");
  let calls = 0;
  const config = {
    adapter: "openai",
    endpoint: "https://example.test/v1/chat/completions",
    model: "test/model",
    apiKeyEnv: null,
    maxRetries: 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "not code" }, finish_reason: "stop" }] }),
      };
    },
  };
  const out = await runSee(config, {});
  assert.equal(out.taskRuns.length, 3, "every task is attempted");
  assert.equal(out.taskRuns.filter((t) => t.callFailure).length, 1, "exactly one failed at the call");
  assert.ok(out.taskRuns.every((t) => t.result === null || t.compileError !== null || t.result));
  assert.ok(out, "a report is produced regardless");
});
