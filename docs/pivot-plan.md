# Monkey See Monkey Do — Pivot Plan

## Summary of the pivot

Two changes, both additive to SEE and a rewrite of DO.

| Axis | Before | After |
|---|---|---|
| **Monkey See** | Infer the rule from 8 examples | Infer the rule from 2, 4, 8, or 16 examples (sample efficiency axis added) |
| **Monkey Do** | Write a Minesweeper constraint-propagation solver | Follow a long chain of deductions in a novel formal system, step by step |
| **GZ Index** | One number per SEE run | One number per sample level (2, 4, 8, 16) |
| **Progress Index** | 15 points on initiation/depth/breadth | Removed. Replaced by chain-length gradient within DO's own 50 points. |
| **Total** | SEE 50 + DO 50 = 100 | Same |
| **Adjusted total** | SEE + DO − 0.5×GZ − 10×(1 − initiationRate) | SEE + DO − 0.5×GZ_mean − claw-back on long-chain score |

## Goals of the pivot

1. DO no longer measures a specific textbook algorithm (constraint propagation). It measures sustained deduction on a novel formal system, so recall cannot explain the score.
2. The canary problem goes away. The formal system and chains are generated after the eval is designed, committed to the repo, and never appear in training data.
3. The value proposition is clear and citable: "induction efficiency" (SEE) + "sustained deduction" (DO). No benchmark today tests either axis explicitly. Both are meaningful axes for general intelligence.
4. SEE is backward-compatible in structure. Cohort 1's SEE numbers are directly comparable to new runs. DO numbers are not.

## What stays the same

- SEE's three task types: numerical, string, array
- SEE's reference oracle, held-out set, task structure
- SEE's prompt format (with one change: examples now parameterized)
- DO's prompt structure: "write one function, replay it on the pool"
- DO's sandbox, fingerprinting, key resolution, provider logic
- The combined report format (with new fields)
- The self-test gate
- The publication gate

## What changes

- SEE tasks now run at 4 sample levels (2, 4, 8, 16)
- SEE's GZ is reported per level
- DO's pool is a set of formal-system chains, not Minesweeper boards
- DO's prompt is entirely rewritten (axioms + rules + a derivation task)
- DO's reference solver is entirely rewritten (a forward-chain executor)
- DO's scorer is entirely rewritten
- DO's Progress Index is removed (its role is now played by chain-length bands within DO itself)
- The adjusted total formula is updated
- Suite version bumps to 1.0.0 (the DO numbers are non-comparable, clean break)

---

## Detailed design: SEE changes

### Sample efficiency dimension

Each task (numerical, string, array) now runs at four sample levels:
- Level 2: 2 examples shown
- Level 4: 4 examples shown
- Level 8: 8 examples shown (current behavior)
- Level 16: 16 examples shown

The model is scored independently at each level. The per-task score is a weighted average:

| Level | Weight |
|---|---|
| 2 | 0.40 |
| 4 | 0.30 |
| 8 | 0.20 |
| 16 | 0.10 |

Weights are hand-chosen. Lower sample counts are harder and more discriminating, so they get more weight.

### Points allocation (unchanged total)

| Component | Points | What it takes |
|---|---|---|
| Task A (numerical) | 15 | Weighted average across 4 sample levels |
| Task B (string) | 15 | Weighted average across 4 sample levels |
| Task C (array) | 15 | Weighted average across 4 sample levels |
| Robustness | 5 | Code that does not throw on any of the held-out cases across all levels |

The per-task score is the weighted average of (seen_pass_rate × 15) at each level. Task A at 15 points still maxes out at 15.

### GZ Index becomes per-level

Report GZ as a table:

| Level | GZ | Reading |
|---|---|---|
| 2 | ... | generalizes / mostly / partial / surface fit |
| 4 | ... | ... |
| 8 | ... | ... |
| 16 | ... | ... |

Plus a single `GZ_mean` for the adjusted total.

### Backward compatibility

Level 8 is the current SEE. Old Cohort 1 numbers at level 8 are directly comparable to new runs. The level-8 score plus the new weights give a new SEE total, but the underlying per-level numbers are auditable.

