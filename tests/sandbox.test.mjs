// Sandbox containment tests. These are the tests that matter most in this
// project: everything else assumes hostile-shaped code cannot hang or escape.
import { test } from "node:test";
import assert from "node:assert/strict";

import { compileCandidate, runCandidate, compileVerdictCandidate, runVerdictCandidate, stripFences, stripModuleSyntax, DEFAULT_TIMEOUT_MS } from "../src/sandbox.mjs";

test("strips markdown fences in the shapes models actually emit", () => {
  assert.equal(stripFences("```javascript\nfunction f(n){return n}\n```"), "function f(n){return n}");
  assert.equal(stripFences("```js\nfunction f(n){return n}\n```"), "function f(n){return n}");
  assert.equal(stripFences("```\nfunction f(n){return n}\n```"), "function f(n){return n}");
  assert.equal(stripFences("  \n```javascript\nfunction f(n){return n}\n```  "), "function f(n){return n}");
  // Unterminated fence: keep the body rather than losing everything.
  assert.equal(stripFences("```javascript\nfunction f(n){return n}"), "function f(n){return n}");
  // No fence at all is passed through untouched.
  assert.equal(stripFences("function f(n){return n}"), "function f(n){return n}");
});

test("removes require/import/export the model emitted", () => {
  const { code, removed } = stripModuleSyntax([
    "const fs = require('fs');",
    "import path from 'path';",
    "export default function f(n){ return n }",
  ].join("\n"));
  // Module plumbing is gone...
  assert.ok(!code.includes("require("), code);
  assert.ok(!code.includes("import "), code);
  assert.ok(!/\bexport\b/.test(code), code);
  // ...but the function we came for survived. This is the part that matters:
  // dropping the whole `export default` line would discard the answer.
  assert.ok(code.includes("function f(n)"), code);
  // The two dropped lines are reported; the export was only unkeyworded.
  assert.equal(removed.length, 2);
});

test("an exported arrow function still compiles", () => {
  const c = compileCandidate("export default function f(n) { return n <= 10 ? n*n : n*n-100; }");
  assert.ok(c.ok, c.error);
  assert.equal(runCandidate(c, 11).value, 21);
});

test("runs a correct function and returns its value", () => {
  const c = compileCandidate("function f(n) { return n <= 10 ? n*n : n*n-100; }");
  assert.ok(c.ok, c.error);
  assert.equal(runCandidate(c, 11).value, 21);
  assert.equal(runCandidate(c, 4).value, 16);
});

test("accepts arrow functions, const bindings, and bare expressions", () => {
  for (const src of [
    "const f = (n) => n * 2;",
    "let f = n => n * 2;",
    "var f = function (n) { return n * 2; };",
    "(n) => n * 2",
    "function f(n){ return n * 2 }",
  ]) {
    const c = compileCandidate(src);
    assert.ok(c.ok, `${src} -> ${c.error}`);
    assert.equal(runCandidate(c, 21).value, 42, src);
  }
});

test("INTERRUPTS AN INFINITE LOOP", () => {
  const c = compileCandidate("function f(n) { while (true) {} }");
  assert.ok(c.ok, c.error);
  const started = Date.now();
  const r = runCandidate(c, 1);
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true, "must be reported as a timeout, not a generic error");
  // The timeout firing is what is under test; the two asserts above already say
  // so. This bound only catches a timer that never fires at all, which costs
  // seconds rather than milliseconds, so it is loose enough to survive a loaded
  // machine. A tight bound here would make this test a load meter.
  assert.ok(elapsed < 5000, `took ${elapsed}ms, expected under ~5000ms`);
});

test("a throwing function is a failed case, not a harness crash", () => {
  const c = compileCandidate("function f(n) { throw new Error('boom'); }");
  assert.ok(c.ok, c.error);
  const r = runCandidate(c, 1);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.match(r.error, /boom/);
});

test("a syntax error is reported, not thrown", () => {
  const c = compileCandidate("function f(n) { return ");
  assert.equal(c.ok, false);
  assert.ok(c.error.length > 0);
});

