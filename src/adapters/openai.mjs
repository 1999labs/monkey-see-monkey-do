// Adapter for any OpenAI-compatible /v1/chat/completions endpoint.
//
// One adapter covers OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio and
// most hosted inference providers, because they all speak the same wire
// format. That is the whole reason this project has no runtime dependencies.
//
// Zero system prompt, temperature 0, one call per task. The only retry is on a
// TRANSPORT failure (no response, 5xx, rate limit) — never on a response we
// actually received. Re-rolling a completed generation would destroy the
// reproducibility guarantee the eval depends on, so a successful response is
// scored exactly as it arrived, even if it is wrong.

import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 120_000;

export class AdapterError extends Error {
  constructor(message, { status, retryable = false, body } = {}) {
    super(message);
    this.name = "AdapterError";
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/**
 * One completion. Returns the raw assistant text plus the metadata needed for
 * the report (finish_reason, usage, and the provider's own model id — which
 * may differ from the id we asked for).
 */
export const complete = async (config, promptText, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const { endpoint, model, apiKeyEnv, headers = {}, fetchImpl = fetch, maxRetries = 2 } = config;
  // apiKeyEnv null means a server that needs no key (LM Studio, a local vLLM).
  // A NAMED variable that is unset is still an error, raised before any request.
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (apiKeyEnv && !apiKey) {
    throw new AdapterError(
      `Missing API key. Set ${apiKeyEnv} before scoring a model.`,
      { retryable: false }
    );
  }

  const body = {
    model,
    messages: [{ role: "user", content: promptText }],
  };
  // Omitted, not sent, when the config declares temperature 0 unsupported:
  // several reasoning endpoints reject the parameter with HTTP 400. Such a run
  // can only be recorded under --i-cannot-control-temperature, and is stamped.
  if (config.supportsTemperatureZero !== false) body.temperature = 0;

  // Reproducibility controls. Both are opt-in via config so the same adapter
  // serves every provider.
  //
  // `seed` asks the provider to start its random number generator from a fixed
  // point. It reduces randomness but does NOT guarantee determinism: batching
  // on the provider's side can still perturb the result. Treat it as a helpful
  // extra, never as proof.
  if (config.seed !== undefined) body.seed = config.seed;

  // `provider` pins the request to specific providers and, critically, can
  // disable fallback. Without this, OpenRouter load-balances across whatever
  // is available, so two runs may land on different hardware entirely.
  //
  // NOTE: `only` and `order` are ARRAYS. Sending a bare string returns
  // HTTP 400 "expected array, received string" — verified against the live API.
  if (config.provider) {
    const toArray = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);
    const only = toArray(config.provider.only);
    const order = toArray(config.provider.order);
    body.provider = {
      ...(order ? { order } : {}),
      ...(only ? { only } : {}),
      // allow_fallbacks: false means "fail loudly rather than silently switch
      // providers". A switched provider is a different machine, and therefore
      // a different answer, which would corrupt the comparison.
      ...(config.provider.allowFallbacks !== undefined
        ? { allow_fallbacks: config.provider.allowFallbacks }
        : {}),
    };
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await delay(500 * attempt); // brief, linear backoff
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        // 429 and 5xx are worth another go; 400/401/403/404 are not.
        const retryable = res.status === 429 || res.status >= 500;
        // Surface the provider's own explanation. A bare "HTTP 400" tells the
        // user nothing; the body is usually a specific, actionable sentence.
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

      const choice = json.choices?.[0];
      if (!choice) {
        throw new AdapterError("Response contained no choices", { status: res.status, body: text.slice(0, 500) });
      }
      const content = choice.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        // An empty completion is a real (bad) answer, not a transport error.
        // Record it as such rather than silently retrying.
        return {
          text: typeof content === "string" ? content : "",
          finishReason: choice.finish_reason ?? null,
          providerModel: json.model ?? model,
          usage: json.usage ?? null,
          empty: true,
        };
      }

      return {
        text: content,
        finishReason: choice.finish_reason ?? null,
        providerModel: json.model ?? model,
        usage: json.usage ?? null,
        empty: false,
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

/**
 * OpenRouter preset. Free-tier models are rate limited, so allow retries.
 *
 * Reproducibility options (all optional):
 *   seed                   a fixed RNG seed, sent as `seed`
 *   provider.order         provider slugs to try, in order
 *   provider.only          the single provider to use
 *   provider.allowFallbacks  false means "fail rather than silently switch"
 */
export const openRouterConfig = (model, { maxRetries = 2, seed, provider } = {}) => ({
  adapter: "openai",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model,
  apiKeyEnv: "OPENROUTER_API_KEY",
  headers: { "HTTP-Referer": "https://github.com/monkey-see-monkey-do", "X-Title": "monkey-see-monkey-do" },
  maxRetries,
  seed,
  provider,
  supportsTemperatureZero: null, // measured, never assumed; see the report
});

/**
 * List the providers OpenRouter will route a model to.
 * Useful before pinning: you need a real provider slug, not a guess.
 */
export const listProviders = async (model, { apiKeyEnv = "OPENROUTER_API_KEY", fetchImpl = fetch } = {}) => {
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new AdapterError(`Missing API key. Set ${apiKeyEnv} first.`);
  const res = await fetchImpl(`https://openrouter.ai/api/v1/models/${encodeURIComponent(model)}/endpoints`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new AdapterError(`Could not list providers: HTTP ${res.status}`);
  const json = await res.json();
  const endpoints = json?.data?.endpoints ?? json?.data ?? [];
  return endpoints.map((e) => ({
    provider: e.provider_name ?? e.name,
    contextLength: e.context_length ?? e.max_context_length,
    maxCompletion: e.max_completion_tokens,
    quantization: e.quantization,
    uptime: e.uptime_last_30m ?? e.stats?.uptime_last_30m,
  }));
};