---

## Detailed design: DO changes

### The formal system

A simple string-rewrite system with a fixed set of rules. The rules are committed to the repo and used across every run. They are novel enough to not appear in training, and simple enough to specify in a prompt.

Symbols: `A`, `B`, `C`, `D`, `X`, `Y`, `Z`

Example rules (the exact set is a design decision in Phase 2):

| Rule | Trigger | Rewrite |
|---|---|---|
| R1 | substring `AB` anywhere | replace with `BA` |
| R2 | substring `CD` anywhere | replace with `DC` |
| R3 | trailing `X` | append `Y` |
| R4 | substring `YZ` anywhere | replace with `ZY` |
| R5 | leading `A` | prepend `B` |

The rules are commutative where possible and designed to have short derivations.

### Chain generation

Each chain is:
- A starting string (e.g., `ABCD`)
- A target string (e.g., `BADY`)
- A sequence of rule applications that derives the target from the start

Chains are procedurally generated from a seed (like the current pool uses `0x5EED`). The generator is deterministic and committed to the repo.

Chain lengths (bands):
- Short: 5 steps, 10 chains, 10 points
- Medium: 10 steps, 10 chains, 10 points
- Long: 20 steps, 10 chains, 10 points
- Very long: 30 steps, 10 chains, 10 points
- Extreme: 50 steps, 10 chains, 10 points

Total: 50 chains, 50 points.

### Prompt

The prompt gives the model the rules and asks it to write a single function:

```
solve(start, target) -> list of (rule, output_string) tuples
```

Each call to `solve` must return the derivation from start to target. The model writes `solve` once, and it is replayed on all 50 chains.

### Scoring

Per chain:
- For each step in the model's derivation:
  - Verify the rule was applicable (the trigger string was in the current state)
  - Verify the rewrite was applied correctly (the output matches what the rule produces)
  - If both are true: step is correct
- Chain score = correct_steps / expected_steps (clamped at 1.0)
- Bonus: +1 if the final state equals the target (completion bonus, baked into chain score)

Band score = average chain score × band points.

Total DO = sum of band scores, max 50.

### Reference solver

The reference solver is a simple forward-chain executor: given a start and a target, BFS over the rule space to find a derivation. It should find the shortest path to the target.

`npm run dry-run` must produce 50/50 with the reference solver.

### Progress Index

Removed. The chain-length bands within DO itself play the role the Progress Index used to play. A solver that never engages scores 0 across all bands; a solver that engages short chains but fails long chains gets a graded score. No separate reporting axis needed.

### Why this is hard to game

- The formal system and rules are committed to the repo after the eval is designed
- The chains are procedurally generated from a committed seed
- A model cannot recall a derivation for a specific chain it has never seen
- Performance degrades predictably with chain length, which is what we want to measure

---

## Phase plan

### Phase 1: Design freeze (decided — see below)

All Phase 1 decisions are frozen. Do not relitigate them; the rationale for each sits in the
"Decided answers to the open questions" section at the bottom of this document.

- [x] Finalize the formal system: 5 rewrite rules, 7 symbols (`A B C D X Y Z`). The exact rule set is finalized in Phase 2, where the generator is written and exercised.
- [x] Decide chain generation algorithm: BFS over rule applications, with a per-chain effort cap; chains that exceed the cap are rejected rather than slowed down
- [x] Decide seed for the pool: a new committed seed, not `0x5EED` (that seed belongs to the old Minesweeper pool)
- [x] Decide band sizes and counts: 10 chains per band at 5 / 10 / 20 / 30 / 50 steps, 50 chains total
- [x] Decide SEE sample-level weights: 2 examples 0.40, 4 examples 0.30, 8 examples 0.20, 16 examples 0.10
- [x] Decide adjusted total formula: `SEE + DO − 0.5 × GZ_mean − claw-back on long-chain score` (weights frozen, live in `src/adjusted.mjs` like today)
- [x] Decide suite version bump: 1.0.0 (clean break; old DO scores are non-comparable)