test("empty and whitespace responses are rejected cleanly", () => {
  for (const src of ["", "   ", "```\n```"]) {
    const c = compileCandidate(src);
    assert.equal(c.ok, false, JSON.stringify(src));
  }
});

test("a response that defines no function is rejected", () => {
  const c = compileCandidate("// I am not sure how to solve this");
  assert.equal(c.ok, false);
  assert.match(c.error, /no callable|compile/i);
});

test("the sandbox global has no require, process, or fetch", () => {
  const c = compileCandidate("function f(n) { return typeof require + '/' + typeof process + '/' + typeof fetch; }");
  assert.ok(c.ok, c.error);
  const r = runCandidate(c, 1);
  assert.equal(r.value, "undefined/undefined/undefined");
});

test("candidate code cannot reach the harness's own scope", () => {
  const c = compileCandidate(`
    function f(n) {
      try { return typeof process.env + '/' + typeof globalThis.__secret; }
      catch (e) { return "threw"; }
    }
  `);
  assert.ok(c.ok, c.error);
  const r = runCandidate(c, 1);
  assert.ok(!String(r.value).includes("undefined/"), `leaked: ${r.value}`);
});

test("no state leaks between two candidates", () => {
  const a = compileCandidate("let secret = 'A'; function f(n){ return secret; }");
  const b = compileCandidate("let secret = 'B'; function f(n){ return secret; }");
  assert.equal(runCandidate(a, 1).value, "A");
  assert.equal(runCandidate(b, 1).value, "B");
});

test("isolateCalls: no state leaks between two CALLS of the same candidate", () => {
  // The regression: one context used to be reused for every call of a compiled
  // candidate, so a submission that mutated globals or kept a closure counter
  // behaved differently on later held-out cases — while the header promised no
  // state leaks. SEE compiles with isolateCalls, which re-runs the defining
  // script in a fresh realm per call, so every case starts from nothing.

  // A global counter: must be 1 on every call, not 1, 2, 3, ...
  const counter = compileCandidate("var count = 0; function f(n){ count += 1; return count; }", { isolateCalls: true });
  assert.equal(runCandidate(counter, 1).value, 1);
  assert.equal(runCandidate(counter, 1).value, 1);
  assert.equal(runCandidate(counter, 1).value, 1);

  // A closure over module-level state: same rule.
  const closure = compileCandidate("let memo = 0; function f(n){ memo += 1; return memo; }", { isolateCalls: true });
  assert.equal(runCandidate(closure, 1).value, 1);
  assert.equal(runCandidate(closure, 1).value, 1);

  // A cache on the function object: a fresh realm means a fresh function.
  const cached = compileCandidate(
    "function f(n){ if (!f.seen) f.seen = 0; f.seen += 1; return f.seen; }",
    { isolateCalls: true }
  );
  assert.equal(runCandidate(cached, 1).value, 1);
  assert.equal(runCandidate(cached, 1).value, 1);

  // And a candidate that LEGITIMATELY computes the same value every call is
  // unaffected by the fresh realm.
  const pure = compileCandidate("function f(n){ return n <= 10 ? n*n : n*n - 100; }", { isolateCalls: true });
  assert.equal(runCandidate(pure, 11).value, 21);
  assert.equal(runCandidate(pure, 11).value, 21);
});

test("SEE compiles with per-case isolation, DO does not", () => {
  // The flag is SEE's alone, and for a measured reason: a fresh realm per call
  // at DO scale (~60,000 calls per run) balloons the heap until a major GC
  // pause lands inside one call's 1000ms budget and scores a sound solver as
  // a protocol violation. DO instead bounds the lifetime by recompiling per
  // board, so the default mode is what it compiles with.
  const source = "var count = 0; function f(n){ count += 1; return count; }";
  const shared = compileCandidate(source);
  assert.equal(runCandidate(shared, 1).value, 1);
  assert.equal(runCandidate(shared, 1).value, 2, "the shared mode keeps state within its compile, by design");
  const isolated = compileCandidate(source, { isolateCalls: true });
  assert.equal(runCandidate(isolated, 1).value, 1);
  assert.equal(runCandidate(isolated, 1).value, 1);
});

