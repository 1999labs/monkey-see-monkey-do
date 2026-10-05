// Model registry.
//
// Maps a model string to a provider config. Adding a model must never require
// reading harness code — success criterion 5, "the real test". So the
// registry is data first:
//
//   1. config/models.json  "models"     an exact model id, e.g. "openai/gpt-4o"
//   2. config/models.json  "providers"  a prefix, e.g. "groq" makes every
//                                       "groq/<id>" work with no per-model entry
//   3. built-in presets                 openrouter, openai, ollama,
//                                       gogo/-responses/-messages,
//                                       zen/-responses/-messages
//
// The first match wins. Copy config/models.example.json to config/models.json
// to start; the example documents every field.

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { complete as openAiComplete, openRouterConfig, AdapterError } from "./openai.mjs";
import { complete as ollamaComplete } from "./ollama.mjs";
import { complete as responsesComplete } from "./responses.mjs";
import { complete as anthropicComplete } from "./anthropic.mjs";

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../../config/models.json", import.meta.url));

/** Every adapter, by the name used in config files. */
export const ADAPTERS = {
  openai: openAiComplete,
  ollama: ollamaComplete,
  responses: responsesComplete,
  anthropic: anthropicComplete,
};

/**
 * OpenCode Go and Zen each serve one key across three endpoints, so a preset
 * must pin the dialect. The prefix does it rather than a lookup table of model
 * ids: ids go stale the next time OpenCode adds a model, and a missing entry
 * would misroute a request silently instead of failing.
 *
 * Go asks clients to identify themselves with their own user agent and to send
 * a stable `x-opencode-session` per conversation, and says traffic is monitored
 * for abuse. The session id is minted once per process, not per request: a new
 * id per call would defeat the prompt caching Go routes on, and reproducibility
 * here comes from fingerprinting the responses, not from the session id.
 */
const GATEWAY_SESSION_ID = randomUUID();
const GATEWAY_HEADERS = () => ({
  // Read from package.json rather than written out here, so the version this
  // suite reports to a gateway cannot drift from the version it ships as.
  "user-agent": `monkey-see-monkey-do/${createRequire(import.meta.url)("../../package.json").version}`,
  "x-opencode-session": GATEWAY_SESSION_ID,
});

/**
 * Built-in presets. `supportsTemperatureZero` is null ("unknown") wherever it
 * depends on the specific model — OpenAI's reasoning models, for one, reject a
 * temperature parameter outright. Declare it per model in config/models.json.
 */
export const PRESETS = {
  openrouter: (model) => openRouterConfig(model),
  openai: (model) => ({
    adapter: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model,
    apiKeyEnv: "OPENAI_API_KEY",
    supportsTemperatureZero: null,
  }),
  ollama: (model) => ({
    adapter: "ollama",
    endpoint: "http://localhost:11434/api/chat",
    model,
    apiKeyEnv: null,
    // A local model with a fixed seed is deterministic at temperature 0.
    supportsTemperatureZero: true,
  }),
  // OpenCode Go, OpenAI chat dialect: GLM, Kimi, DeepSeek, MiMo, Hy, LongCat.
  gogo: (model) => ({
    adapter: "openai",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    headers: GATEWAY_HEADERS(),
    supportsTemperatureZero: null,
  }),
  // OpenCode Go, Responses dialect: Grok 4.6/4.7, GPT 5.6/6 Luna, Muse Spark.
  "gogo-responses": (model) => ({
    adapter: "responses",
    endpoint: "https://opencode.ai/zen/go/v1/responses",
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    headers: GATEWAY_HEADERS(),
    // Measured, never assumed. Reasoning models on this endpoint commonly
    // reject a temperature parameter outright, and a run must not claim
    // temperature 0 until a --runs 3 check says it was honoured.
    supportsTemperatureZero: null,
  }),
  // OpenCode Go, Messages dialect: MiniMax M3/M2.7, Qwen3.8, Qwen3.7 Plus.
  "gogo-messages": (model) => ({
    adapter: "anthropic",
    endpoint: "https://opencode.ai/zen/go/v1/messages",
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    anthropicVersion: "2023-06-01",
    headers: GATEWAY_HEADERS(),
    supportsTemperatureZero: null,
  }),

  // OpenCode Zen is the same gateway on a pay-per-token plan, and it is where
  // the frontier models live: Go carries none of them. Same three dialects, so
  // the same adapters serve both and only the endpoints differ.
  //
  // Zen, OpenAI chat dialect: GLM, Kimi, DeepSeek, MiniMax, Qwen3.8 Max.
  zen: (model) => ({
    adapter: "openai",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    headers: GATEWAY_HEADERS(),
    supportsTemperatureZero: null,
  }),
  // Zen, Responses dialect: Claude Fable 5.1, Opus 5.5, GPT 6 Astra/Sol,
  // GPT 5.6 Sol, Grok 4.7, Muse Spark.
  "zen-responses": (model) => ({
    adapter: "responses",
    endpoint: "https://opencode.ai/zen/v1/responses",
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    headers: GATEWAY_HEADERS(),
    supportsTemperatureZero: null,
  }),
  // Zen, Messages dialect: Claude Sonnet 5, Haiku 4.5, Qwen3.7/3.6, MiniMax.
  "zen-messages": (model) => ({
    adapter: "anthropic",
    endpoint: "https://opencode.ai/zen/v1/messages",
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    anthropicVersion: "2023-06-01",
    headers: GATEWAY_HEADERS(),
    supportsTemperatureZero: null,
  }),
};

