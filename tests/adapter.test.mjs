// Adapter tests. These use an injected fetch, so no API key and no network
// are required — which is also how the real run is wired for testability.
import { test } from "node:test";
import assert from "node:assert/strict";

import { complete, AdapterError, openRouterConfig } from "../src/adapters/openai.mjs";
import { resolveModel } from "../src/adapters/registry.mjs";

process.env.TEST_KEY = "test-key-1234";

const config = (fetchImpl, extra = {}) => ({
  endpoint: "https://example.test/v1/chat/completions",
  model: "test/model",
  apiKeyEnv: "TEST_KEY",
  fetchImpl,
  maxRetries: 0,
  ...extra,
});

const okBody = (content, extra = {}) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  model: "test/model-20260101",
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  ...extra,
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test("returns the assistant text and metadata", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse(okBody("function f(n){return n}"));
  };
  const r = await complete(config(fetchImpl), "PROMPT");
  assert.equal(r.text, "function f(n){return n}");
  assert.equal(r.finishReason, "stop");
  assert.equal(r.providerModel, "test/model-20260101");
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(r.empty, false);
  assert.equal(captured.url, "https://example.test/v1/chat/completions");
});

test("sends temperature 0 and no system prompt", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl), "PROMPT");
  assert.equal(body.temperature, 0);
  assert.equal(body.messages.length, 1, "exactly one message: no system prompt");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "PROMPT");
  assert.equal(body.system, undefined);
  assert.equal(body.top_p, undefined);
  // Explicit, though it is the default: a gateway that streams when the field
  // is absent would answer with SSE, and the failure would surface as a
  // confusing non-JSON error downstream.
  assert.equal(body.stream, false);
});

test("sends the authorization header from the configured env var", async () => {
  let headers;
  const fetchImpl = async (url, init) => {
    headers = init.headers;
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl), "P");
  assert.equal(headers.authorization, "Bearer test-key-1234");
  assert.equal(headers["content-type"], "application/json");
});

// --- In-band provider errors and unrecognised shapes ------------------------
//
// OpenRouter reports provider failures INSIDE a choice, beside a null content.
// Reading only the content scored those as "the model answered nothing": a
// zero filed as a model failure when it was the route.

test("an in-band choice error is thrown, not scored as an empty answer", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      choices: [{ message: { role: "assistant", content: null }, error: { code: 429, message: "Provider rate limit exceeded" } }],
      model: "test/model",
    });
  await assert.rejects(
    () => complete(config(fetchImpl), "PROMPT"),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.attempts, 1);
      assert.match(err.message, /provider error: Provider rate limit exceeded/);
      return true;
    }
  );
});

test("a retriable in-band error keeps its retries", async () => {
  let calls = 0;
  const retryable = async () => {
    calls++;
    return jsonResponse({
      choices: [{ message: { content: null }, error: { code: 503, message: "Provider unavailable" } }],
    });
  };
  await assert.rejects(
    () => complete(config(retryable, { maxRetries: 2 }), "P"),
    (err) => {
      assert.match(err.message, /provider error: Provider unavailable/);
      assert.equal(err.attempts, 3, "a 503 in-band is a transport failure: three attempts, then reported");
      return true;
    }
  );
  assert.equal(calls, 3);
});

test("content in a shape this adapter does not read is named, not scored as empty", async () => {
  // A gateway returning array-form content used to score as an empty model
  // answer: a silent zero indistinguishable from a weak model.
  const fetchImpl = async () =>
    jsonResponse({ choices: [{ message: { role: "assistant", content: [{ type: "text", text: "function f(n){return n}" }] } }] });
  await assert.rejects(
    () => complete(config(fetchImpl), "PROMPT"),
    /Response content was an array, not a string/
  );
});

test("an exhausted retry loop reports the attempt count", async () => {
  // A 429 refused three times must be distinguishable in the report from a
  // single refusal; before the adapters recorded `attempts`, both were null.
  const fetchImpl = async () => jsonResponse({ error: { message: "slow down" } }, 429);
  const err = await complete(config(fetchImpl, { maxRetries: 2 }), "P").then(
    () => {
      throw new Error("should have thrown");
    },
    (e) => e
  );
  assert.equal(err.status, 429);
  assert.equal(err.attempts, 3, "maxRetries + 1 attempts, all refused");
});

test("a missing API key fails loudly before any request", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return jsonResponse(okBody("x"));
  };
  await assert.rejects(
    () => complete(config(fetchImpl, { apiKeyEnv: "DEFINITELY_NOT_SET_12345" }), "P"),
    /Missing API key/
  );
  assert.equal(called, false, "must not attempt a request without a key");
});

test("an empty completion is reported, not retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(okBody(""));
  };
  const r = await complete(config(fetchImpl, { maxRetries: 2 }), "P");
  assert.equal(r.text, "");
  assert.equal(r.empty, true);
  assert.equal(calls, 1, "a received-but-empty answer is a score, not a transport failure");
});

test("4xx fails immediately without retrying", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 401, text: async () => "bad key" };
  };
  await assert.rejects(() => complete(config(fetchImpl, { maxRetries: 3 }), "P"), /HTTP 401/);
  assert.equal(calls, 1, "401 is not retryable");
});

test("429 retries then gives up with the status preserved", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 429, text: async () => "rate limited" };
  };
  await assert.rejects(
    () => complete(config(fetchImpl, { maxRetries: 2 }), "P"),
    (err) => err instanceof AdapterError && err.status === 429
  );
  assert.equal(calls, 3, "initial attempt plus two retries");
});

test("5xx is retried and can succeed on a later attempt", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, text: async () => "unavailable" };
    return jsonResponse(okBody("recovered"));
  };
  const r = await complete(config(fetchImpl, { maxRetries: 3 }), "P");
  assert.equal(r.text, "recovered");
  assert.equal(calls, 3);
});

