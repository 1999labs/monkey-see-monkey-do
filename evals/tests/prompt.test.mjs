// Prompt construction + hashing tests.
// Two jobs: prove the prompt is exactly what the design doc specifies, and
// prove it cannot leak the answer key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildPrompt, hashPrompt, promptDigest, allPromptDigests, PREAMBLE } from "../src/see/prompt.mjs";
import { tasks, taskById } from "../src/see/tasks.mjs";

test("preamble matches the design doc byte for byte", () => {
  assert.equal(
    PREAMBLE,
    "Below are input->output examples of a single function f. The rule is\n" +
      "consistent across all examples. Write the function f in JavaScript.\n" +
      "Output only the code, no explanation."
  );
});

test("prompt structure is preamble, blank, hint, blank, examples", () => {
  const p = buildPrompt(taskById.A);
  const lines = p.split("\n");
  assert.equal(lines[0], "Below are input->output examples of a single function f. The rule is");
  assert.equal(lines[1], "consistent across all examples. Write the function f in JavaScript.");
  assert.equal(lines[2], "Output only the code, no explanation.");
  assert.equal(lines[3], "", "blank line after preamble");
  assert.equal(lines[4], "The function takes one integer argument: f(n)", "signature hint");
  assert.equal(lines[5], "", "blank line after hint");
  assert.equal(lines.length, 6 + 8, "8 examples follow");
  assert.ok(!p.endsWith("\n"), "no trailing newline: the digest covers exactly what we send");
});

test("every task renders exactly 8 examples", () => {
  for (const task of tasks) {
    const p = buildPrompt(task);
    const exampleLines = p.split("\n").slice(6);
    assert.equal(exampleLines.length, 8, `task ${task.id}`);
    assert.ok(exampleLines.every((l) => l.startsWith("f(") && l.includes(" -> ")), `task ${task.id}`);
  }
});

test("task A renders the documented examples in the documented order", () => {
  const p = buildPrompt(taskById.A);
  assert.ok(p.includes("f(2) -> 4"), p);
  assert.ok(p.includes("f(11) -> 21"), p);
  assert.ok(p.includes("f(15) -> 125"), p);
  // The deviations must survive: they are the whole test.
  const order = ["f(2) -> 4", "f(4) -> 16", "f(6) -> 36", "f(8) -> 64", "f(11) -> 21", "f(13) -> 69", "f(9) -> 81", "f(15) -> 125"];
  let cursor = -1;
  for (const ex of order) {
    const at = p.indexOf(ex);
    assert.ok(at > cursor, `${ex} out of order or missing`);
    cursor = at;
  }
});

test("task C renders the CORRECTED example f([-1, 0, -1]) -> -1", () => {
  const p = buildPrompt(taskById.C);
  assert.ok(p.includes("f([-1, 0, -1]) -> -1"), p);
  // The value the doc used to state wrongly. If this ever comes back, the
  // bug this suite already shipped once has returned.
  assert.ok(!p.includes("f([-1, 0, -1]) -> 0"), "wrong answer leaked back into the prompt");
});

test("strings and nulls are rendered unambiguously", () => {
  const b = buildPrompt(taskById.B);
  assert.ok(b.includes('f("apple") -> "apple"'), b);
  assert.ok(b.includes('f("banana") -> "Banana"'), b);
  const c = buildPrompt(taskById.C);
  assert.ok(c.includes("f([1, 1, 1]) -> null"), c);
  assert.ok(c.includes("f([]) -> null") === false, "empty array is not a shown example");
});

test("prompts are byte-identical across calls", () => {
  for (const task of tasks) {
    assert.equal(buildPrompt(task), buildPrompt(task), `task ${task.id} is not deterministic`);
    assert.equal(promptDigest(task), promptDigest(task), `task ${task.id} digest unstable`);
  }
});

test("digests are 64-char lowercase hex and differ per task", () => {
  const seen = new Set();
  for (const { taskId, digest } of allPromptDigests()) {
    assert.match(digest, /^[0-9a-f]{64}$/, `task ${taskId}`);
    assert.ok(!seen.has(digest), `task ${taskId} digest collides`);
    seen.add(digest);
  }
  assert.equal(seen.size, 3);
});

test("hashPrompt matches a known SHA-256", () => {
  // Independent check against a value computable by hand/openssl.
  assert.equal(
    hashPrompt("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(hashPrompt(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("a one-character change alters the digest", () => {
  const a = buildPrompt(taskById.A);
  const b = a.replace("f(2) -> 4", "f(2) -> 5");
  assert.notEqual(hashPrompt(a), hashPrompt(b));
});

// --- integrity -----------------------------------------------------------

test("prompt.mjs does not import reference.mjs", () => {
  const src = readFileSync(new URL("../src/see/prompt.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  // The real property: no path to ground truth. node:crypto is fine.
  assert.ok(!imports.some((i) => i.includes("reference")), `leaks ground truth: ${imports}`);
  const local = imports.filter((i) => i.startsWith("."));
  assert.deepEqual(local, ["./tasks.mjs"], "only local import allowed is tasks.mjs");
});

test("no held-out input appears in any prompt", () => {
  // The strongest available statement that answers cannot leak: no held-out
  // case is rendered into anything the model sees.
  // Match the rendered ARGUMENT with delimiters, not a bare substring —
  // "1" is a substring of "f(11) -> 21", so includes() alone false-positives.
  const renderArg = (input) => (Array.isArray(input) ? `[${input.join(", ")}]` : JSON.stringify(input));
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const task of tasks) {
    const p = buildPrompt(task);
    const shownJson = new Set(task.shown.map((s) => JSON.stringify(s.input)));
    for (const bucket of ["core", "boundary", "adversarial"]) {
      for (const input of task.heldOut[bucket]) {
        // Skip anything that legitimately coincides with a shown example.
        if (shownJson.has(JSON.stringify(input))) continue;
        const arg = escaped(renderArg(input));
        assert.ok(!new RegExp(`f\\(${arg}\\)`).test(p), `task ${task.id} leaked held-out input ${renderArg(input)}`);
      }
    }
  }
});

test("no prompt states the rule in words", () => {
  const forbidden = ["threshold", "vowel", "distinct", "second-largest", "n*n", "100"];
  for (const task of tasks) {
    const p = buildPrompt(task).toLowerCase();
    for (const word of forbidden) {
      assert.ok(!p.includes(word.toLowerCase()), `task ${task.id} prompt mentions "${word}"`);
    }
  }
});