const FIELDS = {
  adapter: (v) => typeof v === "string" && v in ADAPTERS,
  endpoint: (v) => typeof v === "string" && /^https?:\/\//.test(v),
  model: (v) => typeof v === "string" && v.length > 0,
  apiKeyEnv: (v) => v === null || (typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v)),
  supportsTemperatureZero: (v) => v === null || typeof v === "boolean",
  headers: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  maxRetries: (v) => Number.isInteger(v) && v >= 0,
  timeoutMs: (v) => Number.isInteger(v) && v > 0,
  // Responses dialect only. Left unset by default: a cap this harness chose
  // could truncate a solver the model had room to finish, which is scored as a
  // weak model and not as a harness bug.
  maxOutputTokens: (v) => Number.isInteger(v) && v > 0,
  maxTokens: (v) => Number.isInteger(v) && v > 0,
  anthropicVersion: (v) => typeof v === "string" && v.length > 0,
};

const describeField = {
  adapter: `one of: ${Object.keys(ADAPTERS).join(", ")}`,
  endpoint: "an http(s) URL",
  model: "a non-empty string",
  apiKeyEnv: "an ENVIRONMENT_VARIABLE name, or null for no key",
  supportsTemperatureZero: "true, false, or null (unknown)",
  headers: "an object of extra HTTP headers",
  maxRetries: "a non-negative integer",
  timeoutMs: "a positive integer of milliseconds (default 420000)",
  maxOutputTokens: "a positive integer (Responses adapters only)",
  maxTokens: "a positive integer (Messages adapters; defaults to 32000)",
  anthropicVersion: "a date string, e.g. 2023-06-01 (Messages adapters)",
};

/** Validate one entry; the error names the file, the entry and the field. */
const validateEntry = (entry, where, { requireModel }) => {
  const problems = [];
  for (const [k, v] of Object.entries(entry)) {
    if (!(k in FIELDS)) problems.push(`unknown field "${k}"`);
    else if (!FIELDS[k](v)) problems.push(`"${k}" must be ${describeField[k]}`);
  }
  for (const k of ["adapter", "endpoint", ...(requireModel ? ["model"] : [])]) {
    if (!(k in entry)) problems.push(`missing "${k}"`);
  }
  if (!("apiKeyEnv" in entry)) problems.push(`missing "apiKeyEnv" (use null for a server that needs no key)`);
  if (problems.length) throw new Error(`${where}:\n  - ${problems.join("\n  - ")}`);
};

/** Read and validate a registry file. A missing DEFAULT file is an empty registry. */
export const loadRegistry = (path = DEFAULT_CONFIG_PATH, { required = false } = {}) => {
  if (!existsSync(path)) {
    if (required) throw new Error(`model registry not found: ${path}`);
    return { path, models: {}, providers: {} };
  }
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
  const models = json.models ?? {};
  const providers = json.providers ?? {};
  for (const [id, entry] of Object.entries(models)) {
    if (!id.includes("/")) throw new Error(`${path}: model id "${id}" must look like "<provider>/<model>"`);
    validateEntry(entry, `${path} models["${id}"]`, { requireModel: true });
  }
  for (const [name, entry] of Object.entries(providers)) {
    if ("model" in entry) throw new Error(`${path} providers["${name}"]: a provider entry must not set "model"`);
    validateEntry(entry, `${path} providers["${name}"]`, { requireModel: false });
  }
  return { path, models, providers };
};

/**
 * Resolve "<provider>/<model>" to a full adapter config.
 *
 * @param {string} spec
 * @param {object} opts
 * @param {number} [opts.seed]      sent with every request
 * @param {object} [opts.provider]  OpenRouter provider pinning
 * @param {string} [opts.configPath] registry file (default config/models.json)
 */
