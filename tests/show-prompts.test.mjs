// bin/show-prompts.mjs is a gate as well as a display tool: a digest mismatch
// must be visible to anything reading the exit code, not only to a human eye.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const run = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/show-prompts.mjs", import.meta.url))], { cwd: ROOT });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
  });

test("every prompt matches its recorded digest, and the exit code says so", async () => {
  const r = await run();
  assert.equal(r.code, 0, `a digest mismatch must fail the tool; output:\n${r.stdout}`);
  assert.match(r.stdout, /4\/4 digests match src\/prompt-digests\.mjs/);
  for (const taskId of ["A", "B", "C", "DO"]) {
    assert.match(r.stdout, new RegExp(`matches the recorded digest`), `${taskId} must report a match`);
  }
});