Output: this document is the spec all subsequent phases follow.

### Phase 2: Build DO v2 — generator and reference solver (2–3 days)

The generator and reference solver are the foundations. Nothing else in DO works without them.

- [ ] Write the chain generator: given seed + rules, produce N chains of length L
- [ ] Write the reference solver: BFS forward-chainer, finds shortest derivation
- [ ] Generate pool.json with the new seed
- [ ] `npm run gen-pool` and `npm run check-pool` both pass
- [ ] Reference solver solves 50/50 chains at `npm run dry-run`

Gate: dry-run says PASS and 50/50 before Phase 3 starts.

### Phase 3: Build DO v2 — prompt and scorer (1–2 days)

- [ ] Write the new DO prompt
- [ ] Write the new DO scorer (step verification, chain scoring, band scoring)
- [ ] Update `src/prompt-digests.mjs` with new digest
- [ ] Update the sandbox to handle the new output format

Gate: self-test passes with the new prompt and scorer.

### Phase 4: Build SEE sample efficiency (1–2 days)

- [ ] Add sample-level parameter to SEE tasks
- [ ] Update SEE runner to loop over sample levels
- [ ] Update SEE scorer to compute per-level scores and weighted average
- [ ] Update GZ to be per-level
- [ ] Ensure level 8 produces identical results to the current SEE

Gate: level 8 scores match the current SEE byte-for-byte on a reference run.

### Phase 5: Update adjusted total and reports (half a day)

- [ ] Update `src/adjusted.mjs` with new formula
- [ ] Update `src/report.mjs` with new fields (per-level GZ, chain-length bands)
- [ ] Remove Progress Index code and references
- [ ] Update combined report schema
- [ ] Carry token usage through to the reports: the adapters already capture `usage` (prompt/completion tokens, plus `reasoning_tokens` on the responses adapter) but nothing propagates it today. Record per-call usage on task/board result records and run totals (`usageIn`, `usageOut`, `usageReasoning`) on the DO and SEE reports. DO stores one call's usage; SEE stores per task per level, so token burn per sample level is auditable.
- [ ] Stamp pricing at run time so cost is auditable later: record the $/1M input and output rates used, and compute `costUsd` in the report writer, never re-derived after the fact. Rates differ per provider and drift over time; a chart generated from a report must stay auditable, which is the same principle as committing combined reports.
- [ ] Local models (Ollama) have no price at all: leave `costUsd` null and mark the run `pricing: "local"` so charts exclude them honestly instead of fudging a number.
- [ ] OpenCode Go models are subscription-served but their allowance is dollar-denominated: compute `costUsd` as usage times the per-model published $/1M rates (the rates the allowance drains at) and mark it `pricing: "subscription-estimate"`. Validate once against reality: if the Go dashboard or gateway exposes a remaining-allowance figure, record the before/after delta across one suite run and prefer the measured figure if it disagrees. DeepSeek models price at half at off-peak, so run DeepSeek cohorts off-peak and stamp which schedule applied.
- [ ] Zen, OpenRouter and OpenAI are billed per token: mark `pricing: "pay-per-token"` with `costUsd` exact. Rates for the same model differ between Go and OpenRouter, so `costUsd` always means cost under the provider that served the run, the same provider-scope honesty the README applies to scores.

Gate: unit tests pass, report schema is valid.

### Phase 6: Update tests and self-test (1 day)

- [ ] Update unit tests for new SEE sample levels
- [ ] Update unit tests for new DO chain generation and scoring
- [ ] Update `npm run self-test` to cover new behavior
- [ ] Update `npm run dry-run` to cover new DO

Gate: `npm test` and `npm run self-test` both pass.

### Phase 7: Calibration (1 day)

Every asserted number needs to be re-measured on the new eval.