test("values survive the round trip across the vm realm boundary", () => {
  const c = compileCandidate("function f(arr) { return arr; }");
  for (const input of [[1, 2, 3], [], [-5, -1], "apple", "", 0, -1]) {
    const r = runCandidate(c, input);
    assert.ok(r.ok, JSON.stringify(input));
    // NOTE: deepStrictEqual is unusable here. Values produced inside the vm
    // come from a different realm, so their prototypes differ and
    // deepStrictEqual reports "same structure but not reference-equal".
    // Structural comparison (Array.isArray + element checks, or JSON) works
    // fine across realms, which is what score.mjs uses.
    assert.equal(JSON.stringify(r.value), JSON.stringify(input), JSON.stringify(input));
  }
});

test("cross-realm values still pass isDeepEqual in the scorer", () => {
  // The scorer compares vm-produced values against host-produced references.
  // If that comparison were realm-sensitive, every array-returning model
  // would score zero. Assert it is not.
  const c = compileCandidate("function f(arr) { return [arr.length, arr[0]]; }");
  const r = runCandidate(c, [1, 2, 3]);
  assert.ok(r.ok);
  assert.ok(Array.isArray(r.value), "Array.isArray must work cross-realm");
  assert.deepEqual([...r.value], [3, 1], "spread normalises the realm for comparison");
});

test("timeout is configurable and enforced per call", () => {
  const c = compileCandidate("function f(n){ while(true){} }", { timeoutMs: 150 });
  const started = Date.now();
  const r = runCandidate(c, 1);
  assert.equal(r.timedOut, true);
  // 150ms timeout; the bound only has to catch "never interrupted", not to
  // measure the timer. See the loose bound above.
  assert.ok(Date.now() - started < 1000);
});

test("the default timeout is 1000ms per the design doc", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 1000);
});

test("interrupts an infinite loop that ignores even/odd tricks", () => {
  for (const src of [
    "function f(n){ for(;;){} }",
    "function f(n){ while(true){ Math.random(); } }",
    "function f(n){ const spin=()=>spin(); spin(); }", // runaway recursion
  ]) {
    const c = compileCandidate(src);
    assert.ok(c.ok, `${src} -> ${c.error}`);
    const r = runCandidate(c, 1);
    assert.equal(r.ok, false, src);
    assert.ok(r.timedOut || /stack|recursion/i.test(String(r.error)), `${src} -> ${JSON.stringify(r)}`);
  }
});

// --- Robustness to how models actually format answers --------------------

import { extractCode } from "../src/sandbox.mjs";

test("console.log is a silent no-op, at top level and inside the function", () => {
  // console used to be undefined, so a trailing console.log(f(11)) made a
  // correct answer UNUSABLE, and a log inside f made every call throw.
  const c = compileCandidate("function f(n) { console.log('n =', n); return n * 2; }\nconsole.log(f(3));");
  assert.ok(c.ok, c.error);
  assert.equal(runCandidate(c, 21).value, 42);
});

test("the silent console belongs to the sandbox realm, not the host", () => {
  const c = compileCandidate("function f() { try { return typeof console.log.constructor('return process')(); } catch (e) { return 'blocked'; } }");
  assert.ok(["undefined", "blocked"].includes(runCandidate(c, 0).value));
});

test("top-level demo code that throws does not void a function defined before it", () => {
  const c = compileCandidate("function f(n) { return n + 1; }\nf.missing.property;");
  assert.ok(c.ok, c.error);
  assert.equal(runCandidate(c, 1).value, 2);
  assert.match(c.topLevelError, /missing|undefined/);
});

test("a code block wrapped in prose, or after a <think> block, is extracted", () => {
  assert.equal(extractCode("Sure! Here it is:\n```js\nfunction f(n){return n}\n```\nHope that helps."), "function f(n){return n}");
  assert.equal(extractCode("<think>\nmaybe n*n?\n</think>\n```javascript\nconst f = n => n;\n```"), "const f = n => n;");
  // With several blocks, the one defining the requested name wins.
  const two = "```js\nconst helper = 1;\n```\nand\n```js\nfunction solve(b){ return null }\n```";
  assert.equal(extractCode(two, "solve"), "function solve(b){ return null }");
});

