# Calibration

Every number this suite asserts, and how it was measured.

`npm run self-test` re-derives the SEE baselines, the random baseline and the
dry-run result on every invocation, so nothing here is trusted on faith. The
figures below were produced by executing the code in this repository against the
published pool — not estimated, and not carried over from an earlier design.

Read this before changing a held-out set, the board pool, the oracle, or the
effort cap. Each of those changes the meaning of a score, and this file is the
only record of what the current numbers mean.

- [1. Why calibration matters](#1-why-calibration-matters)
- [2. SEE: the naive baseline](#2-see-the-naive-baseline)
- [3. DO: the random baseline](#3-do-the-random-baseline)
- [4. DO: the effort cap](#4-do-the-effort-cap)
- [5. The board pool](#5-the-board-pool)
- [6. The deduction rules](#6-the-deduction-rules)
- [7. The Progress Index's depth reference](#7-the-progress-indexs-depth-reference)
- [8. The adjusted total's weights](#8-the-adjusted-totals-weights)
- [9. DO: Pool A bands (Phase 1)](#9-do-pool-a-bands-phase-1)
- [10. DO: Pool B verdict pool (Phase 2)](#10-do-pool-b-verdict-pool-phase-2)
- [11. Changing any of this](#11-changing-any-of-this)

---

## 1. Why calibration matters

A benchmark that scores 0% for a naive implementation tells you only that it
failed. One that scores 100% is broken. The useful property is a **middle band**:
low enough that copying the surface fails visibly, high enough that a real
attempt gets partial credit.

Both baselines exist to make that gap legible and to stop the eval being read as
a measure of anything when it isn't discriminating.

---

## 2. SEE: the naive baseline

Each task has a documented naive implementation that gets the *shape* right and
the *rule* wrong. It is the stand-in for "learned the examples instead of the
rule", and the self-test scores it on every run.

| Task | Naive implementation | Score | Core | Boundary | Adversarial |
|---|---|---|---|---|---|
| A | `n => n * n` | **34%** (17/50) | 14/20 | 3/15 | 0/15 |
| B | always uppercase | **36%** (18/50) | 10/20 | 6/15 | 2/15 |
| C | `sort desc [len-2]` | **32%** (16/50) | 10/20 | 2/15 | 4/15 |
| | **Overall** | **34%** (51/150) | | | |

All three land inside the required 20–45% band. Task A's arithmetic: of its 50
held-out inputs, 17 have `n <= 10` (naive correct) and 33 have `n > 10` (naive
wrong).

**A second, independent check.** The naive implementation must also *fail* some
of the eight shown examples — otherwise the shown set does not expose the rule at
all, and a model could score well by pattern-matching alone. Scored on the shown
examples the naive implementations get **5/8, 5/8 and 4/8** correct. All three
shown sets correctly demonstrate the rule they exist to demonstrate.

**Task B and C were rebuilt to earn these numbers.** An earlier revision of the
held-out sets let the naive implementation score 70% on B and 62% on C, because
whole buckets contained cases the naive answer happened to get right — arrays
whose duplicate landed on the same index the naive code read, and "adversarial"
word lists written in capitals, which the naive uppercase-first implementation
answered correctly by accident. Both buckets were rebuilt around the collision.

If you edit a held-out set, re-run `npm run self-test`. It fails loudly if a
naive score leaves the 20–45% band, or if the naive implementation starts passing
the shown examples.

---

## 3. DO: the random baseline

The DO Index is `model survival − random survival`. The random opponent picks
uniformly among all unrevealed non-flagged cells at each step.

**Measured survival is 0% on every tier.** Random play dies after 1–4 calls.

The baseline is simulated at run time rather than hardcoded, over the Pool A
boards being scored. Every playthrough replays the exact board under
consideration and varies only the random moves, so it is deterministic given the
seed. It is not a constant because a constant can drift away from the board
shapes it describes without anyone noticing.

Because the baseline is 0%, the DO Index reduces to the model's own survival
rate, which makes it a clean statement: **any survival at all is more than
chance.**

The index is still reported per tier. The gradient is the informative part — a
model that handles the small boards and not the large ones has not learned the
problem, it has learned to look at small boards.

> **A note on a corrected figure.** An earlier design reported random survival of
> ~11% / ~4% / ~1% across the three classic difficulties. Those figures were
> measured against a weaker opponent than the one actually used: they assumed a
> first click with no cascade opening, leaving the board almost entirely hidden.
> This harness opens until a real information cascade happens, which reveals a
> large region before random play takes its first turn — and an already-open
> region cannot be walked into a mine. The corrected figure is 0%, because 0% is
> what the real opponent does.

---

## 4. DO: the effort cap

```
capForTier(tier) = max(24, ceil(safeCells / 2) + 12)
```

giving **75, 114 and 200** calls on the three tiers. This is the single value
shared by pool generation and the scoring harness. A solver that reaches it is
recorded as `stalled`.

A solver needs one call per cell it reveals, so the cap is fundamentally a
statement about how many calls a correct solver needs per cell revealed.

### How the divisor was chosen

It was measured, not chosen. Replaying Pool A boards against an unbounded cap
and recording how many calls a correct solver actually needs:

| Tier | Safe cells | Median calls | p95 | Max | Cap | Cells/call |
|---|---|---|---|---|---|---|
| `poolA-small` | 125 | 34 | 49 | 58 | 75 | 3.68 |
| `poolA-medium` | 203 | 72 | 93 | 108 | 114 | **2.82** |
| `poolA-large` | 375 | 119 | 149 | 153 | 200 | 3.15 |

The **medium** tier is tightest at 2.82 cells per call, so the divisor is set to
**2** — below the worst tier rather than at some tier's median. That ratio is
where the headroom comes from: at 2 cells per call the medium tier's cap of 114
sits above its maximum observed 108, with the maximum across all six
tier-and-pool combinations being 155 of the 200 allowed on `poolA-large`. The
`+ 12` is a smaller fixed margin on top; the floor of 24 never binds on the
published tiers, where the smallest board already yields 75, and exists only as a
guard for anything smaller.

**Zero boards in the published pool come close.** The busiest board on any tier
uses 155 of its 200 available calls; nothing on any tier is capped. That is the
property that matters: a cap that binds produces boards that read as "this model
is bad at Minesweeper" when they are really the harness refusing to let the
solver finish.

The cap is generous for any correct solver, not just the oracle's own move
order — replaying Pool A with a solver that always takes the *highest*-index
proven cell, the opposite of the oracle's choice, stays well inside it.

### Why this is easy to get wrong

The failure is invisible in the output. When the cap was wrong, boards were
simply rejected, acceptance dropped, and the result read as a property of
Minesweeper rather than of the harness. It was wrong twice before it was
measured, both times by being fitted to a single tier:

| Version | Value | What happened |
|---|---|---|
| v1 | hardcoded `24` | Most `poolA-small` boards hit the cap. Read as "a correct solver does not win most Minesweeper boards." It did not — the cap was truncating them. |
| v2 | `ceil(safe/4) + 8`, fitted to small's median | Fixed small, and **silently broke the other two tiers.** |
| **v3** | `max(24, ceil(safe/2) + 12)` | Zero boards capped on any tier. Current. |

### Keep the two version numbers apart

`GENERATOR_VERSION` in `pool.mjs` is **2**, and records oracle changes. The "v1 /
v2 / v3" above are versions of the *effort cap*, a separate axis. Changing the
oracle or how a board is classified bumps `GENERATOR_VERSION` and requires
`npm run gen-pool`; loading a pool built by a different generator version fails
loudly rather than scoring against mismatched boards.

---

## 5. The board pool

**450 boards**, regenerable byte-identically from seed **`0x5EED`**. 100 Pool A
and 50 Pool B on each of three tiers. Generation takes a few minutes, paid once
by `npm run gen-pool`, not on every run.

| Tier | Shape | Mines | Cells | Safe cells | Cap | Pool A | Pool B |
|---|---|---|---|---|---|---|---|
| `poolA-small` | 11×13 | 18 | 143 | 125 | 75 | 100 | 50 |
| `poolA-medium` | 14×17 | 35 | 238 | 203 | 114 | 100 | 50 |
| `poolA-large` | 19×23 | 62 | 437 | 375 | 200 | 100 | 50 |

The shapes are deliberately non-standard — outside beginner/intermediate/expert.
Strategy heuristics memorised for a 9×9 board transfer poorly to them, which
blunts the contamination problem structurally.

### Pool A versus Pool B

The pools are distinguished by **condition, not shape**:

- **Pool A** — a correct solver wins it. Every step deducible, no guessing. Zero
  luck, which is why a lucky-but-unproven move forfeits points identically to a
  detonation.
- **Pool B** — deduction reaches a position where no cell is provably safe, and
  a guess is genuinely required. Scored on returning `null` at that position.

Both pools use the same three shapes so the tier gradient is comparable across
them.

### Generation is expensive on Pool B, and that is expected

| Pool | Tier | Attempts | Accepted | Rate |
|---|---|---|---|---|
| A | small | 111 | 100 | 90% |
| A | medium | 123 | 100 | 81% |
| A | large | 123 | 100 | 81% |
| B | small | 853 | 50 | 5.9% |
| B | medium | 347 | 50 | 14% |
| B | large | 266 | 50 | 19% |

Pool B accepts 6–19% of candidates because most boards turn out to be winnable,
and that dominates generation time. **This is a property of Minesweeper, not a
bug.** No candidate on any tier was unclassifiable.

### Rejected candidates are reported, not hidden

| Pool | Tier | Wrong pool | Hard stall |
|---|---|---|---|
| B | small | 767 | 36 |
| B | medium | 281 | 16 |
| B | large | 208 | 8 |

"Wrong pool" means the candidate was winnable, so it belongs in Pool A. "Hard
stall" means the solver gave up with most of the board still hidden — that is a
hard board, not an ambiguous one, and filing those into Pool B would pad the set
with boards a stronger solver wins. Pool B asserts that guessing is *required*,
so a board counts only if fewer than **40%** of its cells remain hidden when the
solver gets stuck.

### Three outcomes, not two

The oracle distinguishes these, and collapsing any two of them would silently
corrupt the pool:

| Outcome | Meaning | Pool |
|---|---|---|
| `deducible` | A certain-safe move was proven | A |
| `ambiguous` | Search finished, found nothing — guessing is required | B, if endgame |
| `inconclusive` | Search hit its budget — **we do not know** | neither, discard |

`inconclusive` is the one that matters. Pool B asserts that no safe move exists.
An exhausted search has not proven that; it has merely failed to disprove safety.
Treating it as ambiguous would let a too-small budget quietly manufacture
ambiguity.

---

## 6. The deduction rules

Every safe move must follow from these. They are also stated in the prompt the
model receives, and implemented in `do/minesweeper/oracle.mjs`.

**Rule 1 — the basic constraint.** A revealed cell showing `N` means *exactly*
`N` of its unrevealed neighbours are mines.

**Rule 2 — saturated set.** If a numbered cell shows `N` and has *exactly* `N`
unrevealed neighbours, all of them are mines.

**Rule 3 — subset elimination.** If constraint A's unrevealed set is a subset of
constraint B's, and A requires all of its members to be mines, those members are
removed from B's set and B's count is reduced accordingly.

**Rule 4 — shared-neighbour exclusion.** If two constraints share a single
unrevealed neighbour, and one of them is already satisfied by known mines
elsewhere, the shared cell is safe.

**Rule 5 — global mine-count.** The total number of mines is known — it is the
second argument of `solve(board, mines)`. If all remaining unrevealed cells must
contain the remaining mine count, every one is a mine; and if the cells next to
the numbers must between them hold every remaining mine, every cell away from the
numbers is safe.

**Consequence:** a move is *provably safe* if the constraint set proves at least
one unrevealed cell contains no mine. A correct solver returns such a cell, or
`null` when none exists. Flags are the player's own annotation and prove nothing —
they are treated identically to `null`.

---

## 7. The Progress Index's depth reference

The Progress Index's `depth` component needs a scale for "how many proven moves is a lot?"
It uses **75**, which is the reference solver's own mean proven-move count on Pool A,
rounded from a measured **74.99**.

```bash
npm run dry-run    # prints: mean 74.99 proven moves per Pool A board (oracle 75)
```

Re-derive it by reading `meanCalls` out of the dry-run report rather than recomputing
it by hand:

```bash
node -e "import('./src/do/progress-index.mjs').then(async m => {
  const r = JSON.parse(require('fs').readFileSync('results/do-dry-run-reference-solver-<date>.json'));
  console.log(m.scoreProgressIndex({ boardResults: r.boardResults }).meanCalls);
})"
```

**75 is a scale, not a pass mark.** A model that clears boards in a different order can
legitimately make fewer calls and still be correct, so `depth` saturates at the oracle and
never demands matching it. Changing `REFERENCE_DEPTH` in `src/do/progress-index.mjs` rescales
the Progress Index only — no 50-point score moves, and the oracle stays 15/15 at any value.

`initiation` and `breadth` need no calibration: they are fractions of boards and of tiers.

---

## 8. The adjusted total's weights

`adjusted = clamp(SEE + DO − 0.5 × GZ − 10 × (1 − initiationRate), 0, 100)`

Two hand-chosen weights, both judgement calls, both recorded here rather than buried in
the formula:

| Weight | Value | Why | Where it comes from |
|---|---|---|---|
| `GENERALIZATION_WEIGHT` | 0.5 | A high Generalization Index means held-out points were collected without generalization. Removing them outright would erase a model's real ability; removing half treats surface fit as roughly half a real point. | Judgement. No derivation. |
| `NO_CONFIDENT_ERROR_POINTS` | 10 | The exact size of the DO component the clawback corrects. | Not a choice — it is `poolANoDetonation`'s maximum in `src/do/score.mjs`. If that component is ever reweighted, this must follow it. |

**The clamp is load-bearing.** A perfect run must read exactly 100, or the adjusted figure
cannot coexist with the oracle's calibration. `npm run self-test` asserts this directly
("a perfect run still scores 100/100 adjusted"), along with the floor at 0 and the cap at
100. If a weight change ever breaks it, the self-test blocks scoring.

**Neither adjustment touches a 50-point score.** `SEE`, `DO`, `GZ` and the Progress Index are
all reported unchanged; the adjusted total is a reporting layer only. That is why its
weights are not frozen at a suite version the way the 50-point weights are — nothing
recorded before this existed is invalidated by changing them.

To see the effect on a real cohort:

```bash
node bin/chart.mjs docs/cohort-1-local-small.json
```

---

## 9. DO: Pool A bands (Phase 1)

Pool A's 30 points used to be a coin flip — every model that won one board won
30, and every model that lost one won 0. Bands split that into a ladder so a
model that can do easy logic but not hard logic gets partial credit.

### The classification

Each Pool A board is replayed with the oracle in instrumented mode. The
worst rule the replay needs decides the band:

- **Band 1 (easy)** — every safe move derivable by Rule 2 alone: saturated
  sets, no subset elimination, no search.
- **Band 2 (chained)** — Rule 3 (subset elimination) or Rule 5 (global mine
  count) needed at least once, but never the search.
- **Band 3 (wall)** — the exact search ran at some point in the replay. These
  are the positions where propagation stalls and only a consistency check
  proves the next move.

### Measured histogram

`npm run dry-run -- --bands` runs the classification on every Pool A board:

```
  BAND HISTOGRAM (Pool A, dry-run measurement)
    poolA-large    total 100  1 (easy)       0   2 (chained)    94   3 (wall)   6
    poolA-medium   total 100  1 (easy)       0   2 (chained)    87   3 (wall)  13
    poolA-small    total 100  1 (easy)       0   2 (chained)    94   3 (wall)   6
    TOTAL                 300  1 (easy)       0   2 (chained)   275   3 (wall)  25
```

Band 1 is empty on every shape. The pool's openings are large enough that
propagation almost always needs subset elimination at some point in the
replay. Re-generating the pool with sparser openings would give Band 1 boards,
but that breaks the byte-identical promise for a cosmetic rung.

### The two-band ladder (Amendment A)

Pool A's 30 points split **10 (Band 2, chained) / 20 (Band 3, wall)**, since
Band 1 has none. A board is `won` with every move proven, as before. Each
band's contribution is `boards-won-in-band / boards-assigned-to-band × weight`:

- Band 2: 10 × (won / assigned) → 10/10 max
- Band 3: 20 × (won / assigned) → 20/20 max

The report field is `poolABands: { chained, wall }`. There is no dead `easy`
key. The empty-band contract is pinned in the self-test.

### Median initial-revealed per band

The histogram also prints the median number of cells the opening reveal
exposes, per band:

| Band | Median `initialRevealed` |
|---|---|
| Band 2 (chained) | 53 cells |
| Band 3 (wall)    | 27 cells |

Smaller openings land on Band 3 more often — that is the published
correlation, not a causal one. The "Band 1 is empty because the openings
are large" story remains a hypothesis; the data above is the measurement.

### Re-deriving

```bash
npm run dry-run -- --bands    # 450 boards, instrumented replay, ~30s
```

The histogram is recomputed on every dry run with `--bands`. The self-test
pins the totals (0 / 275 / 25) so the bands cannot drift without
self-test failing.

---

## 10. DO: Pool B verdict pool (Phase 2)

Pool B's 10 points split 4 (stop discipline) + 6 (verdict discipline), so a
model that stops correctly but cannot reason about stuck positions gets
partial credit, and a model that reasons correctly but does not stop gets
penalised.

### The verdict function

The model writes a second function in the same response as the solver:

```js
verdict(position, claims, mines)
//   claims: [{ id, row, col }]
// returns { "<claimId>": "PROVEN_TRUE" | "PROVEN_FALSE" | "CANNOT_TELL" }
```

`position` is the canonical stuck board view — the position after the oracle
plays all proven moves, deterministic per board, independent of the model's
play. A claim of PROVEN_TRUE asserts the cell is provably a mine.
PROVEN_FALSE asserts provably safe. CANNOT_TELL admits the position does
not decide it.

### How claims are sampled

Three claims per board, sampled from the canonical stuck position with the
sampler doing a mixed-first pass and then filling with the remaining
statuses. Two consecutive calls with the same inputs return identical
cells — the sampler is a pure function of the board.

The published pool's stuck positions are 86% provably_mine, 14% mixed,
and 0 provably_safe (out of 5393 classified cells across all 150 Pool B
boards). The mixed-first bias is what makes every board's sample
include at least one mixed claim; without it, 99/150 boards would have
all-provably_mine samples and a blanket PROVEN_TRUE would score the
verdict pool.

### Scoring

A board is `clean` if every response to a decidable claim is
truth-consistent and no mixed claim was asserted; CANNOT_TELL on
anything is always sound. A board is `sharp` if, in addition to clean,
every provable claim was asserted in the right direction and every
mixed claim was abstained.

| Component | Weight | Formula |
|---|---|---|
| Stop discipline | 4 pts | 4 × (correct stops / 150) |
| Verdict sound   | 4 pts | 4 × (clean boards / 150) |
| Verdict sharp   | 2 pts | 2 × (sharp boards / 150) |

A model that abstains everywhere (CANNOT_TELL on every claim) loses the
2 sharp but keeps the 4 sound: 4/6 on the verdict pool. A model that
asserts PROVEN_TRUE on every claim scores 0/6, because every Pool B
board has at least one mixed cell and PROVEN_TRUE on a mixed claim is
unsound.

### Re-deriving

```bash
npm run self-test   # 149/149; pins the 4/6 abstainer, 0/6 assert-everything
npm run dry-run    # the reference solver hits 6/6 on a full pool
```

---

## 11. Changing any of this

The rule is that **the pool and the harness must never be able to drift apart.**
`capForTier` is the single source of the cap, and `do/run.mjs` calls it rather
than recomputing anything — if the harness carried its own copy of the formula, a
future change to `CELLS_PER_CALL` would silently produce pools full of boards the
oracle can win but the model is never allowed to finish.

| If you change | Then |
|---|---|
| A held-out set | Re-run `npm run self-test`. The naive band and shown-example checks will catch a regression. |
| The oracle or pool classification | Bump `GENERATOR_VERSION` in `pool.mjs`, run `npm run gen-pool`, then `npm run check-pool`. |
| The effort cap | Re-derive the cells/call table above. Treat per-tier acceptance rates as provisional until re-measured. |
| A prompt | Update `src/prompt-digests.mjs` and bump the suite version. Any score recorded under the old digest is a different experiment. |
| `REFERENCE_DEPTH` | Nothing else moves. The oracle stays 15/15 at any value; re-run `npm run self-test` to confirm. |
| The adjusted weights | Nothing recorded moves either. Update the table in section 8 and re-run the self-test, which pins the oracle at 100. |

`npm run check-pool` regenerates the whole pool in memory and compares it byte
for byte against the published file. It is the check that makes a submitted
score verifiable.