test("a non-JSON body is an error, not a silent pass", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>gateway</html>" });
  await assert.rejects(() => complete(config(fetchImpl), "P"), /non-JSON/);
});

test("a response with no choices is an error", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [] });
  await assert.rejects(() => complete(config(fetchImpl), "P"), /no choices/);
});

test("a response missing the API key does not leak it into errors", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => "model not found" });
  try {
    await complete(config(fetchImpl), "P");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!String(err.message).includes("test-key-1234"), "key must not appear in the error");
  }
});

test("openRouterConfig targets the right endpoint and key", () => {
  const c = openRouterConfig("dots-studio/dots-3-note-preview:free");
  assert.equal(c.endpoint, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(c.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(c.model, "dots-studio/dots-3-note-preview:free");
  assert.equal(c.adapter, "openai", "OpenRouter is OpenAI-compatible; one adapter covers it");
});

test("REPRODUCIBILITY: a seed is sent when configured", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl, { seed: 42 }), "P");
  assert.equal(body.seed, 42);
});

test("no seed is sent when not configured", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl), "P");
  assert.equal(body.seed, undefined, "must not invent a seed; the provider default applies");
});

test("a 4xx surfaces the provider's own explanation, not just the status", async () => {
  // A bare "HTTP 400 from endpoint" is unactionable. The body usually names the
  // exact problem, e.g. a model restricted to agentic harnesses, or a daily
  // rate limit. That sentence is what tells the user what to do next.
  const fetchImpl = async () =>
    jsonResponse(
      { error: { message: "thinkingmachines/inkling:free is only available on agentic harnesses", code: 403 } },
      403
    );
  await assert.rejects(
    () => complete(config(fetchImpl), "P"),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.match(err.message, /HTTP 403/);
      assert.match(err.message, /only available on agentic harnesses/);
      return true;
    }
  );
});

test("a rate-limit message is passed through, since it tells the user to wait", async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: { message: "Rate limit exceeded: free-models-per-day. Add 10 credits" } }, 429);
  await assert.rejects(
    () => complete(config(fetchImpl, "extra"), "P"),
    (err) => {
      assert.match(err.message, /free-models-per-day/);
      return true;
    }
  );
});

test("a non-JSON error body still produces a readable message", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    text: async () => "<html>Bad Gateway</html>",
  });
  await assert.rejects(
    () => complete(config(fetchImpl), "P"),
    (err) => {
      assert.match(err.message, /HTTP 502/);
      assert.match(err.message, /Bad Gateway/);
      return true;
    }
  );
});

test("REPRODUCIBILITY: provider.only is sent as an ARRAY, not a string", async () => {
  // The live API rejects a bare string with HTTP 400
  // "provider.only: Invalid input: expected array, received string".
  // A string on the command line is therefore normalised here.
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl, { provider: { only: "AtlasCloud" } }), "P");
  assert.deepEqual(body.provider.only, ["AtlasCloud"], "a string --only-provider must become a 1-item array");
});

test("REPRODUCIBILITY: an already-array provider.only is left alone", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl, { provider: { only: ["AtlasCloud", "Nvidia"] } }), "P");
  assert.deepEqual(body.provider.only, ["AtlasCloud", "Nvidia"]);
});

test("REPRODUCIBILITY: provider order is sent as an array too", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl, { provider: { order: ["A", "B"] } }), "P");
  assert.deepEqual(body.provider.order, ["A", "B"]);
});

test("REPRODUCIBILITY: allowFallbacks false is sent as allow_fallbacks", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl, { provider: { only: "AtlasCloud", allowFallbacks: false } }), "P");
  assert.equal(body.provider.allow_fallbacks, false);
});

test("REPRODUCIBILITY: provider order is sent when configured", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl, { provider: { order: ["A", "B"] } }), "P");
  assert.deepEqual(body.provider.order, ["A", "B"]);
});

test("no provider object is sent when unpinned", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(okBody("x"));
  };
  await complete(config(fetchImpl), "P");
  assert.equal(body.provider, undefined);
});

test("resolveModel passes seed and provider through to the config", () => {
  const c = resolveModel("openrouter/some-model", {
    seed: 7,
    provider: { only: "AtlasCloud", allowFallbacks: false },
  });
  assert.equal(c.seed, 7);
  assert.equal(c.model, "some-model");
  assert.equal(c.provider.only, "AtlasCloud");
  assert.equal(c.provider.allowFallbacks, false);
});

test("resolveModel rejects an unknown provider and a missing slash", () => {
  assert.throws(() => resolveModel("no-slash-here"), /must look like/);
  assert.throws(() => resolveModel("unknownvendor/some-model"), /Unknown provider/);
});

// --- Keyless endpoints and temperature control ------------------------------

import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete as ollamaComplete } from "../src/adapters/ollama.mjs";
import { complete as dispatch, loadRegistry, PRESETS } from "../src/adapters/registry.mjs";

test("a config declaring temperature 0 unsupported omits the parameter", async () => {
  // Reasoning endpoints reject `temperature` with HTTP 400; such a run is only
  // recorded under --i-cannot-control-temperature, and stamped.
  let body;
  const fetchImpl = async (url, init) => ((body = JSON.parse(init.body)), jsonResponse(okBody("x")));
  await complete(config(fetchImpl, { supportsTemperatureZero: false }), "P");
  assert.equal(body.temperature, undefined);
  await complete(config(fetchImpl, { supportsTemperatureZero: null }), "P");
  assert.equal(body.temperature, 0, "unknown support still requests 0");
});