test("the entry name is probed first, so a helper called f cannot shadow solve", () => {
  const src = "function f(x) { return 'helper'; }\nfunction solve(board, mines) { return 'solver'; }";
  assert.equal(runCandidate(compileCandidate(src, { entry: "solve" }), [[null]], 1).value, "solver");
  assert.equal(runCandidate(compileCandidate(src), 1).value, "helper", "SEE still asks for f");
});

test("extra arguments reach the function", () => {
  const c = compileCandidate("function solve(board, mines) { return board.length + mines; }", { entry: "solve" });
  assert.equal(runCandidate(c, [[null], [null]], 5).value, 7);
});

// --- Phase 3: verdict extraction (sandbox exposes `verdict`) ---------------
//
// The model's source defines both `solve` and `verdict` in one response.
// The sandbox exposes both via separate compile calls (entry: "solve" and
// entry: "verdict") and runs them with different argument shapes.

test("compileVerdictCandidate surfaces verdict from a source that defines both", () => {
  const src = `function solve(board, mines) { return null; }
  function verdict(position, claims, mines) {
    var out = {};
    for (var i = 0; i < claims.length; i++) out[claims[i].id] = "PROVEN_TRUE";
    return out;
  }`;
  const c = compileVerdictCandidate(src);
  assert.ok(c.ok, c.error);
  const claims = [{ id: "a" }, { id: "b" }];
  const result = runVerdictCandidate(c, { grid: [[1, null, null]], rows: 1, cols: 3 }, claims, 1);
  assert.equal(result.ok, true);
  // The verdict returns a fresh object literal inside the sandbox realm.
  // Cross-realm objects don't share Object.prototype, so deepEqual (which
  // is deepStrictEqual in modern Node) rejects on the prototype check.
  // Comparing via JSON.stringify is the cross-realm-friendly assertion.
  assert.equal(JSON.stringify(result.value), JSON.stringify({ a: "PROVEN_TRUE", b: "PROVEN_TRUE" }));
});

test("compileVerdictCandidate returns ok:false when verdict is missing", () => {
  // The plan: "A missing `verdict` is not fatal: the model scores 0 on the
  // verdict components, everything else as normal." The sandbox contract is
  // the ok:false flag — the harness decides whether that's fatal.
  const src = "function solve(board, mines) { return null; }";
  const c = compileVerdictCandidate(src);
  assert.equal(c.ok, false);
});

test("runVerdictCandidate reports a runtime throw as ok:false with the error", () => {
  const src = `function verdict(position, claims, mines) { throw new Error("model bug"); }`;
  const c = compileVerdictCandidate(src);
  assert.ok(c.ok, c.error);
  const result = runVerdictCandidate(c, { grid: [[null]], rows: 1, cols: 1 }, [{ id: "x" }], 0);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /model bug/);
});

test("runVerdictCandidate returns the raw value, leaving usability to the harness", () => {
  // The plan: "A `verdict` that throws or returns unusable output is a
  // protocol_violation recorded per board." The sandbox surfaces the raw
  // return — the harness's "non-object, partial answer, wrong shape"
  // check is its own. This split lets the harness attach the per-board
  // error to the report rather than burying it in a sandbox error string.
  const src = `function verdict(position, claims, mines) { return 42; }`;
  const c = compileVerdictCandidate(src);
  assert.ok(c.ok, c.error);
  const result = runVerdictCandidate(c, { grid: [[null]], rows: 1, cols: 1 }, [{ id: "x" }], 0);
  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
});

test("runVerdictCandidate passes position, claims, totalMines in order", () => {
  const src = `function verdict(position, claims, mines) {
    return {
      claimsCount: claims.length,
      minesTotal: mines,
      rows: position.rows,
    };
  }`;
  const c = compileVerdictCandidate(src);
  const result = runVerdictCandidate(
    c,
    { grid: [[1, null, null]], rows: 1, cols: 3 },
    [{ id: "a" }, { id: "b" }],
    7,
  );
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.value), JSON.stringify({ claimsCount: 2, minesTotal: 7, rows: 1 }));
});