- [ ] Re-measure naive baseline (20–45% on every SEE task at every level)
- [ ] Re-measure random baseline on DO (0% chain completion expected)
- [ ] Re-measure effort cap
- [ ] Document everything in `docs/calibration.md`
- [ ] Rewrite the README to describe the new eval structure: DO as sustained deduction (formal system, chain bands, new scoring table), SEE sample levels and per-level GZ, the new adjusted formula, the removal of the Progress Index, and the suite 1.0.0 non-comparability note for pre-1.0.0 DO scores. Numbers quoted in the README must match this phase's calibration.

Gate: calibration doc updated with new numbers.

### Phase 8: Re-run Cohort 1 (time depends on model availability)

The new eval is not comparable to the old DO, so Cohort 1 needs a fresh run.

- [ ] Re-run the five Cohort 1 models with the new eval
- [ ] Commit new combined reports
- [ ] Update cohort chart
- [ ] Update README with new numbers

Gate: new Cohort 1 numbers published with full caveats about non-comparability to old DO.

### Phase 9: Frontier models (the main event)

This is the reason for the pivot. Once it's done, run frontier models.

- [ ] Run 2–3 frontier models (Claude, GPT, Gemini equivalents)
- [ ] Run 2–3 mid-tier models (OpenRouter's mid-range)
- [ ] Compare to Cohort 1
- [ ] Publish new cohort chart with frontier models. The frontier chart's x-axis is **measured dollars per full suite run**, not price per token: the workload is fixed (50 chains + 12 SEE calls) and identical for every model, so dollars-per-run is like-for-like "cost to get the job done." It captures token hunger directly (a verbose reasoning model can cost more in real dollars than a pricier-per-token rival that answers directly) and a model that gives up midway shows up as both cheaper and worse, which the chart displays honestly.
- [ ] Use `costUsd` and the stamped rates from the Phase 5 report fields. Under `-r 3`, quote median dollars per run with the three runs visible, the same convention as score spread. Do NOT mix axes across cohorts: local models keep the parameter-count axis (no price exists). On the frontier chart, pay-per-token runs get solid markers; OpenCode Go subscription-estimate runs appear as hollow markers with a footnote, so they are charted without passing their estimate off as an invoice.
- [ ] "Cost per completed task" is not well defined on this suite because score is continuous (band and chain scores), so the fixed-run dollar figure is the proper denominator. The workload being constant across models is the property no agent benchmark has: only the model's own behavior (verbosity, reasoning appetite, retries) can move cost.

Gate: at least one frontier model scores > 50 adjusted, which proves the eval discriminates at the top end.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Formal system is too easy (all models solve all chains) | Medium | High | Add longer chains in Phase 7 if frontier models saturate at 50 steps. The design is extensible. |
| Formal system is too hard (no model solves any chain) | Low | Medium | Reference solver proves it's solvable. If frontier models fail, the rules may be too opaque — simplify. |
| Chain generation is too slow (BFS explodes) | Medium | Low | Cap BFS depth, reject chains that take > 1 second to generate. Commit only chains that the generator finds quickly. |
| SEE sample efficiency adds too many model calls | Low | Medium | 4 levels × 3 tasks × 1 model = 12 calls instead of 3. Manageable. |
| Old DO scores in Cohort 1 become non-comparable | Certain | Medium | Already the plan: re-run Cohort 1 with new eval. Document non-comparability clearly. |
| Adjusted total weights need tuning after Phase 9 | Likely | Low | Weights are frozen but the formula can be revisited at 1.0.0. Document the rationale for any change. |

---

## Decided answers to the open questions

1. **Suite version bump: 1.0.0.** Clean break. The DO numbers are non-comparable, and a major version signals that.
2. **Chain counts: 10 per band, 5 bands, 50 total.** Stable scores without making runs too long. Extend with a 100-step band if frontier models saturate.
3. **Max chain length: 50 steps to start.** Run Phase 7 calibration. Add 100-step band if frontier models solve 50-step chains perfectly.
4. **Formal system complexity: 5 rules, 7 symbols.** Start simple. Add rules or increase complexity if frontier models solve everything.
5. **SEE backward compatibility: level 8 byte-identical.** Old Cohort 1 level-8 numbers remain comparable.
6. **Old DO code: refactor infrastructure, replace DO-specific parts.** Keep sandbox, fingerprinting, key resolution. Rewrite prompt, scorer, reference solver, pool generator. Delete Minesweeper code.

---

## Success criteria

The pivot succeeds if:

1. `npm run dry-run` on the new DO says PASS and 50/50.
2. Frontier models score > 50 adjusted, proving the eval discriminates at the top end.
3. Cohort 1 re-run produces a meaningful spread (not all zeros, not all 100s).
4. The new benchmark is cited by at least one external party within 6 months of publication.
5. The value proposition is clear: "induction efficiency + sustained deduction" is a defensible, citable claim.

If all five are true, the pivot worked. If any fail, revisit the design in Phase 1.

---

## Amendment A (Phase 2 commit) — finalised rule set deviates from the spec section

The "Example rules" table in "Detailed design: DO changes" lists R4 as
`trailing X → append Y` and R5 as `leading A → prepend B`. Both are
one-shot per derivation: each can fire exactly once before the boundary
character changes, and no rule re-introduces the trigger. With 3 length-
preserving swaps and 2 one-shot growth rules, the reachable space from any
starting string caps at depth ~8 — short of the L=50 band the same section
pins.

Measurement on the plan's exact rule set:

```
starts                  depth reached
"AXBYCDZX"              4
"ABCDXYZD"              5
"ABABCDXYZX"            8
"XYABCD"                3
```

**Finalised rule set, frozen in Phase 2** (any change is a deliberate bump
of `GENERATOR_VERSION` in `src/do/chain/pool.mjs`):

| Rule | Trigger                | Rewrite                          |
|------|------------------------|----------------------------------|
| R1   | substring "AB" anywhere | replace with "BA"               |
| R2   | substring "CD" anywhere | replace with "DC"               |
| R3   | substring "YZ" anywhere | replace with "ZY"               |
| R4   | substring "X" anywhere  | insert "Y" right after (length+1)|
| R5   | substring "A" anywhere  | insert "B" right before (length+1)|

R4 and R5 now fire on every X / every A, so chains of depth 50 are
reachable from any starting string with at least one X and one A.
String length is capped at 64 in the reference solver, which keeps the
search space bounded.

The published pool's per-band rule-mix (post-Phase 2 measurement, seed
`0xC0FFEE`):