test("apiKeyEnv null sends no authorization header", async () => {
  let headers;
  const fetchImpl = async (url, init) => ((headers = init.headers), jsonResponse(okBody("x")));
  await complete(config(fetchImpl, { apiKeyEnv: null }), "P");
  assert.equal(headers.authorization, undefined);
});

// --- Ollama ------------------------------------------------------------------

const ollamaConfig = (fetchImpl, extra = {}) => ({
  adapter: "ollama",
  endpoint: "http://localhost:11434/api/chat",
  model: "qwen2.5-coder:7b",
  apiKeyEnv: null,
  supportsTemperatureZero: true,
  fetchImpl,
  maxRetries: 0,
  ...extra,
});

test("Ollama: one user message, stream off, temperature and seed in options", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ model: "qwen2.5-coder:7b", message: { role: "assistant", content: "function f(n){return n}" }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 7 });
  };
  const r = await ollamaComplete(ollamaConfig(fetchImpl, { seed: 42 }), "PROMPT");
  assert.equal(r.text, "function f(n){return n}");
  assert.equal(r.finishReason, "stop");
  assert.deepEqual(r.usage, { prompt_tokens: 12, completion_tokens: 7 });
  assert.deepEqual(body.messages, [{ role: "user", content: "PROMPT" }]);
  assert.equal(body.stream, false);
  assert.deepEqual(body.options, { temperature: 0, seed: 42 });
});

test("Ollama: a missing model says how to pull it", async () => {
  const fetchImpl = async () => jsonResponse({ error: 'model "qwen2.5-coder:7b" not found, try pulling it first' }, 404);
  await assert.rejects(() => ollamaComplete(ollamaConfig(fetchImpl), "P"), /ollama pull qwen2\.5-coder:7b/);
});

test("Ollama: a server that is not running says how to start it", async () => {
  const fetchImpl = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  await assert.rejects(() => ollamaComplete(ollamaConfig(fetchImpl), "P"), /ollama serve/);
});

// --- Ollama: timeouts ---------------------------------------------------------
//
// The regression these guard: this adapter wrapped the abort as a retryable
// transport error, so a wedged server cost maxRetries+1 waits (was 3 x 300s =
// 15 minutes) where the other adapters pay exactly one. It also ignored the
// per-model timeoutMs config field entirely.

test("Ollama: a timeout is thrown once, never retried, and says its budget", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  };
  await assert.rejects(
    () => ollamaComplete(ollamaConfig(fetchImpl, { maxRetries: 2 }), "P"),
    (err) => {
      assert.equal(err.timedOut, true, "the error must say the budget ran out, not hint at it");
      assert.equal(err.retryable, false);
      assert.equal(err.timeoutMs, 420_000);
      assert.match(err.message, /timed out after 420000ms/);
      return true;
    }
  );
  assert.equal(calls, 1, "a timeout must cost exactly one attempt, not three");
});

test("Ollama: a per-model timeoutMs in config sets the budget", async () => {
  const fetchImpl = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  await assert.rejects(
    () => ollamaComplete(ollamaConfig(fetchImpl, { timeoutMs: 12345 }), "P"),
    (err) => {
      assert.equal(err.timeoutMs, 12345, "config.timeoutMs must be honoured, not ignored");
      assert.match(err.message, /12345ms/);
      return true;
    }
  );
});

test("Ollama: a connection refused is still retried, only timeouts are not", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new TypeError("fetch failed");
  };
  await assert.rejects(() => ollamaComplete(ollamaConfig(fetchImpl, { maxRetries: 1 }), "P"), /Could not reach/);
  assert.equal(calls, 2, "transport failures keep their retries; the exception is the timeout alone");
});

test("the registry dispatches to the adapter the config names", async () => {
  let url;
  const fetchImpl = async (u) => ((url = u), jsonResponse({ model: "m", message: { content: "ok" }, done: true }));
  const r = await dispatch(ollamaConfig(fetchImpl), "P");
  assert.equal(r.text, "ok");
  assert.match(url, /api\/chat/);
});

test("the registry dispatches a responses config to the responses adapter", async () => {
  let url;
  const fetchImpl = async (u) => ((url = u), jsonResponse(responsesBody("ok")));
  const r = await dispatch(responsesConfig(fetchImpl), "P");
  assert.equal(r.text, "ok");
  assert.match(url, /v1\/responses$/);
});

// --- Responses ----------------------------------------------------------------

import { complete as responsesComplete } from "../src/adapters/responses.mjs";

const responsesConfig = (fetchImpl, extra = {}) => ({
  adapter: "responses",
  endpoint: "https://example.test/v1/responses",
  model: "test/model",
  apiKeyEnv: "TEST_KEY",
  fetchImpl,
  maxRetries: 0,
  ...extra,
});

const message = (text) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const reasoning = (summary) => ({
  type: "reasoning",
  summary: summary ? [{ type: "summary_text", text: summary }] : [],
  content: [],
});

const responsesBody = (text, extra = {}) => ({
  id: "resp_123",
  object: "response",
  status: "completed",
  model: "test/model-20260101",
  output: [message(text)],
  usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 6 } },
  ...extra,
});

test("Responses: reads output_text and maps usage", async () => {
  const fetchImpl = async () => jsonResponse(responsesBody("function f(n){return n}"));
  const r = await responsesComplete(responsesConfig(fetchImpl), "PROMPT");
  assert.equal(r.text, "function f(n){return n}");
  assert.equal(r.finishReason, "completed");
  assert.equal(r.providerModel, "test/model-20260101");
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 6 });
  assert.equal(r.empty, false);
});

test("Responses: one user message, no instructions, no cap it did not choose", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(responsesBody("x"));
  };
  await responsesComplete(responsesConfig(fetchImpl), "PROMPT");
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "PROMPT" }] }]);
  assert.equal(body.instructions, undefined, "no system prompt");
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.max_output_tokens, undefined, "no self-inflicted truncation budget");
  await responsesComplete(responsesConfig(fetchImpl, { maxOutputTokens: 4096 }), "PROMPT");
  assert.equal(body.max_output_tokens, 4096);
});

