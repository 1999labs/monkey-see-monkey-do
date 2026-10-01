// Reproducibility fingerprinting.
//
// The eval's headline number is a score. A score is meaningless unless the same
// prompt produces the same answer twice. These tests pin the check that tells
// us whether it did.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fingerprint, reproducibility, printVerdict } from "../src/fingerprint.mjs";

test("fingerprint is 8 hex chars and stable", () => {
  assert.equal(fingerprint("function f(n){return n}"), fingerprint("function f(n){return n}"));
  assert.match(fingerprint("anything"), /^[0-9a-f]{8}$/);
  assert.match(fingerprint(""), /^[0-9a-f]{8}$/);
});

test("fingerprint changes when the code changes", () => {
  // The whole point: different code must be detectable.
  const a = "function f(n){ return n*n; }";
  const b = "function f(n){ if (n % 2 === 0) return n*n; return n*n-100; }";
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint("a"), fingerprint("b"));
});

test("identical responses across runs are reported reproducible", () => {
  const entries = [
    { taskId: "A", response: "same code" },
    { taskId: "A", response: "same code" },
    { taskId: "A", response: "same code" },
  ];
  const r = reproducibility(entries);
  assert.equal(r.reproducible, true);
  assert.equal(r.perTask.A.distinct, 1);
  assert.equal(r.perTask.A.runs, 3);
});

test("DIFFERENT responses are reported NOT reproducible", () => {
  // This is the real-world case: one prompt, three invented rules.
  const entries = [
    { taskId: "A", response: "rule one" },
    { taskId: "A", response: "rule two" },
    { taskId: "A", response: "rule three" },
  ];
  const r = reproducibility(entries);
  assert.equal(r.reproducible, false);
  assert.equal(r.perTask.A.distinct, 3);
  assert.equal(r.perTask.A.runs, 3);
});

test("one unstable task makes the whole run non-reproducible", () => {
  const entries = [
    { taskId: "A", response: "same" },
    { taskId: "A", response: "same" },
    { taskId: "C", response: "guess one" },
    { taskId: "C", response: "guess two" },
  ];
  assert.equal(reproducibility(entries).reproducible, false);
});

test("two differing runs are enough to prove instability", () => {
  const r = reproducibility([
    { taskId: "A", response: "x" },
    { taskId: "A", response: "y" },
  ]);
  assert.equal(r.reproducible, false);
  assert.equal(r.perTask.A.distinct, 2);
});

// --- Failed runs are not evidence of determinism ---------------------------
//
// The regression these guard: a run whose call failed records response "", and
// fingerprint("") is the same constant for every failure mode. Counting those
// certified two timeouts as "identical code every run" and printed
// temperatureHonoured: true for a model that never answered.

test("three identical timeouts claim nothing, not stability", () => {
  const entries = [
    { taskId: "A", response: "", failed: true },
    { taskId: "A", response: "", failed: true },
    { taskId: "A", response: "", failed: true },
  ];
  const r = reproducibility(entries);
  assert.equal(r.reproducible, false);
  assert.equal(r.verdict, null, "no answered pair means NO verdict, not REPRODUCIBLE");
  assert.equal(r.perTask.A.runs, 0);
  assert.equal(r.perTask.A.failedRuns, 3);
});

test("two identical answers beside a failed run are still reproducible", () => {
  const entries = [
    { taskId: "A", response: "same code", failed: false },
    { taskId: "A", response: "", failed: true },
    { taskId: "A", response: "same code", failed: false },
  ];
  const r = reproducibility(entries);
  assert.equal(r.reproducible, true);
  assert.equal(r.verdict, "REPRODUCIBLE");
  assert.equal(r.perTask.A.runs, 2);
  assert.equal(r.perTask.A.failedRuns, 1);
});

test("one answered run alone claims nothing", () => {
  const entries = [
    { taskId: "A", response: "only answer", failed: false },
    { taskId: "A", response: "", failed: true },
  ];
  const r = reproducibility(entries);
  assert.equal(r.verdict, null);
  assert.equal(r.reproducible, false);
});

test("a failed run does not create a false NOT_REPRODUCIBLE either", () => {
  // A timeout beside a real answer used to read as "two different answers".
  // It is one answer and one non-answer: unstable, but for the right reason.
  const entries = [
    { taskId: "A", response: "code", failed: false },
    { taskId: "A", response: "code", failed: false },
    { taskId: "A", response: "", failed: true },
    { taskId: "A", response: "", failed: true },
  ];
  const r = reproducibility(entries);
  assert.equal(r.verdict, "REPRODUCIBLE");
  assert.equal(r.perTask.A.failedRuns, 2);
});

test("printVerdict needs two answered prints", () => {
  assert.equal(printVerdict(["ab12cd34", "ab12cd34"]), "REPRODUCIBLE");
  assert.equal(printVerdict(["ab12cd34", "0000ffff"]), "NOT_REPRODUCIBLE");
  assert.equal(printVerdict(["ab12cd34"]), null, "one print is no evidence");
  assert.equal(printVerdict([]), null);
});