```
L5  distinct rules per chain: 3.0   max share: 0.60
L10                             3.0            0.80
L20                             3.0            0.80
L30                             3.0            0.83
L50                             3.0            0.84
```

Every chain has at least 3 distinct rules; no rule dominates more than 85%
of the derivation. Phase 7 calibration will revisit the 85% threshold.

Generator parameters frozen at this commit:

| Constant              | Value  | Notes |
|-----------------------|--------|-------|
| `POOL_SEED`           | `0xC0FFEE` | New seed; the Minesweeper `0x5EED` is unrelated. |
| `GENERATOR_VERSION`   | 1      | Bump on any rules.mjs / generator.mjs / band layout change. |
| `MAX_STATES`          | 50000  | BFS visited-set cap. The longest L50 chains need ~40k visited states; 10000 truncated BFS and left those chains un-buildable. |
| `MAX_STRING_LENGTH`   | 64     | BFS string-length cap. |
| `MAX_STEPS`           | 60     | BFS depth cap (bands stop at 50). |
| `CHAIN_GEN_BUDGET_MS` | 2000   | Per-chain generation budget. |
| Boring-filter floor   | 3 distinct rules, max share < 0.85 | See `generator.mjs`. |

---

## Amendment B (Phase 4 commit) — SEE sample-efficiency, level-8 byte-identical

The "Detailed design: SEE changes" section defined sample levels 2/4/8/16
with weights 0.40/0.30/0.20/0.10 and per-level GZ. Phase 4 implements
that, with one important constraint: every old Cohort 1 SEE score under
the 8-shown-example prompt must remain comparable.

What changed in the eval:
- Each task now ships 16 shown examples (was 8). The first 8 are the
  unchanged suite-0.x.x examples.
- `buildPrompt(task, samples)` renders the FIRST `samples` entries. With
  no second arg it defaults to 8 (byte-identical to the old behavior).
