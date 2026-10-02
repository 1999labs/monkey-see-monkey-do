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

// Generous by default, because a reasoning model that emits only reasoning
// tokens needs minutes, not seconds: measured against OpenRouter, DeepSeek
// V4.1 Flash returned a full solver in 203s while another provider serving the
// same model id was still silent at 361s. A 120s ceiling failed models that
// could answer, and hid that behind a crash.
//
// 420s covers the slowest response observed (361s) plus headroom. Override it
// per model in config/models.json for anything slower; see timeoutMs there.
//
// A stalled model costs one attempt, not three: see the timeout note in
// complete() below. Raising the ceiling therefore costs one long wait, not three.
export const DEFAULT_TIMEOUT_MS = 420_000;

export class AdapterError extends Error {
  constructor(message, { status, retryable = false, body, timedOut = false, timeoutMs = null, attempts = null } = {}) {
    super(message);
    this.name = "AdapterError";
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    // Distinguishes "we gave up waiting" from "the provider refused". The
    // report needs the difference: one describes the route, the other is an
    // answer of sorts.
    this.timedOut = timedOut;
    this.timeoutMs = timeoutMs;
    // How many attempts this error cost: 1 for a hard refusal or a timeout
    // (never retried), maxRetries + 1 when a retriable failure exhausted the
    // loop. A report that cannot tell three refused attempts from one is a
    // report that cannot explain its own zeros.
    this.attempts = attempts;
  }
}

/**
 * True for an abort caused by OUR timeout, not one a caller passed in.
 * fetch rejects with an AbortError for both, so the timer we set ourselves is
 * what distinguishes them.
 */
const isTimeout = (err) =>
  err?.name === "AbortError" || err?.code === "ABORT_ERR" || /abort|timeout/i.test(String(err?.message ?? ""));

/**
 * One completion. Returns the raw assistant text plus the metadata needed for
 * the report (finish_reason, usage, and the provider's own model id — which
 * may differ from the id we asked for).
 */
export const complete = async (config, promptText, { timeoutMs } = {}) => {
  const { endpoint, model, apiKeyEnv, headers = {}, fetchImpl = fetch, maxRetries = 2 } = config;
  // A per-model timeoutMs in config/models.json overrides the default, so a
  // slow reasoning model and a fast small one need not share a ceiling.
  const budget = config.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    // Explicit, though it is also the default: a gateway that defaults to
    // streaming when the field is absent would answer with SSE, and the JSON
    // parse below would die as a confusing non-JSON error.
    stream: false,
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
    const timer = setTimeout(() => ac.abort(), budget);
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
        // `attempts: attempt + 1` is correct on both paths out of here: a
        // non-retryable status is thrown after this many attempts, and a
        // retriable one that exhausts the loop leaves lastError holding the
        // final attempt's count.
        lastError = new AdapterError(`HTTP ${res.status}: ${detail}`, {
          status: res.status,
          retryable,
          attempts: attempt + 1,
          body: text.slice(0, 500),
        });
        if (retryable) continue;
        throw lastError;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AdapterError("Endpoint returned non-JSON", { status: res.status, attempts: attempt + 1, body: text.slice(0, 500) });
      }

      const choice = json.choices?.[0];
      if (!choice) {
        throw new AdapterError("Response contained no choices", { status: res.status, body: text.slice(0, 500) });
      }
      // OpenRouter reports provider failures IN BAND: a choice whose provider
      // died mid-request carries an error object beside a null content. Reading
      // only the content scored those as "the model answered nothing" — a zero
      // filed as a model failure when it was the route. Fail loudly instead.
      if (choice.error) {
        const code = choice.error.code;
        throw new AdapterError(`provider error: ${choice.error.message ?? "no message given"}`, {
          status: typeof code === "number" ? code : undefined,
          retryable: code === 429 || (typeof code === "number" && code >= 500),
          attempts: attempt + 1,
          body: text.slice(0, 500),
        });
      }
      const content = choice.message?.content;
      if (content !== null && content !== undefined && typeof content !== "string") {
        // Text arrived in a shape this adapter does not read (e.g. an array of
        // content parts from a gateway). Silently scoring it as empty would
        // file a format change as a model failure, which is indistinguishable
        // from a weak model in the report. Name the shape instead.
        throw new AdapterError(
          `Response content was ${Array.isArray(content) ? "an array" : typeof content}, not a string. ` +
            `The endpoint's response format is not one this adapter reads.`,
          { status: res.status, attempts: attempt + 1, body: text.slice(0, 500) }
        );
      }
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

      // A timeout is NOT retried. It already consumed the whole budget, and
      // doing it three times turns one stalled model into an 18-minute wait
      // (measured: 361s x 3). The request was abandoned, not refused: the
      // provider may simply have been slow, in which case one longer budget
      // configured per model is the right lever, not three identical short
      // ones. Every other transport failure is still retried, because those
      // cost milliseconds.
      if (isTimeout(err)) {
        throw new AdapterError(`Request timed out after ${budget}ms: ${err?.message ?? err}`, {
          retryable: false,
          timedOut: true,
          timeoutMs: budget,
          // Never retried, so the count is exactly one wait.
          attempts: 1,
        });
      }

      lastError =
        err instanceof AdapterError
          ? err
          : new AdapterError(String(err?.message ?? err), { retryable: true, attempts: attempt + 1 });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new AdapterError("Request failed", { retryable: true, attempts: maxRetries + 1 });
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
  // encodeURIComponent is WRONG here: it turns the "vendor/model" id into
  // "vendor%2Fmodel", and OpenRouter 404s on the encoded slash. Verified
  // against the live API: the encoded path returns
  // {"error":{"message":"Not Found","code":404}} while the raw slash returns
  // the endpoint list. This broke for every model id containing a slash, which
  // is nearly all of them. Only the path is interpolated, and the model id is
  // attacker-controlled only insofar as it comes from a config file, so encode
  // the segments instead: keep the single slash, escape everything else. The
  // colon of a ":variant" id survives as %3A, which the live API also accepts
  // (verified: "deepseek/deepseek-v4.1-flash:free" returns 200 with its own,
  // possibly empty, endpoint list — an empty list is a real answer, meaning no
  // provider is currently serving that variant).
  const encoded = String(model)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const res = await fetchImpl(`https://openrouter.ai/api/v1/models/${encoded}/endpoints`, {
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
