// Adapter for a local Ollama server (http://localhost:11434/api/chat).
//
// Local models are the most reproducible thing this suite can score: no
// provider routing, no batching with strangers, and a seed that is honoured.
// That is why guide.md names Ollama alongside the OpenAI wire format.
//
// Same contract as the OpenAI adapter: one user message, temperature 0, no
// system prompt, and a retry only on a TRANSPORT failure — never on an answer
// that actually arrived.

import { setTimeout as delay } from "node:timers/promises";

import { AdapterError } from "./openai.mjs";

// Local generation on a laptop CPU can be slow; five minutes per call is
// generous without letting a wedged server hang the run forever.
const DEFAULT_TIMEOUT_MS = 300_000;

export const complete = async (config, promptText, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const { endpoint, model, headers = {}, fetchImpl = fetch, maxRetries = 2 } = config;

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
    const timer = setTimeout(() => ac.abort(), timeoutMs);
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
