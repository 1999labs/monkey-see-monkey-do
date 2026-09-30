# MONKEY SEE / MONKEY DO

Two automated evals that probe two narrow skills: **induction** — generalizing a
rule from examples instead of copying their surface — and **sound solver code,
plus knowing when you don't know**. No human scoring, no rubrics, no runtime
dependencies.

| Eval | Question | Score |
|---|---|---|
| **MONKEY SEE** | Given 8 examples of an unknown function, does the model infer the rule, or copy the surface? | 50 points + the Monkey Index |
| **MONKEY DO** | Given a Minesweeper position, does the model write a solver that only ever makes proven moves, and stops when nothing can be proven? | 50 points |

A working design document covering the reasoning behind every number in here
existed alongside the code; it was removed from the working tree and remains in
the git history.

## Quickstart

You need Node.js 20 or newer, and nothing else — there is nothing to `npm install`.

```bash
cd evals
npm run self-test        # validates the eval itself (a few seconds)
npm run dry-run          # plays the reference solver on all 450 boards; must say PASS and 50/50
```

Then score a model. Every runner runs the self-test first and refuses to score if it fails.

```bash
# A local model through Ollama — no key needed
ollama pull qwen2.5-coder:7b
npm run all -- -m ollama/qwen2.5-coder:7b

# A hosted model through OpenRouter
npm run setup-key                                   # stores your key outside the repo
npm run all -- -m openrouter/<model-id>

# OpenAI directly
export OPENAI_API_KEY=sk-...
npm run all -- -m openai/gpt-4o
```

`npm run all` runs both evals against one resolved model and writes three reports to
`results/`: `<model>-<date>.json` (SEE), `do-<model>-<date>.json` (DO) and
`combined-<model>-<date>.json`. `npm run see` and `npm run do` run one eval each.

Add `-r 3` to run everything three times. The totals should agree within 2 points; if the
model returned different code each time, the output says so, and the score is a sample,
not a measurement.

## Adding a model

No code changes. Copy the example registry and edit it:

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
  Together, vLLM, LM Studio, …) or `ollama`.
- `apiKeyEnv` names the environment variable holding the key; `null` means no key (local servers).
- `supportsTemperatureZero`: `true`, `false`, or `null` (unknown until a `-r 3` check). With
  `false` the runner **refuses to score** unless you pass `--i-cannot-control-temperature`, and the
  result is stamped as not comparable. A model sampled above temperature 0 is a different experiment.

Built in, with no config: `openrouter/…`, `openai/…`, `ollama/…`.

### Keys

Checked in this order: `--key`, the provider's environment variable,
`~/.config/monkeydo/keys/<ENV_NAME>` (or `~/.config/monkeydo/key` for OpenRouter), then a
`NAME=value` line in `evals/.env`. Keys are never written into the repository or into results.
If none is found, the runner prints the one command that stores one.

## Reading the scores

**SEE** — three tasks, 50 held-out cases each, 15 points per task plus 5 for code that does not
throw. The **Monkey Index** is `seen pass rate − held-out pass rate`: near 0 means the model
understood the rule; 61+ means it copied the examples and understood nothing. A naive
implementation of each task scores 32–36%, by design.

**DO** — the model writes `solve(board, mines)` once; it is replayed on 450 generated boards.
Every move is checked: a move must be *provably* safe, not merely lucky.

| Component | Points |
|---|---|
| Pool A (300 boards, solvable by pure deduction): boards won | 30 |
| Pool A: no detonation, no unproven guess, no broken output | 10 |
| Pool B (150 boards that reach a position where nothing is provable): stopped correctly by returning `null` there | 10 |

Outcomes per board: `won`, `surrender` (a correct stop), `premature_surrender`, `detonation`,
`unproven_move` (safe by luck — scored like a detonation), `protocol_violation`, `stalled`.
Random play survives 0% of boards, so any Pool A win is deduction.

## Limitations

Every report carries these, and a score quoted without them is misleading:

- **Not a coding benchmark.** No repository, test suite, or tools; these measure inference and deduction.
- **SEE saturates.** Frontier models score high; it discriminates best among open-weight and mid-tier models.
- **Not comparable to SWE-bench, HumanEval, or any leaderboard.** Never present the numbers side by side.
- **DO has residual contamination risk.** A correct solver is a textbook algorithm; a high score shows the
  model can produce one, not that it deduced one afresh.
- **Two narrow tasks.** Not a general intelligence measure.

## Maintaining the suite

| Command | What it does |
|---|---|
| `npm test` | Unit and end-to-end tests (no network; the CLI tests use a stubbed fetch) |
| `npm run self-test:full` | Self-test plus a byte-for-byte regeneration of the board pool (minutes) |
| `npm run gen-pool` | Regenerates `src/do/minesweeper/pool.json` from seed `0x5EED` |
| `npm run check-pool` | Regenerates in memory and compares with the file byte for byte |
| `npm run prompts` | Prints every prompt with its SHA-256 and whether it matches the recorded digest |
| `npm run acceptance -- --strong <model> --weak <model>` | The publication gate; add `--quick` to rehearse |
| `npm run diagnose -- -m <model>` | Runs each SEE task several times and saves raw responses, to tell endpoint noise from harness bugs |

Changing a prompt changes its digest: update `src/prompt-digests.mjs` and bump the suite version, deliberately.
Changing the oracle or pool classification: bump `GENERATOR_VERSION` in `pool.mjs` and run
`npm run gen-pool`; loading a pool built by a different generator fails loudly.

Every number the suite asserts — the naive baselines, the 0% random baseline, the
effort cap and how it was derived, the pool's shape and acceptance rates — is
recorded in [`docs/calibration.md`](docs/calibration.md), with the commands that
re-derive each one. Read it before changing a held-out set, the pool, the oracle
or the cap.

### The publication gate

`npm run acceptance` runs every criterion below and writes
`results/acceptance-<date>.json`. `--quick` rehearses on a subset and can never
report a pass.

| Criterion | Requirement |
|---|---|
| Discriminates strong from weak | A known-strong model outscores a 7B model on both evals |
| Naive baseline lands in band | 20–45% on every SEE task |
| Random baseline lands in band | DO random survival is 0% on every tier |
| Oracle reaches 100% | The reference solver wins every Pool A board and stops correctly on every Pool B board — a dry run scores 50/50 |
| Variance is low | Three runs at `temperature: 0` differ by ≤ 2 points |
| Self-test passes | Every self-test check, including full pool regeneration |

If any criterion fails, the eval is not published. An eval that does not
discriminate is worse than no eval, because it manufactures false confidence.

```
evals/
├── config/models.example.json   model registry template
├── docs/calibration.md          every asserted number, and how it was measured
├── src/
│   ├── adapters/                openai.mjs, ollama.mjs, registry.mjs
│   ├── sandbox.mjs              node:vm execution, per-call timeout, code extraction
│   ├── cli.mjs                  shared runner plumbing, temperature rule, self-test gate
│   ├── self-test.mjs            the checks that must pass before any score is recorded
│   ├── prompt-digests.mjs       recorded SHA-256 of every prompt
│   ├── report.mjs               JSON reports and the limitations they carry
│   ├── run-all.mjs              both evals, one model, combined report
│   ├── see/                     reference.mjs (ground truth), tasks/*.json, prompt, score, run
│   └── do/                      prompt, score, run, reference-solver.mjs
│       └── minesweeper/         board.mjs, oracle.mjs, pool.mjs, pool.json
├── scripts/                     self-test, gen-pool, acceptance, show-prompts, diagnose, providers
└── tests/                       node:test suites
```