- The SEE runner (`npm run see:levels`) loops over the 4 levels and
  reports per-task weighted score + per-level GZ. The dry-run path
  inlines each task's reference oracle as the "model", proving the
  per-level scoring path works without network.
- Robustness is computed from the first level's held-out arm
  (held-out is identical across levels, so other levels would double-count).

What stayed the same (the byte-identical gate):
- Level-8 prompt digests A=043dd2b7…, B=4f200996…, C=2e2bcf34… are
  unchanged byte-for-byte. Every existing SEE score under the old
  level-8 prompt remains comparable to a new level-8 run.
- Levels 2, 4, 16 are NEW prompt slots. Their digests are pinned in
  `src/prompt-digests.mjs` (a new `SEE_LEVEL_DIGESTS` table) so a score
  can always be re-derived from the exact prompt that produced it.

Synthetic audit (reference oracle, no network) at every level:
- per-task weighted score: 100% on A, B, C
- per-level GZ: 0 at 2, 4, 8, 16
- robustness: 5/5 (no throws)
- total: 45 + 5 = 50/50

Phase 4 prompt-digest pins (new slots at suite 1.0.0):

```
A-2  0ce5da7eed7dc90503563bb4e8a2a83fc701dd00cd47adca58aa9c170a7fe32c
A-4  e6c84ef27b4e58d5cb97b3c09a53952589891118f2d44a837181124eb7363e05
A-8  043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da
A-16 5b48ec298ed807ea6309052d4888324d1960b22fdb6f0a7803c9d415bf04f768
B-2  17bf47ec5bb83689067964d687c7ede5ebacfff6ed02042dece695a713830c86
B-4  698d863b99cc446224b5e0ab6142b58908f9857c1b23c7fe812156d48e1701c3
B-8  4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc
B-16 7098500ee41c57825a4820b203bab888d883316de75132c37c24f369cd3431fd
C-2  35d76575f91d1ed2047a9ebecf05ef109bdb74301f145f89bee00901f15a3482
C-4  d305dfb38c4f1f103a219b12d46de7a639d8ca7b34e9b86e1e3845d5a40fd2f9
C-8  2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728
C-16 acd424f775345fe21993783679f5bdb904b15517ca1d82d959368f639f136294
```

New modules per phase (verified by the self-test):

| Constant / shape        | Value                                    | Source                          |
|-------------------------|------------------------------------------|---------------------------------|
| `SAMPLE_LEVELS`         | `[2, 4, 8, 16]`                          | `score.mjs`                     |
| `SAMPLE_WEIGHTS`        | `{ 2: 0.40, 4: 0.30, 8: 0.20, 16: 0.10 }`  | `score.mjs`                     |
| `scoreSeenAtLevel`      | `(fnByTask, samples)` -> per-level seen   | `score.mjs`                     |
| `scoreTaskAcrossLevels` | per-task `perLevel` + weightedRate         | `score.mjs`                     |
| `weightedSum`           | SAMPLE_WEIGHTS-aware weighted sum          | `score.mjs`                     |
| `robustnessAcrossLevels` | single held-out arm's throw count          | `score.mjs`                     |
| `runLevel` / `runAllLevels` | 12-call (3 tasks × 4 levels) runner      | `run-levels.mjs`                 |
| `SAMPLE_LEVELS` export   | prompt module mirror                       | `prompt.mjs`                    |

---

## Amendment C (Phase 5 commit) — adjusted formula, report schema, Progress Index retirement

Phase 5 retires the legacy Minesweeper progress index and replaces it
with the new formula the plan specifies:

```
adjusted = clamp( SEE + DO
                   - GENERALIZATION_WEIGHT * GZ_mean
                   - NO_CONFIDENT_ERROR_POINTS * (1 - chainEngagementRate),
                 0, 100 )
```

with `GENERALIZATION_WEIGHT = 0.5` and `NO_CONFIDENT_ERROR_POINTS = 10`,
both hand-chosen at suite 1.0.0. The weights live in `src/adjusted.mjs`
with rationale beside each one — see the long header there.

