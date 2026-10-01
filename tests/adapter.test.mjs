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

test("the registry dispatches to the adapter the config names", async () => {
  let url;
  const fetchImpl = async (u) => ((url = u), jsonResponse({ model: "m", message: { content: "ok" }, done: true }));
  const r = await dispatch(ollamaConfig(fetchImpl), "P");
  assert.equal(r.text, "ok");
  assert.match(url, /api\/chat/);
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
