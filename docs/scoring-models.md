# How to score models — providers, keys, custom registries

The Quickstart in the README covers the common paths. This file covers the rest of
"getting a model wired up": the OpenCode Go/Zen prefixes with their dialect traps,
key resolution, custom provider registries, and the OpenRouter pinning rule that
makes a hosted score a measurement instead of a dice roll.

The prefixes that work with no configuration file at all:
`openrouter/…` · `openai/…` · `ollama/…` · `gogo/…` · `gogo-responses/…` ·
`gogo-messages/…` · `zen/…` · `zen-responses/…` · `zen-messages/…`

## OpenCode Go and Zen

Both serve one key across the same three dialects, so the prefix picks the endpoint rather than a
lookup table of model ids, which would go stale the next time OpenCode adds a model. Go is the
subscription plan for open models; Zen is pay-per-token and is where the frontier models are.

| Prefix | Go endpoint | Zen endpoint | Dialect |
|---|---|---|---|
| `gogo/`, `zen/` | `/zen/go/v1/chat/completions` | `/zen/v1/chat/completions` | OpenAI chat |
| `gogo-responses/`, `zen-responses/` | `/zen/go/v1/responses` | `/zen/v1/responses` | OpenAI Responses |
| `gogo-messages/`, `zen-messages/` | `/zen/go/v1/messages` | `/zen/v1/messages` | Anthropic Messages |

```bash
export OPENCODE_API_KEY=...
npm run all -- -m gogo-responses/grok-4.7
npm run all -- -m zen-messages/claude-fable-5.1
```

**Pick the prefix from the dialect OpenCode documents for that model, not from its family.**
Claude Fable is a Messages model, so it is `zen-messages/claude-fable-5.1`, even though it is the
strongest model in the catalogue. The wrong prefix is a 404 rather than a misrouted request, which
is the intended failure.

Both ask clients to send their own user agent and a stable `x-opencode-session`, and Go says traffic
is monitored for abuse. The presets send both, with one session id per process so the calls of a run
share it and prompt caching still applies.

Three limits worth knowing. Go's per-model monthly caps bind well before Zen's pay-per-token
pricing does, so a `-r 3` check on an expensive model can stall partway through a month.
`--only-provider` is refused for both, since each is the only route to its models. And Zen serves
seven Gemini models on a fourth dialect, `/v1/models/gemini-*`, which has no adapter here.

## Keys

Checked in this order: `--key`, the provider's environment variable,
`~/.config/monkeydo/keys/<ENV_NAME>` (or `~/.config/monkeydo/key` for OpenRouter), then a
`NAME=value` line in `.env`. Keys are never written into the repository or into results.

## Adding a provider that is not built in

Only needed for an endpoint the suite does not already speak. Still no code changes.
Copy the example registry and edit it:

```bash
cp config/models.example.json config/models.json
```

```json
{
  "providers": {
    "groq": {
      "adapter": "openai",
      "endpoint": "https://api.groq.com/openai/v1/chat/completions",
      "apiKeyEnv": "GROQ_API_KEY",
      "supportsTemperatureZero": null
    }
  },
  "models": {
    "openai/o3-mini": {
      "adapter": "openai",
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "o3-mini",
      "apiKeyEnv": "OPENAI_API_KEY",
      "supportsTemperatureZero": false
    }
  }
}
```

- A **provider** entry makes every `groq/<model-id>` work. A **model** entry configures one id exactly.
- `adapter` is `openai` for any OpenAI-compatible `/chat/completions` endpoint (OpenRouter, Groq,
  Together, vLLM, LM Studio, …), `responses` for any OpenAI Responses endpoint, `anthropic` for any
  Anthropic Messages endpoint, or `ollama`.
- `apiKeyEnv` names the environment variable holding the key; `null` means no key (local servers).
- `supportsTemperatureZero`: `true`, `false`, or `null` (unknown until a `-r 3` check). With
  `false` the runner **refuses to score** unless you pass `--i-cannot-control-temperature`, and the
  result is stamped as not comparable. A model sampled above temperature 0 is a different experiment.
- `maxOutputTokens` caps the response on `responses` adapters. Leave it unset: a limit this harness
  chose can truncate a solver the model had room to finish, and a self-inflicted truncation scores
  like a weak model.
- `maxTokens` is the required `max_tokens` on `anthropic` adapters. It defaults to 32000. Raise it
  if a long solver is truncated; lower it only to cap cost.
- `anthropicVersion` is the date header that dialect requires, e.g. `2023-06-01`.
- `timeoutMs` is how long one model call may take before it is abandoned, defaulting to
  **420000** (7 minutes). That covers the slowest response measured against a real endpoint
  (361s) with headroom, because reasoning models emit tokens for minutes before answering. Set it
  per model for anything slower. A timeout is **never retried**: it has already spent the whole
  budget, and three attempts turned one stalled model into an 18-minute wait. Other transport
  failures are still retried. The budget in force is stamped as `solver.callTimeoutMs`, so a
  timeout is readable afterwards rather than looking like an unexplained zero.

Built in, with no config: `openrouter/…`, `openai/…`, `ollama/…`, `gogo/…`, `gogo-responses/…`,
`gogo-messages/…`, `zen/…`, `zen-responses/…`, `zen-messages/…`.

## Pin the provider on OpenRouter, or the score is not a measurement

One model id is served by many hosts. `deepseek/deepseek-v4.1-flash` had **33** endpoints at the
time of writing, across `fp4`, `fp8`, `fp32` and unquantised builds. An unpinned run therefore
samples a different machine each time, and `-r 3` reports `NOT_REPRODUCIBLE` for a model that is
in fact fine. Measured: one unpinned model returned totals of 21, 50 and 50.

```bash
npm run providers -- -m openrouter/deepseek/deepseek-v4.1-flash
npm run do -- -m openrouter/deepseek/deepseek-v4.1-flash --only-provider Alibaba --no-fallback -r 3
```

Two things to expect. A slug from the listing may still be unavailable to your account, in which
case the request fails with "0 endpoints out of 1 requested are available"; `--no-fallback` then
fails the run outright instead of quietly routing elsewhere, which is the point. And a pinned
provider may simply be worse: Alibaba timed out on all three runs for a model that other providers
answered in 203s.

## What `npm run all` writes

Three reports land in `results/`: `<model>-<date>-<time>.json` (SEE),
`do-<model>-<date>-<time>.json` (DO) and `combined-<model>-<date>-<time>.json` (the time component
is UTC so a same-day re-run adds evidence instead of silently overwriting). `npm run see` and
`npm run do` run one eval each.

Of the three, only the **combined** report is committed, because it is the evidence for every
number the cohort tables and charts print, and a chart whose source reports are absent cannot be
audited. The per-eval reports stay local: they carry the per-chain and per-level detail and the raw
model response, nothing published cites them directly, and they are regenerated by the next run. A
cohort added to the README should commit its combined reports alongside its cohort JSON, or the
chart is a claim without a source.

`-r 3` runs everything three times. The totals should agree within 2 points; if the model returned
different code each time, the output says so, and the score is a sample, not a measurement.