export const resolveModel = (spec, { seed, provider, configPath } = {}) => {
  const slash = String(spec).indexOf("/");
  if (slash === -1) {
    throw new Error(
      `Model must look like "<provider>/<model>", e.g. openrouter/dots-3-note-preview:free or ollama/qwen2.5-coder:7b. Got "${spec}".`
    );
  }
  const prefix = spec.slice(0, slash);
  const rest = spec.slice(slash + 1);
  const registry = loadRegistry(configPath ?? DEFAULT_CONFIG_PATH, { required: Boolean(configPath) });

  let entry;
  let source;
  if (registry.models[spec]) {
    entry = { ...registry.models[spec] };
    source = `${registry.path} models["${spec}"]`;
  } else if (registry.providers[prefix]) {
    entry = { ...registry.providers[prefix], model: rest };
    source = `${registry.path} providers["${prefix}"]`;
  } else if (PRESETS[prefix]) {
    // The trailing ":free" is part of the model id on OpenRouter, so `rest` is
    // passed through untouched: "openrouter/dots-3-note-preview:free".
    entry = PRESETS[prefix](rest);
    source = `built-in ${prefix} preset`;
  } else {
    const known = [...new Set([...Object.keys(PRESETS), ...Object.keys(registry.providers)])];
    throw new Error(
      `Unknown provider "${prefix}". Known: ${known.join(", ")}.\n` +
        `  To add one, define it in config/models.json (see config/models.example.json) —\n` +
        `  any OpenAI-compatible endpoint works with "adapter": "openai".`
    );
  }

  if (provider && !/openrouter\.ai/.test(entry.endpoint)) {
    throw new Error(`Provider pinning (--only-provider, --order-provider, --no-fallback) is an OpenRouter feature; ${spec} does not use OpenRouter.`);
  }

  return { maxRetries: 2, ...entry, seed, provider, source };
};

/**
 * The flag required to score a model that cannot run at temperature 0. The
 * name is deliberately awkward so it is never passed casually.
 */
export const TEMPERATURE_OVERRIDE_FLAG = "--i-cannot-control-temperature";

/**
 * What the report and console say about temperature. Three states, never two:
 * a provider that has not been measured is "unknown", not "supported".
 */
export const temperatureStatus = (config) => {
  const supported = config?.supportsTemperatureZero ?? null;
  if (supported === true) {
    return { requested: 0, sent: true, supported: true, override: false, comparable: true, statement: "temperature 0 requested; the model config says it is supported" };
  }
  if (supported === false) {
    return {
      requested: 0,
      sent: false,
      supported: false,
      override: Boolean(config?.temperatureOverride),
      comparable: false,
      statement:
        "THIS PROVIDER CANNOT RUN AT TEMPERATURE 0. The score was recorded under " +
        `${TEMPERATURE_OVERRIDE_FLAG} and is NOT comparable with scores sampled at temperature 0.`,
    };
  }
  // Unknown registry state (the common case for frontier reasoning models
  // on the Responses / chat-completions dialects). Two sub-cases:
  //   - no override flag: the runner sends temperature: 0 and does not yet
  //     know whether the provider honoured it. comparable stays null
  //     ("unknown"), and the -r 3 reproducibility check is what resolves it.
  //   - override flag set: the runner deliberately OMITS the temperature
  //     field because the endpoint rejects it. The run is sampled at the
  //     provider default, so it is NOT comparable with a temperature-0 run
  //     and comparable must be false, not null — "unknown" would be a
  //     lie once the user has explicitly told us the field is omitted.
  const override = Boolean(config?.temperatureOverride);
  return {
    requested: 0,
    sent: !override,
    supported: null,
    override,
    comparable: override ? false : null,
    statement: override
      ? `temperature 0 requested but NOT sent: this run was recorded under ${TEMPERATURE_OVERRIDE_FLAG} ` +
        `and is NOT comparable with scores sampled at temperature 0 (sampled at the provider default).`
      : "temperature 0 requested; whether the provider honours it is UNKNOWN until a --runs 3 reproducibility check",
  };
};

/** Call whichever adapter the config names. Configs without one are OpenAI-compatible. */
export const complete = (config, promptText, opts) => {
  const fn = ADAPTERS[config.adapter ?? "openai"];
  if (!fn) throw new AdapterError(`Unknown adapter "${config.adapter}"`);
  return fn(config, promptText, opts);
};

export const KNOWN_EXAMPLES = [
  "openrouter/dots-3-note-preview:free",
  "openrouter/<any-openrouter-model-id>",
  "openai/gpt-4o",
  "ollama/qwen2.5-coder:7b",
  "gogo/glm-5.3",
  "gogo-responses/grok-4.7",
  "gogo-messages/minimax-m3",
  "zen/glm-5.3",
  "zen-responses/gpt-6-astra",
  // Fable is a Messages model, not a chat one: pick the prefix from the
  // dialect OpenCode documents for the model, not from its family.
  "zen-messages/claude-fable-5.1",
];