test("Responses: a renamed block or item type fails loudly instead of scoring zero", async () => {
  // The dangerous kind of drift. A response shape this adapter no longer
  // recognises would otherwise extract nothing and be recorded as an empty
  // completion, which in a report is indistinguishable from a model that
  // could not answer. Failing here files the bug as an adapter bug.
  const renamedBlock = async () =>
    jsonResponse({ status: "completed", model: "m", output: [{ type: "message", content: [{ type: "text_block", text: "SOLVER" }] }] });
  const renamedItem = async () =>
    jsonResponse({ status: "completed", model: "m", output: [{ type: "text", text: "SOLVER" }] });

  for (const fetchImpl of [renamedBlock, renamedItem]) {
    await assert.rejects(
      () => responsesComplete(responsesConfig(fetchImpl), "P"),
      /does not recognise/,
      "must refuse to score a response it cannot read"
    );
  }
});

test("Responses: a renamed shape is recovered from output_text when it survives", () => {
  // Drift the top-level convenience field absorbs is drift worth tolerating:
  // the answer is unambiguous, so refusing to score it would be pedantry.
  const fetchImpl = async () =>
    jsonResponse({
      status: "completed",
      model: "m",
      output: [{ type: "message", content: [{ type: "text_block", text: "S" }] }],
      output_text: "SOLVER",
    });
  return responsesComplete(responsesConfig(fetchImpl), "P").then((r) => {
    assert.equal(r.text, "SOLVER");
    assert.equal(r.empty, false);
  });
});

test("Responses: a reasoning item is never read as the answer", async () => {
  // The trap this adapter exists to avoid: a reasoning model puts its chain of
  // thought in output[0], ahead of the message. Reading item 0 would put prose
  // in front of the code extractor and poison the reproducibility fingerprint.
  const fetchImpl = async () =>
    jsonResponse(
      responsesBody("SOLVER", {
        output: [reasoning("first I will consider the board"), message("SOLVER")],
      })
    );
  const r = await responsesComplete(responsesConfig(fetchImpl), "PROMPT");
  assert.equal(r.text, "SOLVER");
  assert.doesNotMatch(r.text, /consider the board/);
});

test("Responses: several message items are joined", async () => {
  const fetchImpl = async () =>
    jsonResponse(responsesBody("", { output: [message("part one "), reasoning("hmm"), message("part two")] }));
  const r = await responsesComplete(responsesConfig(fetchImpl), "P");
  assert.equal(r.text, "part one part two");
});

test("Responses: truncation is reported in finishReason, not raised", async () => {
  // A response that arrived is scored as it arrived, even when it is cut off.
  // Raising here would turn a model result into a harness error.
  const fetchImpl = async () =>
    jsonResponse(
      responsesBody("function solve(board, mi", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      })
    );
  const r = await responsesComplete(responsesConfig(fetchImpl), "P");
  assert.equal(r.text, "function solve(board, mi");
  assert.equal(r.finishReason, "max_output_tokens");
  assert.equal(r.empty, false, "a truncated answer is still an answer");
});

test("Responses: a refusal is an empty answer, and is not retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(
      responsesBody("", {
        output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }],
      })
    );
  };
  const r = await responsesComplete(responsesConfig(fetchImpl, { maxRetries: 2 }), "P");
  assert.equal(r.text, "", "refusal prose must not reach the code extractor");
  assert.equal(r.empty, true);
  assert.equal(calls, 1);
});

test("Responses: a gateway that flattens to output_text still works", async () => {
  const fetchImpl = async () => jsonResponse({ status: "completed", model: "m", output_text: "SOLVER" });
  const r = await responsesComplete(responsesConfig(fetchImpl), "P");
  assert.equal(r.text, "SOLVER");
});

test("Responses: an output array with no message item is an empty answer", async () => {
  // Same rule as the OpenAI adapter: a response that arrived with no text is a
  // score of zero, not a harness error. Reasoning-only output lands here too.
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(responsesBody("", { output: [reasoning("thinking")] }));
  };
  const r = await responsesComplete(responsesConfig(fetchImpl, { maxRetries: 2 }), "P");
  assert.equal(r.text, "");
  assert.equal(r.empty, true);
  assert.equal(calls, 1, "not retried");
});

test("Responses: a response with neither output nor output_text fails loudly", async () => {
  // Better to refuse to score than to score a response we could not read: with
  // no output array and no convenience field there is nothing to extract.
  const fetchImpl = async () => jsonResponse({ status: "completed", model: "m" });
  await assert.rejects(() => responsesComplete(responsesConfig(fetchImpl), "P"), /no output/);
});

test("Responses: a --seed is refused rather than silently dropped", async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(responsesBody("x")));
  await assert.rejects(() => responsesComplete(responsesConfig(fetchImpl, { seed: 42 }), "P"), /does not send a seed/);
  assert.equal(called, false);
});

test("Responses: temperature 0 omitted when the config says it is unsupported", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(responsesBody("x"));
  };
  await responsesComplete(responsesConfig(fetchImpl, { supportsTemperatureZero: false }), "P");
  assert.equal(body.temperature, undefined);
});

