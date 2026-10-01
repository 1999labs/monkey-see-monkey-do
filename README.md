## Monkey See, Monkey Do 🙉

Two automated model evals that probe two narrow skills: **induction**, generalizing a
rule from examples instead of copying their surface; and **solver soundness**, writing
code that only makes moves it can prove are safe and stops when nothing can be proven.
No human scoring, no LLM judges, no runtime dependencies.

| Eval | Question | Score |
|---|---|---|
| **Monkey See** | Given 8 examples of an unknown function, does the model infer the rule, or copy the surface? | 50 points |
| **Monkey Do** | Given a Minesweeper position, does the model write a solver that only ever makes proven moves, and stops when nothing can be proven? | 50 points |

## Quickstart

You need Node.js 20 or newer, and nothing else: there is nothing to `npm install`.

```bash
npm run self-test        # validates the eval itself (a few seconds)
npm run dry-run          # plays the reference solver on all 450 boards; must say PASS and 50/50
```

Then score a model. Every runner runs the self-test first and refuses to score if it fails.

```bash
# A local model through Ollama: no key needed
ollama pull qwen2.5-coder:7b
npm run all -- -m ollama/qwen2.5-coder:7b

# A hosted model through OpenRouter
export OPENROUTER_API_KEY=sk-or-...
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
`NAME=value` line in `.env`. Keys are never written into the repository or into results.
If none is found, the runner prints the one command that stores one.

## Reading the scores

**SEE**: three tasks, 50 held-out cases each, 15 points per task plus 5 for code that does not
throw. The **Monkey Index** is `seen pass rate − held-out pass rate`, reported descriptively and
never as a claim about the model: 0–10 `generalizes` (held-out performance matches shown
performance), 11–30 `mostly generalizes`, 31–60 `partial`, 61+ `SURFACE FIT` (shown performance
carried no information about held-out). A naive implementation of each task scores 32–36%, by design.

**DO**: the model writes `solve(board, mines)` once; it is replayed on 450 generated boards.
Every move is checked: a move must be *provably* safe, not merely lucky.

| Component | Points |
|---|---|
| Pool A (300 boards, solvable by pure deduction): boards won | 30 |
| Pool A: no detonation, no unproven guess, no broken output | 10 |
| Pool B (150 boards that reach a position where nothing is provable): stopped correctly by returning `null` there | 10 |

Outcomes per board: `won`, `surrender` (a correct stop), `premature_surrender`, `detonation`,
`unproven_move` (safe by luck, scored like a detonation), `protocol_violation`, `stalled`.
Random play survives 0% of boards, so a Pool A win cannot be luck. It does not show the solver was
derived rather than recalled; see the first two limitations.

## Limitations

Every report carries these, and a score quoted without them is misleading:

- **Not a coding benchmark.** Neither eval edits a repository, runs a test suite, or uses tools;
  they measure rule inference (SEE) and solver soundness (DO), the induction and deduction named
  in the lead, not software engineering.
- **DO scores a program, not a chain of thought.** The model writes `solve(board, mines)` in a
  single call and never sees an individual board, so a DO score describes the code it emitted,
  not deduction performed at inference time. A correct solver may be recalled rather than derived.
- **A low Monkey Index is evidence of generalization, not proof of abstraction.** It shows
  performance carried from shown to held-out inputs within one distribution; a heuristic fitted to
  that distribution would score the same.
- **Neither eval controls for prior exposure.** There is no canary and no novel-format control, so
  a high score cannot be attributed to reasoning over recall of the specific task or the textbook
  algorithm.
- **SEE saturates.** Frontier models reach high SEE scores and it stops discriminating at the top of
  the market; it is most informative for open-weight and mid-tier models.
- **Not comparable to SWE-bench, HumanEval, or any external leaderboard.** Different scale, different
  construction; never present these numbers alongside one.
- **DO has residual contamination risk.** Constraint propagation with search is a textbook
  algorithm, so a high DO score shows the model can produce a correct solver, not that it deduced
  one afresh.
- **Two narrow tasks.** Not a general intelligence measure, and the 50-point weights are hand-chosen
  (frozen at suite version 0.2.0).

## Maintaining the suite

| Command | What it does |
|---|---|
| `npm test` | Unit and end-to-end tests (no network; the CLI tests use a stubbed fetch) |
| `npm run self-test` | The 114-check gate every runner enforces before it will score anything |
| `npm run self-test:full` | Self-test plus a byte-for-byte regeneration of the board pool (minutes) |
| `npm run gen-pool` | Regenerates `src/do/minesweeper/pool.json` from seed `0x5EED` |
| `npm run check-pool` | Regenerates in memory and compares with the file byte for byte |
| `npm run prompts` | Prints every prompt with its SHA-256 and whether it matches the recorded digest |
| `npm run acceptance -- --strong <model> --weak <model>` | The publication gate; add `--quick` to rehearse |
| `npm run diagnose -- -m <model>` | Runs each SEE task several times and saves raw responses, to tell endpoint noise from harness bugs |

Every push and pull request runs `npm test` and `npm run self-test` on Node 20 via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). Pool regeneration is deliberately
off that path because it takes minutes, so `check-pool` and `self-test:full` run nightly and on
demand from the Actions tab instead. There are no dependencies to install, so CI only
checks out and runs Node.

Changing a prompt changes its digest: update `src/prompt-digests.mjs` and bump the suite version, deliberately.
Changing the oracle or pool classification: bump `GENERATOR_VERSION` in `pool.mjs` and run
`npm run gen-pool`; loading a pool built by a different generator fails loudly.

Every number the suite asserts (the naive baselines, the 0% random baseline, the
effort cap and how it was derived, the pool's shape and acceptance rates) is
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
| Oracle reaches 100% | The reference solver wins every Pool A board and stops correctly on every Pool B board, so a dry run scores 50/50 |
| Variance is low | Three runs at `temperature: 0` differ by ≤ 2 points |
| Self-test passes | Every self-test check, including full pool regeneration |

If any criterion fails, the eval is not published. An eval that does not
discriminate is worse than no eval, because it manufactures false confidence.

```
monkey-see-monkey-do/
├── config/models.example.json   model registry template
├── docs/calibration.md          every asserted number, and how it was measured
├── src/
│   ├── adapters/                openai.mjs, ollama.mjs, registry.mjs
│   ├── sandbox.mjs              node:vm execution, per-call timeout, code extraction
│   ├── cli.mjs                  shared runner plumbing, temperature rule, self-test gate
│   ├── key.mjs                  API key resolution, shared by both evals
│   ├── fingerprint.mjs          response hashing and reproducibility, shared by both evals
│   ├── self-test.mjs            the checks that must pass before any score is recorded,
│   │                            and the `npm run self-test` entry point
│   ├── prompt-digests.mjs       recorded SHA-256 of every prompt
│   ├── report.mjs               JSON reports and the limitations they carry
│   ├── run-all.mjs              both evals, one model, combined report
│   ├── see/                     SEE only: reference.mjs (ground truth), tasks/*.json,
│   │                            tasks.mjs, prompt, score, run
│   └── do/                      DO only: prompt, score, run, reference-solver.mjs
│       └── minesweeper/         board.mjs, oracle.mjs, pool.mjs, pool.json
├── bin/                         command-line entry points, one per npm script:
│                                gen-pool, acceptance, diagnose, providers, show-prompts
├── compare.sh                   run several pinned models 3× each, side by side
└── tests/                       node:test suites
```

`src/see/` and `src/do/` hold only what is private to their own eval. Anything both
evals need (key resolution, response fingerprinting, the sandbox, reporting) lives at
the top of `src/`, so neither eval's folder reaches into the other's.

## Provenance

A working design document covering the reasoning behind every number in here
existed alongside the code; it was removed from the working tree and remains in
the git history.
