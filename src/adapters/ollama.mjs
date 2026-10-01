// Adapter for a local Ollama server (http://localhost:11434/api/chat).
//
// Local models are the most reproducible thing this suite can score: no
// provider routing, no batching with strangers, and a seed that is honoured.
// That is why Ollama is supported alongside the OpenAI wire format.
//
// Same contract as the OpenAI adapter: one user message, temperature 0, no
// system prompt, and a retry only on a TRANSPORT failure — never on an answer
// that actually arrived.

import { setTimeout as delay } from "node:timers/promises";

import { AdapterError } from "./openai.mjs";

// Local generation on a laptop CPU can be slow; the suite-wide 420s ceiling
// applies here too, for the same reason it does on the hosted adapters: a
// reasoning model that emits only reasoning tokens needs minutes, and a
// shorter ceiling failed models that could answer. Override it per model in
// config/models.json with timeoutMs, which this adapter honours.
const DEFAULT_TIMEOUT_MS = 420_000;

export const complete = async (config, promptText, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const { endpoint, model, headers = {}, fetchImpl = fetch, maxRetries = 2 } = config;
  // A per-model timeoutMs in config/models.json overrides the default, exactly
  // as in the OpenAI-dialect adapters. The registry validates the field for
  // every adapter, so honouring it here is not optional: the report records it
  // as the budget that was in force, which must be the budget that was.
  const budget = config.timeoutMs ?? timeoutMs;

  const options = {};
  // Omitted, not sent as 0, when the config says it cannot be honoured: the
  // run is then stamped as uncontrolled rather than pretending otherwise.
  if (config.supportsTemperatureZero !== false) options.temperature = 0;
  if (config.seed !== undefined) options.seed = config.seed;

  const body = {
    model,
    messages: [{ role: "user", content: promptText }],
    stream: false,
    options,
  };

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await delay(500 * attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    try {
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (err) {
        // OUR timer fired. A timeout is NOT retried: it already consumed the
        // whole budget, and re-running it turns a wedged local server into a
        // 21-minute stall (3 attempts x 420s). The same rule as openai.mjs;
        // this adapter was the one place it was missing.
        if (err?.name === "AbortError" || err?.code === "ABORT_ERR" || /abort|timeout/i.test(String(err?.message ?? ""))) {
          throw new AdapterError(`Request timed out after ${budget}ms: ${err?.message ?? err}`, {
            retryable: false,
            timedOut: true,
            timeoutMs: budget,
          });
        }
        // Connection refused is the common case: the server is not running.
        lastError = new AdapterError(
          `Could not reach Ollama at ${endpoint} (${err?.cause?.code ?? err?.message ?? err}). ` +
            `Is it running? Start it with:  ollama serve`,
          { retryable: true }
        );
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 500);
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error) detail = parsed.error;
        } catch {
          /* not JSON */
        }
        if (res.status === 404) {
          throw new AdapterError(`HTTP 404: ${detail}. Pull the model first:  ollama pull ${model}`, {
            status: 404,
            body: text.slice(0, 500),
          });
        }
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new AdapterError(`HTTP ${res.status}: ${detail}`, { status: res.status, retryable, body: text.slice(0, 500) });
        if (retryable) continue;
        throw lastError;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdapterError("Ollama returned non-JSON", { status: res.status, body: text.slice(0, 500) });
      }
      const content = json?.message?.content;
      if (typeof content !== "string") {
        throw new AdapterError("Ollama response contained no message", { status: res.status, body: text.slice(0, 500) });
      }
      return {
        text: content,
        finishReason: json.done_reason ?? null,
        providerModel: json.model ?? model,
        usage:
          json.prompt_eval_count != null || json.eval_count != null
            ? { prompt_tokens: json.prompt_eval_count ?? null, completion_tokens: json.eval_count ?? null }
            : null,
        empty: content.length === 0,
      };
    } catch (err) {
      if (err instanceof AdapterError && !err.retryable) throw err;
      lastError = err instanceof AdapterError ? err : new AdapterError(String(err?.message ?? err), { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new AdapterError("Request failed", { retryable: true });
};
