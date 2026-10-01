# Working in this repository

Two automated model evals with no dependencies and no build step. Monkey See scores
rule inference (induction); Monkey Do scores solver soundness (deduction). Nothing here
edits a repository or runs a test suite on the model's behalf. See the Limitations
section of `README.md` before describing these as coding benchmarks.

Node 20 or newer. There is nothing to `npm install`.

## Run the gate before anything else

Every runner runs `npm run self-test` first and refuses to score if it fails. Run it
yourself before claiming any change works:

```bash
npm test          # unit and end-to-end tests, no network
npm run self-test # the 141-check gate every runner enforces before scoring
```

Never report a score from a run whose self-test did not pass. Never score a model
without it succeeding.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit and end-to-end tests (no network; CLI tests use a stubbed fetch) |
| `npm run self-test` | The 141-check gate every runner enforces before it will score anything |
| `npm run self-test:full` | Self-test plus a byte-for-byte regeneration of the board pool (minutes) |
| `npm run dry-run` | Reference solver on all 450 boards; must say PASS and 50/50 |
| `npm run all -- -m <model>` | Both evals, one model, three reports |
| `npm run see -- -m <model>` / `npm run do -- -m <model>` | One eval each |
| `npm run gen-pool` | Regenerates `src/do/minesweeper/pool.json` from seed `0x5EED` |
| `npm run check-pool` | Regenerates in memory and compares with the file byte for byte |
| `npm run prompts` | Prints every prompt with its SHA-256 and whether it matches the recorded digest |
| `npm run acceptance -- --strong <m> --weak <m>` | The publication gate; `--quick` rehearses on a subset and can never report a pass |
| `npm run diagnose -- -m <model>` | Runs each SEE task several times and saves raw responses |
| `node bin/chart.mjs <cohort>.json [<out>.svg]` | Regenerates a cohort chart from its JSON report data |

Reproduce the pipeline with `npm run dry-run` before touching scoring logic: it proves
the reference solver still wins every Pool A board and stops correctly on every Pool B
board.

## Changing things

**A prompt.** Changing a prompt changes its digest. Update `src/prompt-digests.mjs`
and bump the suite version, deliberately. Not as a side effect of an unrelated edit.

**The oracle or the pool classification.** Bump `GENERATOR_VERSION` in
`src/do/minesweeper/pool.mjs` and run `npm run gen-pool`. Loading a pool built by a
different generator fails loudly; that failure is intended, not a bug to work around.

**A held-out set, the pool, the oracle, or the effort cap.** Read
`docs/calibration.md` first. Every asserted number is recorded there with the command
that re-derives it: the naive baselines, the 0% random baseline, the effort cap and how
it was derived, the pool's shape and acceptance rates, the Progress Index's depth
reference of 75, and the adjusted total's weights.

**The adjusted total's weights.** They live in `src/adjusted.mjs` rather than buried in
a formula, so a reader can disagree with them. They are hand-chosen and frozen at suite
version 0.2.0.

## What gets committed

Only the **combined** report is committed: `results/combined-<model>-<date>.json`. It is
the evidence for every number the cohort tables and charts print, and a chart whose
source reports are absent cannot be audited.

The per-eval reports (`<model>-<date>.json`, `do-<model>-<date>.json`) stay local. They
carry 450 `boardResults` and the raw model response, and nothing published cites them
directly.

A cohort added to `README.md` must commit its combined reports alongside
`docs/cohort-*.json`, or the chart is a claim without a source. Charts are generated
from that JSON, never drawn by hand, so a figure cannot drift from the numbers behind it.

## Reporting a number

The suite's reports carry their limitations, and a score quoted without them is
misleading. Three that get violated most often:

- **A zero can mean the endpoint, not the model.** Any run whose report carries a
  non-null `solver.callFailure` (DO) or `callFailure` (SEE) scored zero because the call
  failed. Never present those totals as model results. Check the field before quoting the
  number.
- **A score describes one provider, not a model.** OpenRouter load-balances across
  providers. Pin one with `--only-provider --no-fallback` or the number mixes machines.
  Use `npm run providers -- -m <model>` to list what serves a model.
- **The adjusted total is derived and hand-weighted.** It is a reporting layer for
  plotting. Quote it with the components it came from, never alone.

Never present these numbers alongside SWE-bench, HumanEval, or any external leaderboard.
Different scale, different construction.

Note also that reasoning effort is a confound on the same order as temperature: the same
model at different effort levels is a different experiment. Record the effort level
alongside any score.

## Continuous integration

`.github/workflows/ci.yml` runs `npm test` and `npm run self-test` on Node 20 for every
push and pull request. Pool regeneration is deliberately off that path because it takes
minutes, so `check-pool` and `self-test:full` run nightly and on demand from the Actions
tab instead. There are no dependencies to install, so CI only checks out and runs Node.
