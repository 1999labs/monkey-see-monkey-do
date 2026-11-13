# Monkey See 🙉 Monkey Do 🙊

Two small, mechanically scored diagnostics for model-generated JavaScript:
**Monkey See** measures rule identification from examples within declared hypothesis
classes. **Monkey Do** measures construction of general solvers for string-rewrite
systems. They are useful for inspecting specific failures. Their relationship to
performance in agentic software engineering has not been validated.

**Suite 2.1.0 is a new experiment.** Its examples, prompts, coverage and scoring
are incompatible with v1. Published v1 reports remain historical evidence; see
[the v1 README](docs/legacy-v1.md) and [migration notes](docs/migration-v2.md).
There are no model results for v2 yet.

## Run

Node 20 or newer. No dependencies to install.

```sh
npm test
npm run self-test
npm run dry-run
npm run all -- -m ollama/your-model -r 3
# Hosted example; configure the provider, key and reasoning effort first:
npm run all -- -m openrouter/vendor/model --only-provider Provider --no-fallback -r 3
```

The default full run makes **51 model calls per repeat**: 48 SEE calls and three
DO calls. Existing [provider configuration](docs/scoring-models.md) applies.
Reasoning effort comes from the model configuration and is recorded in evidence.

## What is measured

SEE has six families: threshold arithmetic, modular arithmetic, conditional string
transforms, cyclic rotations, distinct order statistics, and array filtering with
ordering. Each has two independently selected rule instances, 16 shown examples,
and 50 distinct held-out inputs. Shown and held-out inputs never overlap within an
instance. The prompt declares the candidate hypothesis class. Every 16-example prefix identifies exactly one candidate in that class.
Prefixes through eight examples retain at least two plausible candidates.
Held-out inputs independently distinguish the target from every incorrect candidate. This is a constrained induction task,
not a claim that finite examples uniquely determine an arbitrary program.

Levels 2, 4 and 8 are diagnostic only: reports include accuracy and the number
of candidates consistent with the examples. Level 16 contributes to accuracy,
with equal weight for each family and instance. **SEE = 50 × mean
held-out accuracy.** Non-throwing rate and the shown-minus-held-out gap are reported
separately. Incorrect or uncallable programs retain every case in the denominator.

DO has three systems: branching growth, reversible commuting swaps, and overlapping
reductions. Each has four chains at shortest distances 5, 10, 20, 30 and 50: **60
chains total**. One model call produces a solver per system; each invocation gets a
fresh JavaScript context. Returned values are serialized within the execution
timeout before the host inspects them. **DO = 50 × mean solved fraction**, balanced across the
three systems and five bands. A legal prefix earns zero. Any valid complete path
within the published execution limits earns full credit.

The reports emphasize the two scores, per-family/per-system results, level curves,
and observed repeat ranges. There is **no adjusted total** or engagement clawback.
API failures give missing (`null`) headline scores for affected scored axes.
The CLI exits with status 2 if any API call fails, after preserving its evidence.

## Evidence and checks

`npm run all` writes SEE, DO and combined reports. Commit combined model reports
promptly with any derived figures. They include exact prompts, responses, usage,
per-case DO outcomes, per-call SEE counts, route failures, configuration metadata,
and the pool digest. Writes use exclusive creation and refuse to overwrite.
Offline reference reports identify themselves as `dryRun: true`; they are not model
measurements. Old charts remain historical and are not a v2 publication format.

The gate checks uniqueness, shown/held-out separation, rule identifiability,
prompt hashes, recorded paths, independently searched shortest paths, sandboxed
reference solvers, and malformed/empty submissions. The full gate also regenerates
the pool byte for byte. The reference dry-run computes every DO solution from
`start` and `target`; recorded answers are never supplied to the solver.

| Command | Purpose |
|---|---|
| `npm test` | Current and historical regression tests, no network |
| `npm run self-test` | 266 checks required before scoring |
| `npm run self-test:full` | Gate plus deterministic regeneration |
| `npm run dry-run` | Offline reference execution, both axes |
| `npm run see -- -m MODEL` / `npm run do -- -m MODEL` | One axis |
| `npm run diagnose -- -m MODEL -r 3` | Repeated SEE with raw evidence |
| `npm run prompts` | All 51 prompts and their recorded hashes |
| `npm run gen-pool` / `npm run check-pool` | Generate / verify the versioned pool |
| `npm run audit` | Per-instance naive baseline counts |
| `npm run acceptance -- --strong MODEL --weak MODEL` | Three repeats each; evidence completeness and ≤2-point spread |

Acceptance requires exactly two matching current-version reports with three
complete repeats each; missing reports and forwarded help/override flags fail.
The acceptance labels do not prescribe a ranking. Passing validates operational
repeatability on this suite, not scientific validity or usefulness for a downstream
task. All existing v1 commands are available with the `legacy:` prefix for historical
reproduction; see [migration](docs/migration-v2.md).

## Limitations

- Six declared rule classes and three rewrite systems remain narrow coverage.
- Early examples are deliberately selected to preserve ambiguity through level 8.
  The 8-to-16 transition tests response to added identifying evidence; it is not
  a natural random-example sample-efficiency estimate.
- A DO score describes a generated program, not the model performing each derivation.
  Length, branching, algorithm choice and execution budget all affect the score.
- Public fixed data may be recalled. Prompt hashes and version labels do not detect
  contamination. Two parameter instances do not establish held-out-family transfer.
- Cases within an instance and chains handled by one solver are correlated.
  Repeat ranges are descriptive, not population confidence intervals.
- Low shown-minus-held-out gaps can reflect uniformly poor performance; read them
  alongside accuracy. Different response text does not imply unstable performance.
- Provider, effort, sampling settings and hardware/runtime budget are confounds.
- `node:vm` provides execution timeouts, not a security boundary or a memory cap.
  This is local evaluation infrastructure, not a service for untrusted users.
- This is not a repository-editing or agentic coding benchmark. Do not put these
  scores alongside external leaderboards or treat them as general intelligence.

See [scoring](docs/scoring-detail.md), [calibration](docs/calibration.md), and
[maintenance](docs/maintaining.md). MIT licensed.