test("Responses: 429 retries, 400 does not, and the provider's message survives", async () => {
  let calls = 0;
  const retrying = async () => {
    calls++;
    return { ok: false, status: 429, text: async () => "slow down" };
  };
  await assert.rejects(
    () => responsesComplete(responsesConfig(retrying, { maxRetries: 2 }), "P"),
    (err) => err instanceof AdapterError && err.status === 429
  );
  assert.equal(calls, 3);

  let hard = 0;
  const rejecting = async () => {
    hard++;
    return jsonResponse({ error: { message: "Unsupported parameter: 'temperature'." } }, 400);
  };
  await assert.rejects(
    () => responsesComplete(responsesConfig(rejecting, { maxRetries: 3 }), "P"),
    /Unsupported parameter: 'temperature'/
  );
  assert.equal(hard, 1, "a 400 is the provider's answer, not a transport failure");
});

test("Responses: sends bearer auth and any configured extra headers", async () => {
  let headers;
  const fetchImpl = async (url, init) => {
    headers = init.headers;
    return jsonResponse(responsesBody("x"));
  };
  await responsesComplete(responsesConfig(fetchImpl, { headers: { "x-opencode-session": "s1" } }), "P");
  assert.equal(headers.authorization, "Bearer test-key-1234");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-opencode-session"], "s1");
});

test("Responses: a missing API key fails before any request", async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(responsesBody("x")));
  await assert.rejects(
    () => responsesComplete(responsesConfig(fetchImpl, { apiKeyEnv: "DEFINITELY_NOT_SET_12345" }), "P"),
    /Missing API key/
  );
  assert.equal(called, false);
});

// --- Messages (Anthropic) -----------------------------------------------------

import { complete as anthropicComplete } from "../src/adapters/anthropic.mjs";

const messagesConfig = (fetchImpl, extra = {}) => ({
  adapter: "anthropic",
  endpoint: "https://example.test/v1/messages",
  model: "test/model",
  apiKeyEnv: "TEST_KEY",
  anthropicVersion: "2023-06-01",
  fetchImpl,
  maxRetries: 0,
  ...extra,
});

const textBlock = (text) => ({ type: "text", text });
const messagesBody = (text, extra = {}) => ({
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "test/model-20260101",
  stop_reason: "end_turn",
  content: [textBlock(text)],
  usage: { input_tokens: 12, output_tokens: 8 },
  ...extra,
});

test("Messages: reads text blocks and maps usage", async () => {
  const fetchImpl = async () => jsonResponse(messagesBody("function solve(b,m){return null}"));
  const r = await anthropicComplete(messagesConfig(fetchImpl), "PROMPT");
  assert.equal(r.text, "function solve(b,m){return null}");
  assert.equal(r.finishReason, "end_turn");
  assert.equal(r.providerModel, "test/model-20260101");
  assert.deepEqual(r.usage, { prompt_tokens: 12, completion_tokens: 8 });
  assert.equal(r.empty, false);
});

test("Messages: one user message, a required max_tokens, and no system prompt", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(messagesBody("x"));
  };
  await anthropicComplete(messagesConfig(fetchImpl), "PROMPT");
  assert.deepEqual(body.messages, [{ role: "user", content: "PROMPT" }]);
  assert.equal(body.system, undefined, "no system prompt");
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0);
  // max_tokens is mandatory on this dialect, and defaults high on purpose: too
  // low truncates a solver the model had room to finish, which then scores as
  // a weak model rather than as a harness bug.
  assert.equal(body.max_tokens, 32000);
  await anthropicComplete(messagesConfig(fetchImpl, { maxTokens: 4096 }), "PROMPT");
  assert.equal(body.max_tokens, 4096);
});

test("Messages: sends x-api-key and anthropic-version, never Bearer", async () => {
  let headers;
  const fetchImpl = async (url, init) => {
    headers = init.headers;
    return jsonResponse(messagesBody("function solve(b,m){return null}"));
  };
  await anthropicComplete(messagesConfig(fetchImpl), "PROMPT");
  assert.equal(headers["x-api-key"], "test-key-1234");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers.authorization, undefined, "this dialect does not use Bearer");
  assert.equal(headers["content-type"], "application/json");
});

test("Messages: a hand-written entry with no version configured defaults instead of a 400", async () => {
  // The header is required by the dialect, but only the presets set it — a
  // bare api.anthropic.com entry used to fail with an opaque HTTP 400.
  let headers;
  const fetchImpl = async (url, init) => {
    headers = init.headers;
    return jsonResponse(messagesBody("function solve(b,m){return null}"));
  };
  await anthropicComplete(messagesConfig(fetchImpl, { anthropicVersion: undefined }), "PROMPT");
  assert.equal(headers["anthropic-version"], "2023-06-01", "the default fills the gap");
  await anthropicComplete(messagesConfig(fetchImpl, { anthropicVersion: "2025-09-01" }), "PROMPT");
  assert.equal(headers["anthropic-version"], "2025-09-01", "an explicit value still wins");
});

test("Messages: a thinking block is never read as the answer", async () => {
  // Same trap as the Responses reasoning item: read the wrong block and chain
  // of thought reaches the code extractor and poisons the fingerprint.
  const fetchImpl = async () =>
    jsonResponse(
      messagesBody("SOLVER", {
        content: [
          { type: "thinking", thinking: "first I will consider the board" },
          { type: "redacted_thinking", data: "..." },
          textBlock("SOLVER"),
        ],
      })
    );
  const r = await anthropicComplete(messagesConfig(fetchImpl), "PROMPT");
  assert.equal(r.text, "SOLVER");
  assert.doesNotMatch(r.text, /consider the board/);
});

test("Messages: truncation is reported in finishReason, not raised", async () => {
  const fetchImpl = async () =>
    jsonResponse(messagesBody("function solve(board, mi", { stop_reason: "max_tokens" }));
  const r = await anthropicComplete(messagesConfig(fetchImpl), "P");
  assert.equal(r.finishReason, "max_tokens", "a cut-off solver is not a solved task");
  assert.equal(r.empty, false);
});

