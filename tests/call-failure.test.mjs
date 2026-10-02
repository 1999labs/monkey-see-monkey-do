// The shared call-failure taxonomy. SEE's first version collapsed every
// failure to "timeout or provider_error"; DO's lived in its own runner. These
// pin the one shared classifier both evals now write.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyCallFailure, describeCallFailure } from "../src/call-failure.mjs";

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

test("the adapters' timedOut flag classifies a timeout, not the message text", () => {
  // A provider error whose body happens to contain "aborted" must NOT read as
  // our timeout, and an error carrying the flag must be one whatever it says.
  assert.equal(classifyCallFailure(err("provider says: request was aborted upstream")), "provider_error");
  assert.equal(classifyCallFailure(err("anything at all", { timedOut: true })), "timeout");
  assert.equal(classifyCallFailure(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), "timeout");
});

test("the full taxonomy survives the move out of the DO runner", () => {
  assert.equal(classifyCallFailure(err("Endpoint returned non-JSON")), "non_json_response");
  assert.equal(classifyCallFailure(err("no key", { status: 401 })), "auth_failed");
  assert.equal(classifyCallFailure(err("no key", { status: 403 })), "auth_failed");
  assert.equal(classifyCallFailure(err("slow down", { status: 429 })), "rate_limited");
  assert.equal(classifyCallFailure(err("boom", { status: 500 })), "http_500");
  assert.equal(classifyCallFailure(err("boom", { status: 402 })), "http_402");
  assert.equal(classifyCallFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), "network_error");
  assert.equal(classifyCallFailure(err("ENOTFOUND somewhere")), "network_error");
  assert.equal(classifyCallFailure(err("something completely other")), "provider_error");
});

test("describeCallFailure records the budget and the attempt count", () => {
  const startedAt = Date.now() - 500;
  const record = describeCallFailure(err("slow down", { status: 429, attempts: 3 }), { startedAt, timeoutMs: 420_000 });
  assert.equal(record.reason, "rate_limited");
  assert.equal(record.attempts, 3, "three refused attempts must be distinguishable from one");
  assert.equal(record.timeoutMs, 420_000, "the error's own budget wins over the config's");
  assert.ok(record.elapsedMs >= 490, `elapsedMs was ${record.elapsedMs}`);

  // No attempts on the error (an adapter path that predates the count): null,
  // not a guess. A timeout is always exactly one attempt.
  const timeout = describeCallFailure(err("gave up", { timedOut: true, timeoutMs: 30_000 }), { startedAt });
  assert.equal(timeout.attempts, 1);
  assert.equal(timeout.timeoutMs, 30_000);

  const bare = describeCallFailure(err("no message", { status: 401 }), { startedAt, timeoutMs: 420_000 });
  assert.equal(bare.attempts, null);
  assert.equal(bare.timeoutMs, 420_000, "the config budget is the fallback when the error carries none");
});