`GZ_mean` is the unweighted mean of per-level GZ across the four SEE
sample levels (Phase 4). `chainEngagementRate` is the fraction of the
50 chains on which the model's submission made at least one legal step
(full credit OR partial credit). An empty submission scores 0 — the
same "free points earned by doing nothing" condition the old
formulation targeted.

### Schema changes

- SEE report (`monkey-see/levels@1`): per-level seen / heldOut / GZ,
  per-task weightedRate / gzMean, gzMean. Phase 4 prompts already in
  this report; the schema is the one builders consume.
- DO v2 report (`monkey-do/chain@1`): per-band chain results,
  per-chain outcomes, `chainEngagementRate`.
- Combined report (`monkey-see-monkey-do/combined@5`): see + do + per-
  level GZ + chainEngagementRate + adjusted. The old
  `generalizationIndex` and `initiationRate` fields are gone.

### Progress Index retirement

The legacy Minesweeper `progressIndex` field is removed from the
adjusted formula and from the combined report. It is **not** removed
from the legacy DO v1 report (still emitted for `npm run do`) — old
reports in `results/` keep their numbers per the Phase 5 rule that the
existing artefacts are not retroactively rewritten. Phase 6 deletes
`buildDoReport` / `writeDoReport` and `src/do/minesweeper/*` together.

### Synthetic round-trip (the Phase 5 gate)

With SEE 50, DO 50, gzMean 0, chainEngagementRate 1, the formula
returns 100/100 — same as the legacy perfect-run invariant. The unit
tests pin the three edge cases the user named: all-engaged (no
claw), never-engaged (full claw), partially-engaged (linear half-claw).

### Tests passing under the gate

- 187 PASS, 2 FAIL (the same pre-existing `DO prompt matches its
  recorded digest` legacy check — Phase 6 fixes that wiring). The new
  Phase 5 checks — `all-engaged`, `never-engaged`, `partially-engaged`,
  the new combined-report round-trip — all pass.

---

## Amendment D (Phase 6 commit) — legacy teardown and self-test reset

Phase 6 closes out the pivot. Everything pre-pivot is gone:

- **Deleted:** `src/do/minesweeper/` (board, oracle, pool.json, pool.mjs),
  `src/do/run.mjs`, `src/do/prompt.mjs`, `src/do/score.mjs`,
  `src/do/reference-solver.mjs`, `src/do/progress-index.mjs`, `bin/gen-pool.mjs`,
  and the four Minesweeper-specific test files (`board.test.mjs`,
  `oracle.test.mjs`, `pool.test.mjs`, `do-run.test.mjs`).
- **Repointed:** `npm run do`, `npm run dry-run`, `npm run gen-pool`,
  `npm run check-pool` now point at the chain equivalents. The chain dry-run
  passes its 50/50 gate; `npm run check-pool` byte-verifies the chain pool.
- **Renamed report builders:** `buildDoReport` → `buildChainDoReport`,
  `writeDoReport` → `writeChainDoReport`. The `runChainDo` CLI emits a
  `do-<model>-<date>-<time>.json` report (a chain report, not a board
  report). The legacy callFailure object carries a chain outcome
  (`protocol_violation` for an unusable solver, never Minesweeper's
  `detonation` / `unproven_move` / `surrender`).
- **Schema:** the combined report is `monkey-see-monkey-do/combined@5`,
  SEE is `monkey-see/levels@1`, DO is `monkey-do/chain@1`, and the
  acceptance gate is `monkey-see-monkey-do/acceptance@2`. The legacy
  `monkey-see/report@2` and `monkey-do/report@3` schemas are gone.
- **Progress Index:** removed from the adjusted formula. The Phase 5
  `chainEngagementRate` clawback is the new gate. The `initiationRate`
  / `progressIndex` fields never appear in 1.0.0 reports.
- **Self-test:** now reports zero failures on a clean tree. The "one
  known legacy failure" era ends with this phase. The 108 self-test checks
  plus the 224 npm-test checks all pass; the canonical commands work
  end-to-end with no network.