test("Messages: a renamed block type fails loudly instead of scoring zero", async () => {
  const drifted = async () =>
    jsonResponse({ model: "m", stop_reason: "end_turn", content: [{ type: "output_text", text: "SOLVER" }] });
  await assert.rejects(
    () => anthropicComplete(messagesConfig(drifted), "P"),
    /does not recognise/,
    "must refuse to score a response it cannot read"
  );
});

test("Messages: content with no text block is an empty answer, not an error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(messagesBody("", { content: [{ type: "thinking", thinking: "hmm" }] }));
  };
  const r = await anthropicComplete(messagesConfig(fetchImpl, { maxRetries: 2 }), "P");
  assert.equal(r.text, "");
  assert.equal(r.empty, true);
  assert.equal(calls, 1);
});

test("Messages: a response with no content fails loudly", async () => {
  const fetchImpl = async () => jsonResponse({ model: "m", stop_reason: "end_turn" });
  await assert.rejects(() => anthropicComplete(messagesConfig(fetchImpl), "P"), /no content/);
});

test("Messages: a --seed is refused rather than silently dropped", async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(messagesBody("x")));
  await assert.rejects(() => anthropicComplete(messagesConfig(fetchImpl, { seed: 42 }), "P"), /does not send a seed/);
  assert.equal(called, false);
});

test("Messages: temperature 0 omitted when the config says it is unsupported", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(messagesBody("x"));
  };
  await anthropicComplete(messagesConfig(fetchImpl, { supportsTemperatureZero: false }), "P");
  assert.equal(body.temperature, undefined);
});

test("Messages: 429 retries and 400 does not", async () => {
  let calls = 0;
  const retrying = async () => {
    calls++;
    return { ok: false, status: 429, text: async () => "slow down" };
  };
  await assert.rejects(() => anthropicComplete(messagesConfig(retrying, { maxRetries: 2 }), "P"), /HTTP 429/);
  assert.equal(calls, 3);

  let hard = 0;
  const rejecting = async () => {
    hard++;
    return jsonResponse({ type: "error", error: { message: "max_tokens: must be > 0" } }, 400);
  };
  await assert.rejects(
    () => anthropicComplete(messagesConfig(rejecting, { maxRetries: 3 }), "P"),
    /max_tokens: must be > 0/
  );
  assert.equal(hard, 1);
});

test("Messages: a missing API key fails before any request", async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), jsonResponse(messagesBody("x")));
  await assert.rejects(
    () => anthropicComplete(messagesConfig(fetchImpl, { apiKeyEnv: "DEFINITELY_NOT_SET_12345" }), "P"),
    /Missing API key/
  );
  assert.equal(called, false);
});

test("the registry dispatches a messages config to the anthropic adapter", async () => {
  let url;
  const fetchImpl = async (u) => ((url = u), jsonResponse(messagesBody("ok")));
  const r = await dispatch(messagesConfig(fetchImpl), "P");
  assert.equal(r.text, "ok");
  assert.match(url, /v1\/messages$/);
});

// --- OpenCode Go and Zen presets ----------------------------------------------

test("every gateway preset pins one dialect and one endpoint", () => {
  // The prefix decides the dialect, so a wrong prefix is a 404 rather than a
  // misrouted request that silently scores something else.
  const cases = [
    ["gogo/glm-5.3", "openai", "https://opencode.ai/zen/go/v1/chat/completions"],
    ["gogo-responses/grok-4.7", "responses", "https://opencode.ai/zen/go/v1/responses"],
    ["gogo-messages/minimax-m3", "anthropic", "https://opencode.ai/zen/go/v1/messages"],
    ["zen/glm-5.3", "openai", "https://opencode.ai/zen/v1/chat/completions"],
    ["zen-responses/gpt-6-astra", "responses", "https://opencode.ai/zen/v1/responses"],
    ["zen-messages/claude-fable-5.1", "anthropic", "https://opencode.ai/zen/v1/messages"],
  ];
  for (const [spec, adapter, endpoint] of cases) {
    const c = resolveModel(spec);
    assert.equal(c.adapter, adapter, `${spec} adapter`);
    assert.equal(c.endpoint, endpoint, `${spec} endpoint`);
    assert.equal(c.apiKeyEnv, "OPENCODE_API_KEY", `${spec} key`);
    assert.equal(c.supportsTemperatureZero, null, `${spec}: unmeasured is unknown, not assumed`);
    assert.ok(c.headers["user-agent"].startsWith("monkey-see-monkey-do/"), `${spec} identifies the client`);
    assert.ok(c.headers["x-opencode-session"], `${spec} sends a session id`);
  }

  // Only the Messages dialect needs a version header, and only because that
  // API requires one. Sending it to the others is meaningless at best.
  assert.equal(resolveModel("gogo-messages/minimax-m3").anthropicVersion, "2023-06-01");
  assert.equal(resolveModel("gogo-responses/grok-4.7").anthropicVersion, undefined);

  // The reported version is read from package.json, so it cannot drift away
  // from the version this suite ships as.
  assert.equal(
    resolveModel("gogo/glm-5.3").headers["user-agent"],
    `monkey-see-monkey-do/${createRequire(import.meta.url)("../package.json").version}`
  );
  // One session id per process, so the calls of a run share it and the gateway's
  // prompt caching still applies. A fresh id per request would defeat it.
  const ids = cases.map(([s]) => resolveModel(s).headers["x-opencode-session"]);
  assert.equal(new Set(ids).size, 1, "every preset shares one session id per process");
});

// --- The registry file ---------------------------------------------------------

const registryFile = (json) => {
  const dir = mkdtempSync(join(tmpdir(), "md-registry-"));
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
};

