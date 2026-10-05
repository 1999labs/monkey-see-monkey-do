# Scoring in detail

The README carries the headline: two evals, 50 points each, a reported adjusted total. This
file carries the machinery underneath: the sample-efficiency axis, the chain scoring contract,
the reported-not-scored axes, the adjusted formula with its worked examples, and the reference
solver's two modes. Numbers asserted here are recorded with their re-derivation commands in
[`calibration.md`](calibration.md).

Both evals are out of 50, and each has a second reported axis beside its score. Monkey See
reports the **Generalization Index** (per sample level): did performance carry to inputs the
model was not shown? Monkey Do reports the **chain-engagement rate**: what fraction of the 50
chains did the model make at least one legal step on?

The two axes are deliberately parallel, because they catch the same kind of cheat in
opposite evals. Neither is scored. Both are reported beside their own eval's score, and an
**adjusted** total folds them in when you want a single number to plot.

They are not otherwise alike, and the difference matters: the Generalization Index is an
unbounded *gap* (seen − held-out, in points) subtracted from the total, while the chain-
engagement rate is a *fraction in [0, 1]* used to claw points back.

## Monkey See (induction, out of 50)

Given a handful of examples of an unknown function, does the model infer the rule or copy
its surface?

| Component | Points | What it takes |
|---|---|---|
| Per-task weightedRate × 15 | 45 | Three tasks, each scoring up to 15 points |
| Robustness | 5 | Code that does not throw on any of the 150 held-out cases |

The per-task score is a sample-efficiency axis:

- The runner shows the model the **first 2, 4, 8, or 16** of the task's shown examples.
- The per-task weighted rate is `Σ level SAMPLE_WEIGHTS[level] × heldOutRate[level]` under
  weights `{2: 0.40, 4: 0.30, 8: 0.20, 16: 0.10}`. Low-sample sizes are weighted higher, on
  the rationale that a rule inferred from 2 examples is stronger evidence of induction
  than the same rule inferred from 16.
- The held-out arm is the same 50 inputs at every sample level (core / boundary /
  adversarial = 20 / 15 / 15).
- 3 tasks × 4 levels = 12 model calls per run.

The naive implementation of each task lands in the 32–36% range on held-out, **by
design**: that floor is the point. Naive is the stand-in for "learned the examples
instead of the rule", and the band gates the calibration. See
[`calibration.md`](calibration.md) section 2 for the cell matrix and the
re-derivation command.

### Level 8 is byte-identical to suite 0.x.x

The level-8 prompt is the same bytes as the 8-shown-example prompt shipped under
suite 0.x.x. Old SEE scores that were recorded under the level-8 prompt are still
comparable to a new level-8 run. Levels 2, 4 and 16 are NEW prompt slots at suite
1.0.0; their digests are pinned in `src/prompt-digests.mjs`
(`SEE_LEVEL_DIGESTS`).

### The Generalization Index (GZ): reported, not scored, in points

Per level, `GZ_level = (seen pass rate − held-out pass rate) × 100`. The adjusted formula
folds the four per-level GZ values into one `gzMean` (unweighted mean of the four
per-level GZ values). A model that memorises the shown arm but loses on held-out scores
high seen and low held-out, net positive GZ — that is the **surface-fit** signal the
GZ exists to detect.

A low GZ is evidence of generalization, **not proof of abstraction**: a heuristic
fitted to one distribution would score the same. Two models can share a score and sit
at opposite ends of this scale, which is why it is reported next to the score and never
merged into it.

## Monkey Do (deduction, out of 50)

The model writes one function `solve(start, target)` that returns a derivation from
`start` to `target` as an array of `{rule, start, next}` steps. The derivation is
scored per chain, against the published chain pool.

**The formal system.** Five rewrite rules over seven symbols `{A, B, C, D, X, Y, Z}`,
stated verbatim in the prompt:

| Rule | Trigger | Rewrite |
|---|---|---|
| R1 | substring "AB" anywhere | replace with "BA" (length-preserving) |
| R2 | substring "CD" anywhere | replace with "DC" (length-preserving) |
| R3 | substring "YZ" anywhere | replace with "ZY" (length-preserving) |
| R4 | substring "X" anywhere | insert "Y" immediately after (length + 1) |
| R5 | substring "A" anywhere | insert "B" immediately before (length + 1) |

**The chain pool.** 50 chains, deterministic from seed `0xC0FFEE`. Five bands of 10
chains each: L5, L10, L20, L30, L50. The band index is the chain length in steps;
the L50 band holds the longest derivations.

**Scoring.** Per chain:

- **fullCredit**: every submitted step is a legal application of its stated rule AND the
  final state equals the target. 1 point.
- **partial**: at least one step was legal but the chain did not reach the target.
  `chainScore = correctSteps / submittedSteps` (in [0, 1]).
- **empty**: 0 steps submitted. 0 points.

A chain's band contribution is `chainScore`, and a band's score is the mean
chainScore across its 10 chains. Each band is worth up to 10 points (5 bands × 10 = 50).

A reference solver that derives every chain scores **50/50**. The published pool is
byte-identical under `npm run check-pool`, and `npm run self-test` exercises the
reference solver via the same path a real model call would take.

### The chain-engagement clawback: reported, not scored, in [0, 1]

`chainEngagementRate` is the fraction of the 50 chains where the model made at least
one legal step (`fullCredit || partial`). A submission that emits `[]` on every chain
scores 0 DO with engagement 0 — exactly the "free points earned by doing nothing"
condition the adjusted formula targets. See [`calibration.md`](calibration.md)
section 5 for the empty-array baseline measurement.

### Random-walk baseline is non-zero — by construction

A "random" solver that picks uniformly among `allApplicable(state)` at every step for
20 steps scores **50/50** on every chain, because every random pick is a legal move
and the scoring function only checks step legality, not target attainment. The
fullCredit rate is the right random baseline: in the measured run, 5/50 chains (10%)
whose 20 random moves happened to terminate on the target. **A fullCredit count on
a random walk means "the walk happened to terminate on the target within its
step budget", not "the walk solved chains"; the walk had no goal-seeking
behavior, these are hits by chance.** Legal-step compliance is not goal
attainment; the fullCredit rate is the only signal that distinguishes a random
walk from a goal-seeking derivation. See [`calibration.md`](calibration.md)
section 4 for the per-band histogram. Re-derive with
`node scripts/do-random-audit.mjs`.

### The reference solver in two modes (load-bearing distinction)

The reference solver is the BFS forward-chainer. Two distinct modes:

| Mode | Score | Description |
|---|---|---|
| **Dry-run** (sandbox-compiled reference, recorded derivation threaded) | **50/50** | The harness passes the chain's recorded `c.steps` as the third argument to `solve(start, target, reference)`. The solver emits the recorded derivation verbatim. Used by `npm run self-test`, `npm run dry-run`, and the chain pool's `verifyReplay`. |
| **Real-mode** (sandbox-compiled reference, BFS from scratch) | **45/50** | The harness calls `solve(start, target)` with `undefined` as the third argument. The solver runs BFS from scratch. Used by every model call scoring a real submission. Per-band: L5/L10/L20/L30 = 10/10 each, L50 = 5/10 (5 chains' shortest derivation exceeds `MAX_STATES=50000`). |

End-to-end tests that wire `REFERENCE_SOLVER_SOURCE` through the model path expect
saturation: real-mode is 45/50, dry-run is 50/50. Asserting 50/50 on the model path
tests the dry-run gate, not the model path.

### Per-chain outcomes

`fullCredit`, `partial`, `protocol_violation`, `no_response`. The chain pool's
chain-level details (length, band, recorded steps, expected target) are in the per-eval
report.

### When the model never answers

Any model must produce a report, including one whose endpoint stalls or errors. A call that
times out, returns a non-JSON body, or fails on the network is caught and scored as
`no_response` on every chain, so the report is still written. The budget is enforced, never
removed; a hung request still fails, just at whatever `timeoutMs` that model declares rather than
a single global ceiling.

A `no_response` run scores **0/50**, and `callFailure.do` in the combined report gives the reason:
`timeout`, `rate_limited`, `auth_failed`, `http_<status>`, `network_error`,
`non_json_response`, or `provider_error`. A `timeout` also carries `timeoutMs` and `attempts`,
so the report says how long it waited and that it did not try again.

**A 0 beside `callFailure` is not a measurement of the model.** It is the score of a
call that never returned, and it says something about the endpoint, the provider, or the
budget, not about reasoning. Check the field before quoting the number. Reasoning models
that spend the whole budget emitting reasoning tokens and never emit an answer land here,
which is a real and common failure rather than a harness fault.

## The adjusted total: the one number to plot

`SEE + DO` is out of 100 and already maxes out, so the two reported axes have
nowhere to go. The adjusted total folds both in. **It is a reporting layer only**:
SEE, DO, both axes and their components are all unchanged on every report, and the
reference solver still scores 100. The formula was bumped from suite 1.0.0 to
suite 1.1.0; the earned-fraction scaling (see below) is what changed; the
1.0.0 readings are still preserved on every report as evidence under
`adjusted.total`.

```
adjusted = clamp( SEE + DO  −  0.5 × GZ_mean × ((SEE + DO) / 100)
                   −  10 × (1 − chainEngagementRate),  0, 100 )
```

The two adjustments point in **opposite directions**, which is why they are not
one formula:

- A high **GZ_mean inflates** a score. Memorising the shown examples looks like
  competence and collects held-out points it has not earned, so it is
  **subtracted**. Under 1.1.0 the subtraction is scaled by `(SEE + DO) / 100`:
  a model can only lose surface-fit points out of the points it actually
  earned. A model with base 50 can lose at most half the GZ penalty; a
  model with base 20 can lose at most a fifth. The shield cannot exceed
  the wound.
- A low **chainEngagementRate** inflates nothing; it means a solver did nothing
  on some chains. The empty-array submission scores 0 DO directly; the
  clawback fires on the adjusted figure so an empty solver never earns
  the SEE-side 50 points as a free ride. The clawback is FIXED at
  `10 × (1 − engagement)` — the sword cannot pity the weak.

Worked examples (suite 1.1.0 readings; the qwen shape is real data):

```
Empty submission (SEE 50, DO 0, GZ 0, eng 0):
  earned = 0.5 → GZ penalty scaled by 0.5
  raw = 50 − 0.5 × 0 × 0.5 − 10 × (1 − 0) = 50 − 0 − 10 = 40
  total = 40/100  (the SEE-side 50 are real, the model never made a
  legal chain move; the clawback fires)
```

```
qwen2.5-coder:7b, -r 3 (SEE 19, DO 1, GZ 26.7, eng 0.04):
  earned = 20 / 100 = 0.2
  raw = 20 − 0.5 × 26.7 × 0.2 − 10 × (1 − 0.04)
      = 20 − 2.67 − 9.6 = 7.73
  total = 8/100  (the floor-saturation fix: under 1.0.0 this resolved
  to 0, with the GZ penalty at 13.35 exceeding the model's base)
```

```
Perfect run (SEE 50, DO 50, GZ 0, eng 1):
  earned = 1.0
  raw = 100 − 0.5 × 0 × 1.0 − 10 × (1 − 1) = 100 − 0 − 0 = 100
  total = 100/100  (round-trip; the clamp is the load-bearing invariant)
```

The weights are hand-chosen, and this project freezes hand-chosen weights for a reason.
See [`calibration.md`](calibration.md) section 9. They live in
`src/adjusted.mjs` rather than buried in a formula so a reader can disagree with
them. The adjusted total is a **derived figure**: never quote it without the
components it came from.