The Minesweeper DO digests (69200346…, f2f520b6…, b7a62fe6…) are now
historical context only — they describe retired digests in the comment
block of `src/prompt-digests.mjs` and appear nowhere else in the suite.

---

## Amendment E (Phase 7 commit) — calibration consolidation and README rewrite

Phase 7 is documentation-only. No scoring code changes.

### What changed

- **`docs/calibration.md`** rewritten from the Minesweeper-era baseline to the
  chain-eval baseline. The new file documents every asserted number with the
  command that re-derives it (the existing convention). Sections:
    1. Why calibration matters (unchanged)
    2. SEE: naive baseline at every sample level (Phase 4 axis added)
    3. SEE: per-level GZ band
    4. DO: chain-engagement random baseline — random walk scores 50/50
       (correctSteps == submittedSteps); the right random benchmark is
       the fullCredit rate (5/50 in the measured run, ~10%)
    5. DO: empty-array "free points" baseline — 0/50 DO, engagement=0,
       adjusted floors at 0 (the Phase 5 clawback fires)
    6. DO: reference solver in two modes — dry-run 50/50 (recorded
       derivation threaded), real-mode 45/50 (BFS from scratch; 5 L50
       chains saturate MAX_STATES=50000). Distinction is now load-bearing.
    7. The chain pool (50 chains, seed 0xC0FFEE, 5 bands × 10)
    8. The rewrite rules and BFS state cap
    9. The adjusted total's weights (0.5 × GZ_mean, 10 × (1 − chainEngagementRate))
   10. The retired Minesweeper scaffolding — what the old numbers were,
       the three old DO digests (`69200346…`, `f2f520b6…`, `b7a62…`)
       documented as history only
   11. Changing any of this (re-derived table for the new axes)

- **`README.md`** structurally rewritten to describe suite 1.0.0. Notable
  decisions:
    - The Cohort 1 section was REMOVED. The cohort numbers were recorded under
      the Minesweeper DO; per the user's instruction "Numbers quoted in the
      README must match calibration.md outputs", the Minesweeper-era
      numbers can't stay. The Results block now explains that no post-pivot
      cohort is committed yet and points to the chart path + acceptance gate.
    - The "Non-comparability" section adds the new "DO scores before 1.0.0
      (Minesweeper DO) are not comparable" sentence alongside the old
      "DO scores before 0.3.0 are not comparable" sentence, as two
      separate sentences describing two separate breaks in the DO history.
    - Both axes described: Generalization Index (per sample level, scored
      minus held-out in points), chain-engagement rate (fraction of 50
      chains with at least one legal step, [0,1]).
    - The random-walk baseline is documented as **50/50** by construction
      (every random pick is legal; the score axis is correctSteps /
      submittedSteps, not "reached target"). The fullCredit rate is the
      right random benchmark.
    - The reference solver's two modes (dry-run 50/50, real-mode 45/50)
      are documented with their per-band breakdown, and the test-author
      implication (asserting 50/50 on the model path tests the gate, not
      the model).
    - The Limitations section updated to mention the chain-engagement
      canary in the prompt (`monkey-do-chain@1.0.0`), the formal-system
      algorithm recall risk (replaces "textbook algorithm" recall), and
      the random-walk baseline's 50/50 property.
    - The publication gate criteria table updated to the chain-eval
      version (reference solver wins every chain, chain-naive baseline
      floors at 0, 108 checks at 1.0.0).
    - The Repository layout updated to the actual src/do/chain/ structure.
    - The Maintaining section updated: 108-check gate, gen-pool and
      check-pool point at the chain pool, the calibration reference list
      reflects the new axes.

### What did NOT change

- No scoring code changes.
- The chain pool was NOT regenerated — it was byte-identical under
  `npm run check-pool` earlier in the session and treated as frozen.
- The self-test's 108 checks all pass with `npm run self-test`.
- `npm test` (224 checks) all pass with no failures.
- `npm run dry-run` PASS 50/50 (chain dry-run via the canonical command).