test("resolution order: exact model, then provider prefix, then built-in preset", () => {
  const path = registryFile({
    providers: {
      groq: { adapter: "openai", endpoint: "https://api.groq.com/openai/v1/chat/completions", apiKeyEnv: "GROQ_API_KEY", supportsTemperatureZero: true },
    },
    models: {
      "openai/gpt-4o": { adapter: "openai", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-2024-08-06", apiKeyEnv: "OPENAI_API_KEY", supportsTemperatureZero: true },
    },
  });
  const exact = resolveModel("openai/gpt-4o", { configPath: path });
  assert.equal(exact.model, "gpt-4o-2024-08-06", "an exact entry can pin a dated snapshot");
  assert.equal(exact.supportsTemperatureZero, true);
  const prefix = resolveModel("groq/llama-3.1-8b-instant", { configPath: path });
  assert.equal(prefix.model, "llama-3.1-8b-instant");
  assert.equal(prefix.apiKeyEnv, "GROQ_API_KEY");
  const preset = resolveModel("openai/gpt-4.1", { configPath: path });
  assert.equal(preset.supportsTemperatureZero, null, "an unmeasured preset is unknown, not assumed");
  const local = resolveModel("ollama/qwen2.5-coder:7b", { configPath: path });
  assert.equal(local.adapter, "ollama");
  assert.equal(local.apiKeyEnv, null);
});

test("a malformed registry entry names the file, the entry and the field", () => {
  const path = registryFile({ models: { "x/y": { adapter: "carrier-pigeon", endpoint: "ftp://nope", model: "y" } } });
  assert.throws(() => loadRegistry(path, { required: true }), (err) => {
    assert.match(err.message, /models\["x\/y"\]/);
    assert.match(err.message, /"adapter" must be one of/);
    assert.match(err.message, /"endpoint" must be an http/);
    assert.match(err.message, /missing "apiKeyEnv"/);
    return true;
  });
});

test("an explicit --config that does not exist is an error, not an empty registry", () => {
  assert.throws(() => resolveModel("openrouter/x", { configPath: "/definitely/not/here/models.json" }), /not found/);
});

test("provider pinning is refused for a non-OpenRouter endpoint", () => {
  assert.throws(() => resolveModel("ollama/x", { provider: { only: "A" } }), /OpenRouter feature/);
});

test("the example registry is valid and every entry resolves", () => {
  const path = new URL("../config/models.example.json", import.meta.url).pathname;
  const reg = loadRegistry(path, { required: true });
  for (const id of Object.keys(reg.models)) resolveModel(id, { configPath: path });
  for (const name of Object.keys(reg.providers)) resolveModel(`${name}/some-model`, { configPath: path });
  assert.ok(Object.keys(PRESETS).includes("ollama"));
});

// --- Listing OpenRouter providers (the pinning prerequisite) ----------------

test("listProviders keeps the slash in a vendor/model id", async () => {
  // OpenRouter 404s on an encoded slash: the raw path
  //   /api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
  // returns the endpoint list, while
  //   /api/v1/models/deepseek%2Fdeepseek-v4.1-flash/endpoints
  // returns 404. Verified against the live API. Encoding the whole id, as this
  // did originally, broke pinning for every model with a slash in it.
  const { listProviders } = await import("../src/adapters/openai.mjs");
  let seen;
  const fetchImpl = async (url) => {
    seen = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          endpoints: [
            { provider_name: "DeepSeek", context_length: 393216, max_completion_tokens: 393216, quantization: "unknown" },
            { provider_name: "Fireworks", context_length: 943718, max_completion_tokens: 943718, quantization: "fp8" },
          ],
        },
      }),
    };
  };
  const providers = await listProviders("deepseek/deepseek-v4.1-flash", { fetchImpl, apiKeyEnv: "TEST_KEY" });
  assert.equal(seen, "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints");
  assert.doesNotMatch(seen, /%2F/i, "an encoded slash is a 404 on the live API");
  assert.equal(providers.length, 2);
  assert.equal(providers[0].provider, "DeepSeek");
  assert.equal(providers[1].quantization, "fp8");
});

test("listProviders escapes a segment that needs it, without touching the slash", async () => {
  const { listProviders } = await import("../src/adapters/openai.mjs");
  let seen;
  const fetchImpl = async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => ({ data: { endpoints: [] } }) };
  };
  await listProviders("vendor/model:free", { fetchImpl, apiKeyEnv: "TEST_KEY" });
  assert.equal(seen, "https://openrouter.ai/api/v1/models/vendor/model%3Afree/endpoints");
});

// --- Timeouts: per-model budget, and never retried ---------------------------

const hangingFetch = (counter) => async (url, init) => {
  if (counter) counter.n++;
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
    );
  });
};

test("a timeout is not retried", async () => {
  // Measured: three attempts at a 120s ceiling meant 361s per stalled model,
  // and an -r 3 run cost 18 minutes to learn the same thing three times. One
  // wait is the cost of finding out; a longer per-model budget is the lever.
  const counter = { n: 0 };
  await assert.rejects(
    () => complete(config(hangingFetch(counter), { timeoutMs: 40 }), "P"),
    /timed out/
  );
  assert.equal(counter.n, 1, "a timeout has already spent the whole budget");
});

test("a timeout is marked, so a report can tell it from a refusal", async () => {
  await assert.rejects(
    () => complete(config(hangingFetch(), { timeoutMs: 40 }), "P"),
    (err) => {
      assert.equal(err.timedOut, true);
      assert.equal(err.retryable, false, "a timeout must not invite a retry");
      assert.equal(err.timeoutMs, 40, "and must say what budget it had");
      return true;
    }
  );
});

test("a config timeoutMs overrides the adapter default", async () => {
  // A slow reasoning model and a fast small one should not share a ceiling.
  const err = await complete(config(hangingFetch(), { timeoutMs: 25 }), "P").catch((e) => e);
  assert.equal(err.timeoutMs, 25);
});

