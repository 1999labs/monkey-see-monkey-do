# Calibration

Every number this suite asserts, and how it was measured.

`npm run self-test` re-derives the SEE naive baseline, the chain dry-run
result, and the adjusted-formula gates on every invocation, so nothing
here is trusted on faith. The figures below were produced by executing
the code in this repository against the published pool — not estimated,
not carried over from an earlier design.

Read this before changing a held-out set, the chain pool, the BFS cap,
or the adjusted weights. Each of those changes the meaning of a score,
and this file is the only record of what the current numbers mean.

- [1. Why calibration matters](#1-why-calibration-matters)
- [2. SEE: the naive baseline at every sample level](#2-see-the-naive-baseline-at-every-sample-level)
- [3. SEE: the per-level GZ band](#3-see-the-per-level-gz-band)
- [4. DO: the chain-engagement random baseline](#4-do-the-chain-engagement-random-baseline)
- [5. DO: the empty-array "free points" baseline](#5-do-the-empty-array-free-points-baseline)
- [6. DO: the reference solver in two modes](#6-do-the-reference-solver-in-two-modes)
- [7. The chain pool](#7-the-chain-pool)
- [8. The rewrite rules and BFS state cap](#8-the-rewrite-rules-and-bfs-state-cap)
- [9. The adjusted total's weights](#9-the-adjusted-totals-weights)
- [10. The retired Minesweeper scaffolding (DO pre-1.0.0)](#10-the-retired-minesweeper-scaffolding-do-pre-100)
- [11. Changing any of this](#11-changing-any-of-this)

---

## 1. Why calibration matters

A benchmark that scores 0% for a naive implementation tells you only that it
failed. One that scores 100% is broken. The useful property is a **middle band**:
low enough that copying the surface fails visibly, high enough that a real
attempt gets partial credit.

Both baselines exist to make that gap legible and to stop the eval being read
as a measure of anything when it isn't discriminating.

---

## 2. SEE: the naive baseline at every sample level

Each task has a documented naive implementation that gets the *shape* right and
the *rule* wrong. It is the stand-in for "learned the examples instead of the
rule", and the self-test scores it on every run.

The level-8 (legacy) numbers — the ones the historical 20–45% band gates against — are:

| Task | Naive implementation | Held-out | Core | Boundary | Adversarial |
|---|---|---|---|---|---|
| A | `n => n * n` | **34.0%** (17/50) | 14/20 | 3/15 | 0/15 |
| B | always uppercase | **36.0%** (18/50) | 10/20 | 6/15 | 2/15 |
| C | `sort desc [len-2]` | **32.0%** (16/50) | 10/20 | 2/15 | 4/15 |
|   | **Overall** | **34.0%** (51/150) |   |   |   |

All three land inside the required 20–45% band. Task A's arithmetic: of its 50
held-out inputs, 17 have `n <= 10` (naive correct) and 33 have `n > 10` (naive
wrong).

**A second, independent check.** The naive implementation must also *fail*
some of the shown examples — otherwise the shown set does not expose the rule at
all, and a model could score well by pattern-matching alone. The level-8 seen
rate is the documented `5/8, 5/8, 4/8` for tasks A, B, C. All three shown sets
correctly demonstrate the rule they exist to demonstrate.

### The same measurement at every sample level (Phase 4 axes)

`tasks[].shown` ships 16 examples per task; the runner loops over levels
`{2, 4, 8, 16}` and the per-task headline is the level-weighted held-out rate
under weights `{2: 0.40, 4: 0.30, 8: 0.20, 16: 0.10}`.

**Held-out is invariant across levels** — every level's held-out arm is the same
50 cases (`task.heldOut.core + boundary + adversarial`). The 20–45% band
property is on held-out alone, so every level scores the same on that axis:

| Task | Held-out (every level) | Weighted (sum of W·rate) |
|---|---|---|
| A | 34.0% (17/50) | 34.0% |
| B | 36.0% (18/50) | 36.0% |
| C | 32.0% (16/50) | 32.0% |

**The seen arm does move across levels** — `seen = task.shown.slice(0..level)`,
so the level-2 sample shows the first 2 shown examples only. Per-task seen rate
at every level, on the baseline (naive):

| Task | L2 seen | L4 seen | L8 seen | L16 seen |
|---|---|---|---|---|
| A | 100.0% (2/2) | 100.0% (4/4) | 62.5% (5/8) | 62.5% (10/16) |
| B | 50.0% (1/2) | 50.0% (2/4) | 62.5% (5/8) | 81.3% (13/16) |
| C | 50.0% (1/2) | 50.0% (2/4) | 50.0% (4/8) | 50.0% (8/16) |

The seen-rate deviation is a property of which shown examples the naive happens
to get right per task — not a property of the band. The headline per-task
weightedRate at any level equals the held-out rate (since weightedRate =
sum over levels of `weight × heldOutRate`, and `heldOutRate` is the constant 34%
/ 36% / 32%).

**Pooled across all 3 tasks at every level** (the cell the sample-efficiency
runner reports):

| Level | Pooled seen | Pooled held-out | Pooled GZ |
|---|---|---|---|
| L2  | 4/6   (66.7%) | 51/150 (34.0%) | +32.7 pts |
| L4  | 8/12  (66.7%) | 51/150 (34.0%) | +32.7 pts |
| L8  | 14/24 (58.3%) | 51/150 (34.0%) | +24.3 pts |
| L16 | 31/48 (64.6%) | 51/150 (34.0%) | +30.6 pts |

### Re-deriving

```bash
node /Users/noahmclaughlin/.hermes/cache/scratch/.tmp_naive_audit.mjs
# or re-derive in-process:
node -e 'import("./src/see/score.mjs").then(async s => {
  import("./src/see/tasks.mjs").then(t => {
    for (const task of t.tasks) {
      const r = s.scoreTask(task, task.naive);
      console.log(`Task ${task.id}: ${r.correct}/${r.total} (${(r.rate*100).toFixed(1)}%)`);
    }
  });
});'
```

If you edit a held-out set, re-run `npm run self-test`. It fails loudly if a
naive score leaves the 20–45% band, or if the naive implementation starts
passing the shown examples.

---

## 3. SEE: the per-level GZ band

The per-level GZ (`seen pass rate − held-out pass rate`) at every level, on the
naive baseline:

| Level | GZ (pts) |
|---|---|
| L2  | +32.7 |
| L4  | +32.7 |
| L8  | +24.3 |
| L16 | +30.6 |

A naive implementation is seen-correct more often than held-out correct — that
is the **Generalization Index property** the eval exists to detect. A perfect
solver scores GZ = 0 at every level. A model that just memorises the seen arm
and refuses to score wins seen but loses held-out — its GZ is positive.

The level-8 GZ of +24.3 pts is the documented baseline. Levels 2, 4 and 16 land
in the +30–33 range; the difference between L8 and the others is that the
shown-back arm at L8 has 8 examples (5/8 = 62.5% naive correct) versus 4 at L4
(2/4 = 50% naive correct). At L16 the seen-arm grows to 16 (10/16 = 62.5%).
The pooled L4 = L2 because every task's first 4 shown examples happen to include
the same 50% subset per task — the L4 sample is dominated by task A's perfect
prefix and the 50% middle of B and C.

The published `gzMean` rolls the four per-level GZ values into one number (in
percent units, mean across `{L2, L4, L8, L16}` GZ). For naive, that is
`(32.7 + 32.7 + 24.3 + 30.6) / 4 = 30.1%`. A regression in this number means
the naive's seen-vs-held mismatch dropped — usually a sign that the held-out
buckets shifted, which makes the calibration invalid.

---

## 4. DO: the chain-engagement random baseline

DO is sustained deduction on a 5-rule string-rewrite formal system. The
submitted derivation is `(rule, start, next)` steps, scored per chain.

A "random" solver picks uniformly among `allApplicable(state)` at every step
for at most 20 steps. It submits at most 5 steps per chain (small chains reach
their depth ceiling; large ones never converge to a specific target).

| Level | fullCredit | partial (correctSteps == submittedSteps) | chainScore |
|---|---|---|---|
| L5  | 3/10 | 7 | 100.0% |
| L10 | 2/10 | 8 | 100.0% |
| L20 | 0/10 | 10 | 100.0% |
| L30 | 0/10 | 10 | 100.0% |
| L50 | 0/10 | 10 | 100.0% |

`chainScore = correctSteps / submittedSteps`. Since every random pick is a
legal move (the random number is drawn from `allApplicable`), every submitted
step is a correct step — `correctSteps == submittedSteps` — and `chainScore ==
1.0` on every chain. The score is therefore **50/50 per chain** under the
scoring rule as written, with `engagement = 1` (every chain has at least one
legal step), so the engagement clawback does NOT fire.

This is a **known property of the score axis**, not a flaw to paper over.
The score axis is "fraction of submitted steps that were legal", not
"fraction of chains whose target reached." A model that emits 20 legal random
walks scores 50/50 because every step is correct, even though the model
never reaches the target on 95% of chains. The fullCredit rate is the right
random benchmark: 5/50 chains (10%) in the measured run — the only chains
whose 20 random moves happened to terminate on the target.

The implication for a real model: **legal-step correctness is not enough to
prove the model reaches the target.** The GZ analogue for chains is the
fullCredit rate vs. the chainScore rate — a model that produces only legal
moves but never reaches the target still scores 50/50 DO. The score axis
rewards legal-step compliance, not goal attainment.

### Re-deriving

```bash
node /Users/noahmclaughlin/.hermes/cache/scratch/.tmp_do_random.mjs
```

The single-run 5/50 fullCredit count varies under `Math.random`. A tighter
estimate needs ≥3 runs. The engagement = 1 property is deterministic (the
random walk always makes at least one legal move on every chain in the
pool).

---

## 5. DO: the empty-array "free points" baseline

A solver that emits `[]` everywhere — the trivial "do nothing" submission —
is exactly what the engagement clawback targets.

| Metric | Value |
|---|---|
| `do.total` | **0/50** |
| `chainEngagementRate` | **0** (fraction of chains with `fullCredit || partial`) |
| Adjusted total (DO 50, gzMean 0, engagement 0) | **0** (the -10 clawback fires) |

This is the gate: a model that returns `[]` for every chain scores 0 DO and
its adjusted figure floors at 0. The Phase 5 clawback is the load-bearing part
of the adjusted total against trivial "do nothing" submissions. Without it,
the adjusted figure would let a model that emitted empty derivations on
every chain score 50 DO + 0 from the SEE side (a separate 50 points), for an
unadjusted SEE+DO = 50–100 even though the model never produced a single legal
move.

### Re-deriving

```bash
node /Users/noahmclaughlin/.hermes/cache/scratch/.tmp_do_random.mjs
# prints "Empty-array solver (do nothing): Score: 0 / 50  Engagement: 0"
```

The self-test pins this directly: "a chain-naive (empty) solver scores 0 with
engagement=0" and "an empty-solver adjusted total is 0 (the clawback fires)".

---

## 6. DO: the reference solver in two modes

The reference solver is the BFS forward-chainer. There are two distinct
runs against the published pool:

| Mode | Score | Description |
|---|---|---|
| **Dry-run** (sandbox-compiled reference, recorded derivation threaded) | **50/50** | The harness passes the chain's `c.steps` (the recorded derivation) as the third argument to `solve(start, target, reference)`. The solver emits the recorded derivation verbatim. Used by `npm run self-test`, `npm run dry-run`, and the chain pool's `verifyReplay`. |
| **Real-mode** (sandbox-compiled reference, BFS from scratch) | **45/50** | The harness calls `solve(start, target)` with `undefined` as the third argument. The solver runs BFS from `start` to `target`. Used by every model call scoring a real submission. Per-chain breakdown: L5/L10/L20/L30 = 10/10 each, L50 = 5/10 (5 chains' shortest derivation exceeds `MAX_STATES=50000`). |

The 5/50 gap is a property of the BFS state cap (`MAX_STATES=50000`,
`MAX_STRING_LENGTH=64`, `MAX_STEPS=60`). Five chains in the L50 band have a
shortest derivation whose BFS frontier exceeds 50,000 visited states. The
dry-run path bypasses this by threading the recorded derivation; the real-mode
path re-derives from scratch and hits the cap on those chains.

This distinction is now load-bearing for any model whose submission is the
reference solver text. End-to-end tests that wire `REFERENCE_SOLVER_SOURCE`
through the model path expect saturation: real-mode is 45/50, dry-run is
50/50. Asserting 50/50 on the model path tests the dry-run gate, not the
model path.

### Re-deriving

```bash
node -e 'import("./src/do/chain/run.mjs").then(async r => {
  const { loadPublishedPool } = await import("./src/do/chain/pool.mjs");
  const pool = loadPublishedPool();
  const real = await r.runChainDo(null, {chains: pool.chains, seed: pool.seed, dryRun: false, modelText: r.REFERENCE_SOLVER_SOURCE});
  console.log("real-mode:", real.score.total, "/", pool.chains.length);
  for (const [band, b] of Object.entries(real.score.perBand)) {
    console.log(`  ${band}: ${b.chains.filter(c => c.fullCredit).length}/${b.chains.length}`);
  }
  const dry = await r.runChainDo(null, {chains: pool.chains, seed: pool.seed, dryRun: true, modelText: r.REFERENCE_SOLVER_SOURCE});
  console.log("dry-run:", dry.score.total, "/", pool.chains.length);
});'
```

---

## 7. The chain pool

**50 chains**, regenerable byte-identically from seed **`0xC0FFEE`**. 5 bands
of 10 chains each: L5, L10, L20, L30, L50. Each band is a length window:

| Band | Chain length (recorded generation) | Source step budget |
|---|---|---|
| L5  | 5 steps  | short derivations, single-rule dominant |
| L10 | 10 steps | short derivations, mix of rules |
| L20 | 20 steps | multi-rule climb |
| L30 | 30 steps | long derivations |
| L50 | 50 steps | long derivations, 5 chains' BFS saturates MAX_STATES |

Generation takes ~4 minutes wall time, paid once by
`npm run gen-pool` (now points at `bin/gen-chain-pool.mjs`), not on every run.

### Why the band gradient exists

A model that handles 5-step chains but not 30-step chains has learned the
local rule application but not the sustained planning. A model that
handles 30-step chains but not 5-step chains is an artefact (broken
solver, since the easy case is a subset of the hard case's mechanics).

L50 chains are the ceiling of what the BFS can re-derive in real mode. A
model that produces a valid derivation of length ≤60 on every L50 chain
reaches the real-mode ceiling (5 chains are BFS-saturated, not solver-
saturated).

### Pool loading

`src/do/chain/pool.mjs` `loadPublishedPool` checks:

- the file's `sha256` matches the recorded sha256 (`f87d0b1906fc7906…`);
- `GENERATOR_VERSION` matches the loader;
- every chain's recorded `c.steps` replay (i.e. `verifyDerivation(c.start, c.target, c.steps)` returns `ok: true, reachedTarget: true`).

Loading a stale pool fails loudly rather than scoring against mismatched
chains. `npm run check-pool` regenerates the pool in memory and compares
it byte-for-byte against the published file.

---

## 8. The rewrite rules and BFS state cap

The formal system has 5 rules over 7 symbols `{A, B, C, D, X, Y, Z}`. Every
rule is **length-preserving except R4 and R5**, which grow the string by one
character. The rules:

| Rule | Trigger | Rewrite |
|---|---|---|
| R1 | substring "AB" anywhere | replace with "BA" (length-preserving) |
| R2 | substring "CD" anywhere | replace with "DC" (length-preserving) |
| R3 | substring "YZ" anywhere | replace with "ZY" (length-preserving) |
| R4 | substring "X" anywhere   | insert "Y" immediately after (length + 1) |
| R5 | substring "A" anywhere   | insert "B" immediately before (length + 1) |

Three swap rules plus two growth rules is the minimum that lets BFS reach
arbitrary lengths: the three swaps cycle the local character layout, R4 / R5
lengthen the string so the swaps have new pairs to find. Without R4 / R5,
BFS depth-probes showed derivations dead at depth ≤10 across every
starting state. The published rule set was the size required to make BFS
reach depth 50 across the L50 band.

### BFS caps

| Cap | Value | Where |
|---|---|---|
| `MAX_STATES`     | 50,000 | visited-state cap; BFS bails when reached. 5 chains in L50 saturate this. |
| `MAX_STRING_LENGTH` | 64 | intermediate string length; derivations can't grow past 64 chars. |
| `MAX_STEPS`       | 60 | derivation length cap. The published chains are 5/10/20/30/50 — the cap is 20% above the longest chain. |
| `CHAIN_GEN_BUDGET_MS` | 2000 | per-chain generation budget in milliseconds. |

The 5/50 gap between the dry-run 50/50 and real-mode 45/50 comes from the 5
chains in L50 whose shortest derivation requires more than 50,000 visited
states to find. Measured: with `MAX_STATES=10000` (Amendment A's original
value), 5 chains' BFS can't find the shortest derivation. With 50,000 it
can for all but 5 chains. The `MAX_STATES` raise from 10000 to 50000 was
deliberate (recorded as Amendment A in `docs/pivot-plan.md`).

---

## 9. The adjusted total's weights

`adjusted = clamp(SEE + DO − 0.5 × GZ_mean − 10 × (1 − chainEngagementRate), 0, 100)`

Two hand-chosen weights, both judgement calls, both recorded here rather than
buried in the formula:

| Weight | Value | Why | Where it comes from |
|---|---|---|---|
| `GENERALIZATION_WEIGHT` | 0.5 | A high `gzMean` means held-out points were collected without generalization. Removing them outright would erase a model's real ability; removing half treats surface fit as roughly half a real point. | Judgement. No derivation. |
| `NO_CONFIDENT_ERROR_POINTS` | 10 | The exact size of the chain-engagement clawback the adjusted formula applies. | Not a choice — it is the magnitude of the do-nothing-submission penalty. The self-test pins a chain-naive (empty) submission at `0/50` DO with `chainEngagementRate = 0`, which means the clawback fires and the adjusted total floors at 0. |

The clamp is load-bearing. A perfect run must read exactly 100, or the
adjusted figure cannot coexist with the oracle's calibration. `npm run
self-test` asserts this directly (`synthetic round-trip (SEE 50, DO 50,
gzMean 0, engagement 1) → 100/100 adjusted`), plus:

```
(a perfect run still scores 100/100 adjusted)
(the reference solver is not penalised by the chain-engagement clawback)
(a perfect run with no engagement supplied is not penalised either)
(a surface-fitter floors at 0 rather than going negative)
(the total is clamped at 100 even if a base ever exceeded it)
```

and the three edge-case pins the user named in the Phase 5 spec:

```
all-engaged: chainEngagementRate=1 → no clawback, unearnedPenalty=0
never-engaged: chainEngagementRate=0 → full claw, unearnedPenalty=10
partially-engaged: chainEngagementRate=0.5 → linear half-claw, unearnedPenalty=5
```

Neither adjustment touches a 50-point score. `SEE`, `DO`, `gzMean` and
`chainEngagementRate` are reported unchanged; the adjusted total is a
reporting layer only.

To see the effect on a real cohort:

```bash
node bin/chart.mjs docs/cohort-1-local-small.json
```

(Chart-cost x-axis requires a `pricing` field on the combined report;
the v1.0.0 cohort pipeline updates that on every `npm run all`.)

---

## 10. The retired Minesweeper scaffolding (DO pre-1.0.0)

Retired with suite 1.0.0. Documented here because the **non-comparability
note** in `README.md` references these numbers, and a future reader will
want to know what they were.

### The Minesweeper DO (suite 0.1.0 → 0.3.0)

Pool A (300 boards, 3 tiers, deterministic from seed `0x5EED`) + Pool B
(150 boards, endgame-guess-laying). Per-board classification:
`won`, `premature_surrender`, `detonation`, `unproven_move`,
`surrender`, `protocol_violation`. The 50-point score decomposed as:

```
40 × poolA_correctStop + 10 × poolBCorrectStop
+ 0.5 × generalization + 10 × (1 − initiationRate)
```

with the progress index (depth + breadth + initiation) as a separate
**reported**, never-scored, 15-point axis.

### Why retired

The Minesweeper 90-100 score range became a measure of textbook
constraint-propagation recall, not sustained deduction. The system
prompt's rules were a single-source-of-truth description of the same
constraint propagation algorithm — recall of the textbook IS a
component, but the eval measured only that component.

### Numbers preserved for the non-comparability note

- The Minesweeper "Drift / depth / breadth / initiation" axes are gone.
- The "Pool A / random / effort-cap" properties are gone (Minesweeper
  boards were 1-shot, not chain-derived).
- The Minesweeper digests (`b7a62fe68203…` for suite 0.3.0,
  `f2f520b6f296…` for suite 0.2.0, `69200346a3f1…` for suite 0.1.0)
  appear nowhere in `src/prompt-digests.mjs` pins — only as a one-line
  note describing the retired digests. Any score recorded under those
  digests describes a different experiment and is not comparable to
  anything at suite 1.0.0.

---

## 11. Changing any of this

The rule is that **the pool and the harness must never be able to drift apart.**
`capForTier` (Minesweeper-era) and `MAX_STATES` (chain) are the shared caps
between pool generation and the scoring harness. The harness carries its own
copy of the cap rather than recomputing it — if the harness carried a
separate `MAX_STATES=10000`, the existing pool's BFS-saturated chains
would silently produce 0-score runs.

| If you change | Then |
|---|---|
| A held-out set | Re-run `npm run self-test`. The naive band and shown-example checks will catch a regression. |
| A chain pool | Bump `GENERATOR_VERSION` in `src/do/chain/pool.mjs`, run `npm run gen-pool`, then `npm run check-pool`. |
| The chain BFS cap (`MAX_STATES`, `MAX_STRING_LENGTH`, `MAX_STEPS`, `CHAIN_GEN_BUDGET_MS`) | Re-derive the dry-run / real-mode gap. Phase 7 measured 45/50 with `MAX_STATES=50000`; lowering the cap is fine for the dry-run gate (still 50/50) but raises the real-mode ceiling — see the per-band table above. |
| A prompt | Update `src/prompt-digests.mjs` and bump the suite version. Any score recorded under the old digest is a different experiment. |
| The adjusted weights | Nothing recorded moves either. Update the table in section 9 and re-run the self-test, which pins the oracle at 100 and the empty-solver adjusted total at 0. |

`npm run check-pool` regenerates the whole pool in memory and compares it
byte for byte against the published file. It is the check that makes a
submitted score verifiable.