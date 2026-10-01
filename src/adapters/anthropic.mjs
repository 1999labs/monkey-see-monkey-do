// Adapter for any Anthropic Messages endpoint (/v1/messages).
//
// Same contract as the other two adapters: one user message, temperature 0
// where it is accepted, no system prompt, and a retry only on a TRANSPORT
// failure, never on an answer that actually arrived.
//
// The wire format differs from OpenAI's in four ways that matter here:
//
//   1. Auth is `x-api-key`, not `Authorization: Bearer`, and an
//      `anthropic-version` header is required. An API key resolved from the
//      same environment variable as every other adapter therefore lands in a
//      different header here.
//   2. `max_tokens` is REQUIRED. It is also the one truncation risk in this
//      adapter: too low and the solver is cut off mid-body, which scores as a
//      weak model rather than as a harness bug. So it defaults high, and
//      `stop_reason: "max_tokens"` is reported rather than raised.
//   3. Text lives in content[] as `text` blocks. A `thinking` or
//      `redacted_thinking` block is chain of thought and must never be read as
//      the answer: it would reach the code extractor and poison the
//      reproducibility fingerprint.
//   4. There is no finish_reason; `stop_reason` is end_turn / max_tokens /
//      stop_sequence / tool_use / pause_turn.
//
// As on the Responses adapter, text found in a shape this file does not
// recognise is reported rather than skipped, so a changed response format
// fails loudly instead of scoring zero.

import { setTimeout as delay } from "node:timers/promises";

import { AdapterError } from "./openai.mjs";

// Matches the OpenAI adapter: reasoning models here may need minutes, and
// three attempts at a short ceiling cost an 18-minute wait.
const DEFAULT_TIMEOUT_MS = 420_000;

// Anthropic rejects a request with no max_tokens, so there is no "unset means
// provider default" option here. This is high enough for a solver on any
// model in the catalogue, and deliberately NOT a tight cap: see note 2 above.
const DEFAULT_MAX_TOKENS = 32_000;

/**
 * The answer, and only the answer, out of a Messages response.
 *
 * `missed` names shapes that carried text we did not take, which is how a
 * changed response format becomes a loud failure rather than a silent zero.
 */
const extractAnswer = (content) => {
  if (!Array.isArray(content)) return null;
  let text = "";
  const missed = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
      continue;
    }
    // Chain of thought: excluded on purpose, not "missed" by accident.
    if (block?.type === "thinking" || block?.type === "redacted_thinking") continue;
    if (typeof block?.text === "string" && block.text) missed.push(`block:${block.type ?? "untyped"}`);
  }
  return { text, missed };
};

export const complete = async (config, promptText, { timeoutMs } = {}) => {
  const { endpoint, model, headers = {}, fetchImpl = fetch, maxRetries = 2 } = config;
  const budget = config.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const apiKeyEnv = config.apiKeyEnv;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (apiKeyEnv && !apiKey) {
    throw new AdapterError(
      `Missing API key. Set ${apiKeyEnv} before scoring a model.`,
      { retryable: false }
    );
  }

  if (config.seed !== undefined) {
    throw new AdapterError(
      "This adapter does not send a seed. It is not part of the Messages request, " +
        "and dropping it silently would claim a reproducibility guarantee the run cannot " +
        "support. Drop --seed, or point the model at an adapter that sends one.",
      { retryable: false }
    );
  }

  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  const body = {
    model,
    // `system` is deliberately never set: this suite sends one user message and
    // nothing else, so the request carries no instructions of our own.
    messages: [{ role: "user", content: promptText }],
    max_tokens: maxTokens,
    stream: false,
  };
  // Several models on this dialect reject a temperature parameter outright.
  if (config.supportsTemperatureZero !== false) body.temperature = 0;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await delay(500 * attempt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...headers,
          ...(config.anthropicVersion ? { "anthropic-version": config.anthropicVersion } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        let detail = text.slice(0, 500);
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error?.message) detail = parsed.error.message;
        } catch {
          /* not JSON, keep the raw text */
        }
        lastError = new AdapterError(`HTTP ${res.status}: ${detail}`, {
          status: res.status,
          retryable,
          body: text.slice(0, 500),
        });
        if (retryable) continue;
        throw lastError;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdapterError("Endpoint returned non-JSON", { status: res.status, body: text.slice(0, 500) });
      }

      const found = extractAnswer(json.content);

      // A gateway may answer with a single flattened string instead of blocks.
      if ((found === null || found.text === "") && typeof json.completion === "string") {
        return {
          text: json.completion,
          finishReason: json.stop_reason ?? null,
          providerModel: json.model ?? model,
          usage: usageFrom(json),
          empty: json.completion.length === 0,
        };
      }

      if (found === null) {
        throw new AdapterError("Response contained no content", { status: res.status, body: text.slice(0, 500) });
      }

      if (found.text === "" && found.missed.length > 0) {
        // Text we did not recognise, and no answer we did. Scoring this as an
        // empty completion would file an adapter bug as a model failure, which
        // are indistinguishable in a report.
        throw new AdapterError(
          `Could not extract the answer: found text in response block shape(s) this ` +
            `adapter does not recognise (${[...new Set(found.missed)].join(", ")}), and no ` +
            `text block. The provider's response format has probably changed.`,
          { status: res.status, body: text.slice(0, 500) }
        );
      }

      return {
        text: found.text,
        // max_tokens here means a truncated answer, not a solved task.
        finishReason: json.stop_reason ?? null,
        providerModel: json.model ?? model,
        usage: usageFrom(json),
        empty: found.text.length === 0,
      };
    } catch (err) {
      if (err instanceof AdapterError && !err.retryable) throw err;

      // A timeout is NOT retried: it already consumed the whole budget, and
      // three of them cost an 18-minute wait for one stalled model. The right
      // lever is a larger per-model timeoutMs, not more identical attempts.
      if (err?.name === "AbortError" || /abort|timeout/i.test(String(err?.message ?? ""))) {
        throw new AdapterError(`Request timed out after ${budget}ms: ${err?.message ?? err}`, {
          retryable: false,
          timedOut: true,
          timeoutMs: budget,
        });
      }

      lastError = err instanceof AdapterError ? err : new AdapterError(String(err?.message ?? err), { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new AdapterError("Request failed", { retryable: true });
};

const usageFrom = (json) => {
  if (!json?.usage) return null;
  return {
    prompt_tokens: json.usage.input_tokens ?? null,
    completion_tokens: json.usage.output_tokens ?? null,
  };
};