test("the default budget is generous enough for a reasoning model", async () => {
  // DeepSeek V4.1 Flash returned a full solver in 203s on one provider. A
  // ceiling below that fails models that can answer.
  const { DEFAULT_TIMEOUT_MS } = await import("../src/adapters/openai.mjs");
  assert.ok(DEFAULT_TIMEOUT_MS >= 300_000, `default was ${DEFAULT_TIMEOUT_MS}ms`);
});

test("a non-timeout transport failure is still retried", async () => {
  // Only the timeout changed. A connection refused costs milliseconds, so
  // retrying it is cheap and correct.
  let calls = 0;
  await assert.rejects(
    () =>
      complete(
        config(() => {
          calls++;
          throw new TypeError("fetch failed");
        }, { maxRetries: 2 }),
        "P"
      ),
    /fetch failed/
  );
  assert.equal(calls, 3, "initial attempt plus two retries");
});

test("every adapter honours a configured timeoutMs", async () => {
  // One budget field, three dialects. If an adapter ignored it, a slow model
  // would silently keep the default and the field would be a lie.
  for (const [name, fn, extra] of [
    ["openai", complete, {}],
    ["responses", responsesComplete, {}],
    ["anthropic", anthropicComplete, { anthropicVersion: "2023-06-01" }],
  ]) {
    const err = await fn(config(hangingFetch(), { timeoutMs: 25, ...extra }), "P").catch((e) => e);
    assert.equal(err.timedOut, true, `${name} must mark a timeout`);
    assert.equal(err.timeoutMs, 25, `${name} must honour the configured budget`);
  }
});

// -------------------------------------------------------------
// Phase 8 runner-bug fix tripwires (commit fixing the
// --i-cannot-control-temperature override).
//
// Pre-fix: the responses / chat-completions adapters always sent
// body.temperature = 0 unless supportsTemperatureZero === false. The
// CLI's --i-cannot-control-temperature flag was honored at the
// pre-flight refusal but never reached the body-builder, so a model
// that rejected temperature=0 (e.g. gpt-6-luna on /v1/responses)
// returned HTTP 400 even when the user had explicitly opted in.
//
// Post-fix: the body omits the temperature field entirely when the
// override is set. NEVER substituted with a non-zero value — a
// model sampled above 0 is a different experiment.
//
// One pin per dialect. The fetchImpl captures the request body so
// the assertion runs on the JSON the runner actually emitted.
// -------------------------------------------------------------

// captureBody helper is defined below the import block; kept local to the
// tripwire section to avoid colliding with the broader test file's helpers.

test("responses adapter omits temperature when --i-cannot-control-temperature is set", async () => {
  const { fetchImpl, getBody } = captureBody();
  const cfg = {
    adapter: "responses",
    endpoint: "https://example.test/v1/responses",
    model: "test/model",
    apiKeyEnv: "TEST_KEY",
    fetchImpl,
    maxRetries: 0,
    temperatureOverride: true,
  };
  await responsesComplete(cfg, "PROMPT");
  const body = getBody();
  assert.equal("temperature" in body, false, "body must not carry a temperature field under the override — got: " + JSON.stringify(body));
});

test("responses adapter sends temperature: 0 when override is NOT set", async () => {
  const { fetchImpl, getBody } = captureBody();
  const cfg = {
    adapter: "responses",
    endpoint: "https://example.test/v1/responses",
    model: "test/model",
    apiKeyEnv: "TEST_KEY",
    fetchImpl,
    maxRetries: 0,
  };
  await responsesComplete(cfg, "PROMPT");
  const body = getBody();
  assert.equal(body.temperature, 0, "body must carry temperature: 0 by default");
});

test("chat-completions adapter omits temperature when override is set", async () => {
  const { fetchImpl, getBody } = captureBody(openaiBody());
  const cfg = {
    endpoint: "https://example.test/v1/chat/completions",
    model: "test/model",
    apiKeyEnv: "TEST_KEY",
    fetchImpl,
    maxRetries: 0,
    temperatureOverride: true,
  };
  await openaiComplete(cfg, "PROMPT");
  const body = getBody();
  assert.equal("temperature" in body, false, "body must not carry a temperature field under the override");
});

import { complete as openaiComplete } from "../src/adapters/openai.mjs";

// (existing top-of-file import of `complete` from "../src/adapters/openai.mjs"
// at line 6 remains — it serves the existing tests; this new alias is a
// readability aid for the tripwire block below.)

// Per-dialect mock body. Anthropic expects { type: "message", content:
// [{type: "text", ...}] }; the Responses dialect expects the Responses
// shape; OpenAI chat-completions expects { choices: [...] }.
// captureBody takes a body that matches the dialect under test.
const anthropicBody = () => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test/model",
  content: [{ type: "text", text: "OK" }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const openaiBody = () => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  model: "test/model",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
const captureBody = (responseBody = null) => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = JSON.parse(init.body);
    return jsonResponse(responseBody ?? {
      id: "resp_test", object: "response", status: "completed", model: "test/model",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  return { fetchImpl, getBody: () => captured };
};

test("anthropic adapter omits temperature when override is set", async () => {
  const { fetchImpl, getBody } = captureBody(anthropicBody());
  const cfg = {
    endpoint: "https://example.test/v1/messages",
    model: "test/model",
    apiKeyEnv: "TEST_KEY",
    fetchImpl,
    maxRetries: 0,
    temperatureOverride: true,
    anthropicVersion: "2023-06-01",
  };
  await anthropicComplete(cfg, "PROMPT");
  const body = getBody();
  assert.equal("temperature" in body, false, "body must not carry a temperature field under the override");
});
