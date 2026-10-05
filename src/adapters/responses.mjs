// Adapter for any OpenAI Responses endpoint (/v1/responses).
//
// Same contract as the OpenAI adapter: one user message, temperature 0, no
// system prompt, and a retry only on a TRANSPORT failure — never on an answer
// that actually arrived.
//
// The wire format differs in three ways that matter to a scoring harness:
//
//   1. Text lives in output[]. A reasoning model puts a `reasoning` item FIRST,
//      whose summary and content hold the chain of thought. Only `output_text`
//      blocks inside a `message` item are the answer. Reading the wrong item
//      would push chain of thought through the code extractor and the
//      reproducibility fingerprint, so the walk is explicit about types.
//   2. There is no finish_reason. `status` is "completed" / "incomplete" /
//      "failed" and `incomplete_details.reason` says why, usually
//      "max_output_tokens". Truncation is REPORTED, never raised: a response we
//      received is scored exactly as it arrived, so the reason rides along in
//      finishReason where the report will show it.
//   3. `seed` is refused rather than ignored. Sending an unsupported parameter
//      is a 400, but silently dropping one the user asked for would hand them a
//      reproducibility claim the run cannot support. Reproducibility on this
//      adapter is established with --runs 3, not with a seed.

import { setTimeout as delay } from "node:timers/promises";

import { AdapterError } from "./openai.mjs";

// Matches the OpenAI adapter: a reasoning model on this endpoint may need
// minutes, and three attempts at a short ceiling cost an 18-minute wait.
const DEFAULT_TIMEOUT_MS = 420_000;

/**
 * The answer, and only the answer, out of an `output` array.
 *
 * Returns null when there is no array to walk (a proxy that returns just
 * `output_text`), so the caller can decide whether that is fatal.
 *
 * `missed` names the shapes that carried text we did NOT take. This is the
 * guard against silent degradation: if this adapter's idea of the response
 * shape is ever wrong, a renamed block type or item type would otherwise make
 * the walk find nothing and the harness would record a zero, which reads
 * exactly like a model that could not answer. Naming the shapes we skipped
 * turns that failure into a loud one, and it does so without having to guess
 * what the new shape is called.
 */
const extractAnswer = (output) => {
  if (!Array.isArray(output)) return null;
  let text = "";
  const missed = [];
  for (const item of output) {
    // `reasoning` items are skipped deliberately: their summary and content
    // hold chain of thought, which must never reach the code extractor or the
    // fingerprint. They are not "missed", they are excluded on purpose.
    if (item?.type === "reasoning") continue;
    if (item?.type !== "message") {
      if (typeof item?.text === "string" && item.text) missed.push(`item:${item.type ?? "untyped"}`);
      continue;
    }
    for (const block of item.content ?? []) {
      if (block?.type === "output_text" && typeof block.text === "string") {
        text += block.text;
      } else if (typeof block?.text === "string" && block.text) {
        // A refusal carries `refusal`, not `text`, so it stays an empty answer.
        missed.push(`block:${block.type ?? "untyped"}`);
      }
    }
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
      "This adapter does not send a seed. It is not part of the Responses request, " +
        "and dropping it silently would claim a reproducibility guarantee the run cannot " +
        "support. Drop --seed, or point the model at an adapter that sends one.",
      { retryable: false }
    );
  }

  const body = {
    model,
    // The explicit array rather than a bare string, so "one user message, no
    // system prompt" is guaranteed by the request instead of inferred from a
    // shorthand. `instructions` is deliberately never set.
    input: [{ role: "user", content: [{ type: "input_text", text: promptText }] }],
    stream: false,
  };
  // Temperature is opt-in, never opt-out to a non-zero value. The
  // override flag ("i-cannot-control-temperature") means the endpoint
  // rejects `temperature=0` outright — the harness path is to omit the
  // field entirely, NEVER to substitute a different value. A model
  // sampled above 0 is a different experiment and the CLI pre-flight
  // stamps the run as `not comparable`; the override here must do the
  // same. See src/cli.mjs for the user-facing wording.
  if (config.supportsTemperatureZero !== false && !config.temperatureOverride) body.temperature = 0;

  // Reasoning effort, when the operator has pinned one. Same contract as the
  // chat-completions adapter (see src/adapters/openai.mjs): the Responses
  // dialect takes `reasoning: { effort }`, unset omits the parameter so the
  // provider's own default applies, and an effort the model does not list is
  // refused earlier, at pre-flight.
  if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };
  // Omitted rather than defaulted: a cap this harness chose could truncate a
  // solver the model had room to finish, and a self-inflicted truncation is
  // indistinguishable from a weak model once it is scored.
  if (config.maxOutputTokens != null) body.max_output_tokens = config.maxOutputTokens;

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
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...headers,
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
        // `attempts: attempt + 1` is correct on both paths out of here, as in
        // the OpenAI adapter: a thrown non-retryable status has made this many
        // attempts, and an exhausted loop leaves the final count on lastError.
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

      const usage = json.usage
        ? {
            prompt_tokens: json.usage.input_tokens ?? null,
            completion_tokens: json.usage.output_tokens ?? null,
            // Carried so a truncated run can be explained after the fact:
            // reasoning_tokens high next to max_output_tokens means the budget
            // went to thinking, not to a solver that was too long.
            reasoning_tokens: json.usage.output_tokens_details?.reasoning_tokens ?? null,
          }
        : null;

      const found = extractAnswer(json.output);

      if (found === null || (found.text === "" && typeof json.output_text === "string")) {
        // Either there is no output array to walk, or the walk came back empty
        // while the response still carries a top-level convenience field. A
        // gateway that flattens or renames its blocks populates that field, so
        // prefer it over declaring the answer unreadable. In both branches the
        // walk contributed nothing, so this one field is the whole answer.
        if (typeof json.output_text === "string") {
          return {
            text: json.output_text,
            finishReason: json.status ?? null,
            providerModel: json.model ?? model,
            usage,
            empty: json.output_text.length === 0,
          };
        }
        if (found === null) {
          // Nothing to extract from and nothing to fall back on. Better to
          // refuse to score than to score a response we could not read.
          throw new AdapterError("Response contained no output", { status: res.status, body: text.slice(0, 500) });
        }
      }

      if (found.text === "" && found.missed.length > 0) {
        // Text we did not recognise, and no answer we did. Scoring this as an
        // empty completion would file an adapter bug as a model failure, and
        // the two are indistinguishable in a report. Name the shapes so the
        // fix is a one-line change to extractAnswer.
        throw new AdapterError(
          `Could not extract the answer: found text in response block shape(s) this ` +
            `adapter does not recognise (${[...new Set(found.missed)].join(", ")}), and no ` +
            `output_text block. The provider's response format has probably changed.`,
          { status: res.status, body: text.slice(0, 500) }
        );
      }

      return {
        text: found.text,
        finishReason:
          json.status === "incomplete"
            ? (json.incomplete_details?.reason ?? "incomplete")
            : (json.status ?? null),
        providerModel: json.model ?? model,
        usage,
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