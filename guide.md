# MONKEY SEE / MONKEY DO — Design Document

> A two-eval, fully-automated benchmark suite for measuring whether a language
> model **reasons** or merely **mimics**. No human scoring. No subjective rubrics.
> Deterministic. Runnable against any model, hosted or local.

**Status:** Implemented (`evals/`). Self-test, unit and end-to-end tests pass; a
dry run scores 50/50 on the full published pool. **Not yet published:** the
acceptance run against real models (§9.1, roadmap phase 6) has not been done.
**Version:** 0.2.0
**Last updated:** 2026-09-30

---

## 1. TL;DR

| | Eval | Question | Score |
|---|---|---|---|
| 🐒 **MONKEY SEE** | Pattern induction | Given 8 examples of an unknown function, does the model *infer the rule* or just pattern-match the surface? | 50 pts + Monkey Index |
| 🐒 **MONKEY DO** | Minesweeper solver | Given a visible board and the mine count, does the model *deduce* a safe cell — and stop when none can be proven — or guess? | 50 pts |

Both are scored by a script. A human never touches a result. Cost per run: **4
model calls** — one per SEE task, and one for DO, whose returned solver is then
replayed locally on all 450 boards. SEE takes seconds; DO takes one to three
minutes of local compute, depending on how fast the model's solver is.

---

## 2. Why these two evals

Most coding benchmarks ask **"can it do this once?"** — one prompt, one output,
pass/fail. That design has four structural weaknesses:

1. **Binary.** A model solving 400/500 looks identical in kind to one solving
   495/500. Degree is invisible.
2. **Single sample per problem.** Variance — the difference between "excellent
   30% of the time" and "uniformly mediocre" — is never observed.
3. **Output is not reusable.** A failed attempt tells you *that* it failed, not
   the *shape* of the failure.
4. **Memorization is uncontrolled.** Nothing in a single-shot harness separates a
   model that reasoned from one that recalled a solution it saw in training.

This suite attacks all four:

- **Both evals are scored over volume** — 150 held-out cases for SEE, 450
  boards for DO — so the output is a *distribution*, not a boolean.
- **Both report a gap metric.** SEE reports `seen% − held-out%`. DO reports
  `survival% − random baseline%`. Both quantify the distance between "imitating"
  and "solving."
- **SEE measures generalization directly.** A model scoring 100% on the 24 shown
  examples (8 per task) and 28% on the 150 held-out cases has demonstrated,
  quantitatively, that it copied rather than understood. This is the closest
  thing to a direct memorization readout that exists outside contamination
  studies.
- **DO uses a generated board pool** with layouts that need not appear in any
  training corpus, blunting the memorization problem structurally.

### 2.1 The two axes are complementary by design

`MONKEY SEE` tests **inference**: derive a rule from limited data.
`MONKEY DO` tests **deduction**: hold a constraint set and act correctly under it.

These are genuinely different faculties, and they are the two ends of the
see↔do axis that gives the suite its name:

| | Failure signature | What it looks like |
|---|---|---|
| **SEE** | Mimicry | `n => n * n` — right shape, no rule |
| **DO** | Guesswork | A confident click on a cell that was a mine all along |

A model that passes one and fails the other produces the most interesting result
in the suite, because that split is not otherwise visible. Record it always.

### 2.2 What this suite is not

Honest scope limits, stated up front:

- **Not a coding benchmark.** Neither eval edits files in a repository, runs a
  test suite, or uses tools. They measure reasoning, not software engineering.
- **Not a general intelligence measure.** Two narrow tasks.
- **Not comparable to SWE-bench, HumanEval, or any external score.** Different
  scale, different construction. Never present these numbers alongside a
  leaderboard's.
- **SEE saturates.** Frontier models will reach high scores and the eval stops
  discriminating at the top of the market. It remains useful for open-weight and
  mid-tier models, which is where the real decisions are made.

---

## 3. Naming rationale

The suite is named for the idiom, and the naming is load-bearing rather than
decorative — each eval measures a *different half* of it.

> **MONKEY SEE** — the model was shown examples. Did it look and copy, or look
> and understand?
>
> **MONKEY DO** — the model was given a position. Did it act deliberately, or
> act on instinct?

The idiom was originally drafted as a *build + play* pair, where "see" was
building a 2048 clone and "do" was playing it. That coupling was rejected for
two reasons:

1. **Both stages are "do."** Nothing is being imitated from a demonstration, so
   the see/do split did not hold.
2. **Coupling destroyed comparability.** If the model's own game is used as the
   play environment, a broken build zeroes the DO score, and it becomes
   impossible to tell whether the model *built* badly or *played* badly. The
   leaderboard loses its second axis exactly where it matters most.

Pattern induction became `MONKEY SEE` because the metric it produces — the gap
between seen and held-out performance — is a *direct* measurement of mimicry.
That is the strongest available reading of the name, so it gets the name.

---

## 4. MONKEY SEE — Pattern Induction

### 4.1 Design principles

1. **Eight examples.** Enough to constrain a rule, few enough that a memorizer
   can coast. Shown to every model in the same order.
2. **Three tasks, escalating difficulty.** Each targets a different kind of
   error: threshold detection, carve-out detection, set semantics.
3. **Fifty held-out cases per task**, stratified into three buckets.
4. **The rule is never stated.** The model must infer it.
5. **Expected values are computed, never stored.** `reference.mjs` holds the
   ground truth and derives answers at runtime, so held-out data cannot drift
   out of sync with the spec. See §4.1.1 for the settled file format.
6. **Naive baselines land in the 20–45% band by design.** This is the most
   important calibration property in the eval — see §4.9.

#### 4.1.1 Held-out data format

Settled during implementation. The split:

| File | Contains | Never contains |
|---|---|---|
| `src/see/tasks/task{A,B,C}.json` | shown examples (input + output), held-out **inputs** | any expected value for a held-out case |
| `src/see/reference.mjs` | the true rules, the naive implementations | any case data at all |
| `src/see/tasks.mjs` | joins the two by task id, validates shape | — |

**Why held-out answers are not stored.** Storing them would create two sources
of truth for the same fact. This document shipped with exactly that failure
(§9.2 item 7): Task C's shown example stated `0` where the rule gives `-1`.
Deriving expected values at runtime makes that class of bug *structurally*
impossible rather than merely unlikely.

**The deliberate asymmetry.** Shown examples *do* store their outputs, because
those must be rendered into the prompt and the model has to see them. They are
part of the task's definition, not the answer key. Held-out cases are the
answer key, and are therefore derived.

A self-test check asserts this split on every run: `reference.mjs` must contain
no `shown` or `heldOut` keys, and no held-out entry may be an answer pair. This
is what makes the integrity claim in §7.4 auditable by machine rather than by
reading a comment.

### 4.2 Why eight examples, specifically

With four examples, a model can frequently fit a rule that generalizes by luck.
With twelve or more, memorization of the visible set becomes sufficient to score
well, and the eval stops measuring inference. Eight sits at the point where the
correct rule is *findable* but the *visible set alone* is not sufficient.

The examples are ordered so that **deviating cases appear at positions 5, 7, and
8** — never last. A model that scans only the tail of a list cannot dismiss them
as a single outlier.

### 4.3 The exact prompt

Every model receives this text, byte-identical, for every task:

```
Below are input->output examples of a single function f. The rule is
consistent across all examples. Write the function f in JavaScript.
Output only the code, no explanation.

<SIGNATURE_HINT>
<EXAMPLES>
```

- `SIGNATURE_HINT` is e.g. `The function takes one integer argument: f(n)`.
- `EXAMPLES` is the eight pairs, one per line, formatted `f(2) -> 4`.

**Temperature 0, no system prompt, no retry.** One call per task. See §7.3 for
why this matters for reproducibility.

---

### 4.4 Task A — Arithmetic with a hidden threshold

**Target failure:** a model that pattern-matches `n * n` without noticing a
conditional branch.

**True rule:** `f(n) = n*n` when `n <= 10`, otherwise `n*n - 100`

**Naive implementation this punishes:** `n => n * n`

#### The eight shown examples

```
f(2)  -> 4
f(4)  -> 16
f(6)  -> 36
f(8)  -> 64
f(11) -> 21      <- deviates
f(13) -> 69      <- deviates
f(9)  -> 81
f(15) -> 125     <- deviates
```

**Expected values, verified:**
- `f(2)=4`, `f(4)=16`, `f(6)=36`, `f(8)=64`, `f(9)=81` — all `n <= 10`, all `n*n`
- `f(11)=121-100=21`, `f(13)=169-100=69`, `f(15)=225-100=125` — all `n > 10`

#### Why the ordering works

The first four examples are consistent with `n*n`. A model that stops reading
at example 4 scores 4/8 and 100% on the naive sub-range of the held-out set.
The deviation at position 5 is the entire test.

#### Held-out: 50 cases

**Core (20)** — plain, no edge cases:

| Input | Expected | Note |
|---|---|---|
| 1 | 1 | `n*n` |
| 2 | 4 | `n*n` |
| 3 | 9 | `n*n` |
| 4 | 16 | `n*n` |
| 5 | 25 | `n*n` |
| 6 | 36 | `n*n` |
| 7 | 49 | `n*n` |
| 8 | 64 | `n*n` |
| 9 | 81 | `n*n` |
| 10 | 100 | `n*n` — boundary, still naive branch |
| 0 | 0 | `n*n` |
| -1 | 1 | `n*n` — negative, still naive branch |
| 2 | 4 | repeat of a shown input |
| 4 | 16 | repeat of a shown input |
| 11 | 21 | `n*n-100` |
| 12 | 44 | `n*n-100` |
| 15 | 125 | `n*n-100` |
| 18 | 224 | `n*n-100` |
| 20 | 300 | `n*n-100` |
| 25 | 525 | `n*n-100` |

**Boundary (15)** — clustered at the threshold, where `n <= 10` and `n >= 11`
diverge:

| Input | Expected |
|---|---|
| 10 | 100 |
| 11 | 21 |
| 11 | 21 |
| 12 | 44 |
| 12 | 44 |
| 11 | 21 |
| 12 | 44 |
| 13 | 69 |
| 10 | 100 |
| 11 | 21 |
| 12 | 44 |
| 13 | 69 |
| 14 | 96 |
| 10 | 100 |
| 11 | 21 |

**Adversarial (15)** — large magnitudes, where `n*n - 100` is a small relative
correction and easy to miss:

| Input | Expected | Note |
|---|---|---|
| 15 | 125 | shown input, repeated |
| 16 | 156 | |
| 18 | 224 | |
| 20 | 300 | |
| 25 | 525 | |
| 30 | 800 | `900-100` |
| 35 | 1125 | `1225-100` |
| 40 | 1500 | |
| 50 | 2400 | |
| 60 | 3500 | |
| 70 | 4800 | |
| 80 | 6300 | |
| 90 | 8000 | |
| 100 | 9900 | `10000-100` |
| 11 | 21 | |



---

### 4.5 Task B — String transform with a carve-out

**Target failure:** a model that applies the transformation unconditionally,
skipping the exception.

**True rule:** if the first character is a vowel (`a`, `e`, `i`, `o`, `u`),
return the string unchanged; otherwise uppercase the first character.

**Naive implementation this punishes:**
`s => s.charAt(0).toUpperCase() + s.slice(1)`

**Reference implementation:**

```js
function f(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  const first = s[0].toLowerCase();
  if ("aeiou".includes(first)) return s;
  return s[0].toUpperCase() + s.slice(1);
}
```

#### The eight shown examples

```
f("apple")    -> "apple"
f("banana")   -> "Banana"
f("candle")   -> "Candle"
f("eagle")    -> "eagle"      <- deviates
f("forest")   -> "Forest"
f("iceberg")  -> "iceberg"    <- deviates
f("jungle")   -> "Jungle"
f("mountain") -> "Mountain"
```

**Expected values, verified:**
- `apple` — starts with `a` (vowel) → unchanged
- `banana` — `b` (consonant) → `Banana`
- `candle` — `c` → `Candle`
- `eagle` — `e` (vowel) → unchanged
- `forest` — `f` → `Forest`
- `iceberg` — `i` (vowel) → unchanged
- `jungle` — `j` → `Jungle`
- `mountain` — `m` → `Mountain`

Three vowel-initial inputs and five consonant-initial ones. A model must notice
that the *position in the list* is irrelevant and the *letter* is what matters.

#### Held-out: 50 cases

**Core (20)** — ten vowel-initial, ten consonant-initial:

| Input | Expected | Naive would give | Verdict |
|---|---|---|---|
| `"orange"` | `"orange"` | `"Orange"` | naive fails |
| `"ivory"` | `"ivory"` | `"Ivory"` | naive fails |
| `"elephant"` | `"elephant"` | `"Elephant"` | naive fails |
| `"indigo"` | `"indigo"` | `"Indigo"` | naive fails |
| `"obelisk"` | `"obelisk"` | `"Obelisk"` | naive fails |
| `"echo"` | `"echo"` | `"Echo"` | naive fails |
| `"island"` | `"island"` | `"Island"` | naive fails |
| `"acorn"` | `"acorn"` | `"Acorn"` | naive fails |
| `"onion"` | `"onion"` | `"Onion"` | naive fails |
| `"upward"` | `"upward"` | `"Upward"` | naive fails |
| `"banana"` | `"Banana"` | `"Banana"` | naive passes |
| `"candle"` | `"Candle"` | `"Candle"` | naive passes |
| `"forest"` | `"Forest"` | `"Forest"` | naive passes |
| `"jungle"` | `"Jungle"` | `"Jungle"` | naive passes |
| `"mountain"` | `"Mountain"` | `"Mountain"` | naive passes |
| `"tiger"` | `"Tiger"` | `"Tiger"` | naive passes |
| `"zebra"` | `"Zebra"` | `"Zebra"` | naive passes |
| `"stone"` | `"Stone"` | `"Stone"` | naive passes |
| `"window"` | `"Window"` | `"Window"` | naive passes |
| `"violin"` | `"Violin"` | `"Violin"` | naive passes |

**Boundary (15)** — single characters, empty string, and case edges:

| Input | Expected | Note |
|---|---|---|
| `"a"` | `"a"` | lone lowercase vowel — naive gives `"A"` |
| `"e"` | `"e"` | lone lowercase vowel |
| `"i"` | `"i"` | lone lowercase vowel |
| `"o"` | `"o"` | lone lowercase vowel |
| `"u"` | `"u"` | lone lowercase vowel |
| `"aB"` | `"aB"` | lowercase vowel then uppercase — naive gives `"AB"` |
| `"owl"` | `"owl"` | lowercase vowel-initial |
| `"ivy"` | `"ivy"` | lowercase vowel-initial |
| `"ant"` | `"ant"` | lowercase vowel-initial |
| `"b"` | `"B"` | lone consonant |
| `"k"` | `"K"` | lone consonant |
| `"B"` | `"B"` | uppercase consonant |
| `""` | `""` | empty string — reference returns input unchanged |
| `"A"` | `"A"` | uppercase vowel — naive coincides, coincidentally correct |
| `"Yellow"` | `"Yellow"` | `y` is not in `aeiou` — naive coincides |

**Adversarial (15)** — lowercase vowel-initial words, including mixed case.
Every one of these punishes the naive implementation directly. The earlier
revision of this bucket used already-uppercase words (`"Octopus"`, `"Egg"`),
which the naive implementation answers correctly *by accident* — capitalizing
an already-capitalized letter changes nothing. Those cases tested nothing. The
bucket now uses lowercase initials, where the naive answer is visibly wrong:

| Input | Expected | Naive would give |
|---|---|---|
| `"apple"` | `"apple"` | `"Apple"` |
| `"octopus"` | `"octopus"` | `"Octopus"` |
| `"umbrella"` | `"umbrella"` | `"Umbrella"` |
| `"iceberg"` | `"iceberg"` | `"Iceberg"` |
| `"eclipse"` | `"eclipse"` | `"Eclipse"` |
| `"amethyst"` | `"amethyst"` | `"Amethyst"` |
| `"opal"` | `"opal"` | `"Opal"` |
| `"aPPLE"` | `"aPPLE"` | `"APPLE"` |
| `"evergreen"` | `"evergreen"` | `"Evergreen"` |
| `"otter"` | `"otter"` | `"Otter"` |
| `"universe"` | `"universe"` | `"Universe"` |
| `"iguana"` | `"iguana"` | `"Iguana"` |
| `"alder"` | `"alder"` | `"Alder"` |
| `"zebra"` | `"Zebra"` | `"Zebra"` |
| `"kiwi"` | `"Kiwi"` | `"Kiwi"` |

**A note on the mixed-case trap.** `"aPPLE"` is included because a model that
lowercases the whole string before checking (`s.toLowerCase()[0]`) will return
`"apple"` and fail. Only the reference's `s[0].toLowerCase()` check is correct.
Note also that `"Apple"` — capital A — would be a *useless* adversarial case,
since both the true answer and the naive answer are `"Apple"`. Only a
**lowercase** initial distinguishes the two.



---

### 4.6 Task C — Second-largest distinct value, with null semantics

**Target failures:** three at once — sorting without deduplication, crashing on
short input, and returning `undefined` instead of `null`.

**True rule:** return the second-largest **distinct** value in the array, or
`null` if fewer than two distinct values exist.

**Naive implementation this punishes:**
`arr => arr.slice().sort((a, b) => b - a)[arr.length - 2]`

**Reference implementation:**

```js
function f(arr) {
  if (!Array.isArray(arr)) return null;
  const distinct = [...new Set(arr)];
  if (distinct.length < 2) return null;
  distinct.sort((a, b) => b - a);
  return distinct[1];
}
```

#### The eight shown examples

```
f([1, 2, 3])     -> 2
f([5, 1, 9, 3])   -> 5
f([4, 4, 7, 7])   -> 4      <- deduplication
f([1, 1, 1])     -> null    <- null semantics
f([8, 2, 8, 2])   -> 2      <- deduplication
f([3, 3, 4, 4, 5, 5]) -> 4
f([10])          -> null    <- single element
f([-1, 0, -1])   -> -1      <- deduplication with negatives
```

**Expected values, verified:**
- `[1,2,3]` → distinct `{1,2,3}` → sorted `[3,2,1]` → `2`
- `[5,1,9,3]` → `{1,3,5,9}` → `[9,5,3,1]` → `5`
- `[4,4,7,7]` → `{4,7}` → `[7,4]` → `4` (naive returns `4` too here by luck)
- `[1,1,1]` → `{1}` → 1 distinct → `null`
- `[8,2,8,2]` → `{2,8}` → `[8,2]` → `2` (naive returns `8` — **wrong**)
- `[3,3,4,4,5,5]` → `{3,4,5}` → `[5,4,3]` → `4`
- `[10]` → `{10}` → 1 distinct → `null` (naive returns `undefined` — **wrong**)
- `[-1,0,-1]` → `{-1,0}` → sorted `[0,-1]` → `-1` (the second element, not
  the first — an earlier revision of this line concluded `0`, which is the
  *largest* value and contradicts the rule above)

#### Why this task is the hardest

Three independent requirements must all be satisfied:

1. **Deduplicate** before ranking. Naive sorts the raw array.
2. **Handle degeneracy** — fewer than 2 distinct values means no second value.
3. **Return `null`, not `undefined`**, so the answer is `JSON.stringify`-able.

A model that gets two of three still fails roughly 40% of the held-out set. This
is the task that most reliably separates "understands set semantics" from
"sorts things."

#### Held-out: 50 cases

**Core (20)** — ten all-distinct (naive passes) and ten requiring dedup (naive
fails). The split is deliberate: the naive sort agrees with the true answer
whenever every value is distinct, so the bucket must force deduplication to
register at all.

| Input | Expected | Naive would give |
|---|---|---|
| `[1,2,3]` | 2 | 2 — passes |
| `[5,9,12]` | 9 | 9 — passes |
| `[4,7,8]` | 7 | 7 — passes |
| `[0,1,2]` | 1 | 1 — passes |
| `[10,20,30]` | 20 | 20 — passes |
| `[-5,-2,-1]` | -2 | -2 — passes |
| `[100,200,300]` | 200 | 200 — passes |
| `[3,4,5]` | 4 | 4 — passes |
| `[9,1,8]` | 8 | 8 — passes |
| `[7,3,9]` | 7 | 7 — passes |
| `[9,9,1]` | 1 | 9 |
| `[1,2,2]` | 1 | 2 |
| `[4,4,4]` | **null** | 4 |
| `[10,5,20,5]` | 10 | 5 |
| `[-1,-1,0,2]` | 0 | -1 |
| `[5,5,5]` | **null** | 5 |
| `[9,9,7,5,1]` | 7 | 5 |
| `[8,8,6,4,1]` | 6 | 4 |
| `[5,5,3,1,0]` | 3 | 1 |
| `[4,4,3,2,1]` | 3 | 2 |

**Boundary (15)** — degenerate and near-degenerate arrays:

| Input | Expected | Note |
|---|---|---|
| `[1]` | **null** | single element — naive gives `undefined` |
| `[]` | **null** | empty — naive gives `undefined` |
| `[9]` | **null** | single — naive gives `undefined` |
| `[0,0,1]` | 0 | two distinct, naive coincides |
| `[1,1,2,2]` | 1 | two distinct, naive coincides |
| `[1,1]` | **null** | one distinct |
| `[1,2]` | 1 | exactly two distinct |
| `[2,1]` | 1 | order irrelevant |
| `[3,3]` | **null** | one distinct |
| `[2,3]` | 2 | exactly two distinct |
| `[1,1,1]` | **null** | one distinct |
| `[1,1,1,1]` | **null** | one distinct |
| `[5,5,5]` | **null** | one distinct |
| `[7,7]` | **null** | one distinct |
| `[-1,0]` | -1 | exactly two distinct, all negative |

**Adversarial (15)** — negatives, heavy dedup, and mixed magnitudes, chosen so
the duplicate never lands on the naive index:

| Input | Expected | Naive would give |
|---|---|---|
| `[0,-1,-2,-3]` | -1 | -2 |
| `[100,1,50]` | 50 | 50 — passes |
| `[2,1,0]` | 1 | 1 — passes |
| `[-3,-1,-2]` | -2 | -2 — passes |
| `[10,10,8,6,4]` | 8 | 6 |
| `[5,5,5,4,3,2,1]` | 4 | 2 |
| `[-9,-9,-7,-5,-1]` | -5 | -9 |
| `[-5,-5,-3,-1,0]` | -1 | -5 |
| `[-1,-1,0,2,3]` | 2 | -1 |
| `[-2,-2,-2]` | **null** | -2 |
| `[-4,-4]` | **null** | -4 |
| `[0,0,0,0]` | **null** | 0 |
| `[-10,-10,0,5,9]` | 5 | -10 |
| `[7,7,7,7,1,2]` | 2 | 2 — passes |
| `[-1,-1,-1,-1,5,7]` | 5 | -1 |

**Why the earlier revision let the naive implementation through at 62%.** It
contained arrays like `[1,2,2]`, `[9,9,1]`, `[4,8,2,6]`, `[10,5,20,5]` and
`[0,-1,-2,-3]` where the duplicate happened to sit at index `len-2` of the
sorted array, so the accidental answer coincided with the correct one. Those
cases measured luck rather than reasoning. The bucket above is built to avoid
that collision.



---

### 4.7 Scoring — 50 points

| Component | Points | How computed |
|---|---|---|
| Task A held-out pass rate | 15 | `(correct / 50) * 15` |
| Task B held-out pass rate | 15 | `(correct / 50) * 15` |
| Task C held-out pass rate | 15 | `(correct / 50) * 15` |
| **Robustness** | 5 | `5 × (held-out cases that did not throw / 150)` |
| **Total** | **50** | |

The robustness bonus is **proportional**, not binary. It measures only whether
the model's code throws; it never measures whether answers were right, since
that is what the 45 task points already do.

An earlier version awarded 5 or nothing. Measurement showed why that was wrong:
a model that had learned Task B perfectly but omitted the empty-string guard
scored an identical 49/50 either way, yet lost all 5 points. One input out of
150 was silently worth 10% of the total. Proportional removes that cliff — the
same model now loses 0.03 points, which is the right magnitude for one missed
guard — while still scoring zero for code that throws on everything.

The naive baseline never throws, so it keeps its full 5 points and the
per-task bands above are unaffected. A model that throws on every case scores
0/50, as before.

Because the categorical question is still worth answering, every report also
carries a separate boolean `crashed` flag. It records *whether* a submission
threw without pricing a single unlucky input into the score.

**An unusable response** (prose, no function, a syntax error) counts as 50
failed, *thrown* cases for its task — in the task points, the robustness bonus,
and the held-out arm of the Monkey Index. It cannot produce a non-throwing case,
so it earns none of the bonus. (Version 0.1 dropped such a task from the
held-out arm and the bonus while still counting its 8 shown examples as failures
in the seen arm: a model that answered Task A in prose and B and C perfectly got
a Monkey Index of −33 and a full 5/5 bonus. See §9.2 item 8.)

### 4.8 The Monkey Index

The headline diagnostic, reported in addition to the 50-point score:

```
MONKEY INDEX = (SEEN pass rate) - (HELD-OUT pass rate)
```

- `SEEN` = all 24 shown examples (8 per task × 3 tasks), re-run through each
  task's returned function
- `HELD-OUT` = all 150 held-out cases (50 per task × 3 tasks)

Both sides of the subtraction pool all three tasks, so the comparison is
like-for-like: 24 examples on one side, 150 cases on the other. An earlier
revision of this section compared `SEEN` = 8 against `HELD-OUT` = 150, which
weighted one task's shown examples against all three tasks' held-out cases.

**Interpretation:**

| Index | Reading |
|---|---|
| 0–10 | Reasoned. Held-out performance matches shown performance. |
| 11–30 | Mostly reasoned, with gaps on edge cases. |
| 31–60 | Partial mimicry. Got the common case, missed the rule. |
| 61+ | **Mimic.** Copied the visible examples, understood nothing. |

A model with a Monkey Index of 70 has demonstrated, quantitatively, that its
score on the shown examples carried no information about its ability on new
ones. That is a claim almost no existing benchmark can make.

### 4.9 Calibration — the 20–45% naive band

The single most important design property. If the naive implementation scores
0%, the eval only tells you "it failed." If it scores 100%, the eval is broken.
The naive score must land in a middle band so the gap is legible.

| Task | Naive implementation | Verified naive score |
|---|---|---|
| A | `n => n * n` | **34%** (17/50) |
| B | always uppercase | **36%** (18/50) |
| C | `sort desc [len-2]` | **32%** (16/50) |
| **Overall** | | **34%** (51/150) |

These figures were obtained by executing each task's documented held-out set
against its documented naive implementation, not estimated. Per-bucket:

| Task | Core | Boundary | Adversarial |
|---|---|---|---|
| A | 14/20 | 3/15 | 0/15 |
| B | 10/20 | 6/15 | 2/15 |
| C | 10/20 | 2/15 | 4/15 |

**Task A arithmetic:** of 50 held-out inputs, 17 have `n <= 10` (naive correct)
and 33 have `n > 10` (naive wrong) → 17/50 = 34%.

**An earlier revision of this document claimed 40% for Task B and 38% for
Task C. Both were wrong** — the real figures were 70% and 62%, because the
buckets were not checked against the naive implementation before being
published. The held-out sets for Tasks B and C were rebuilt to remove cases the
naive answer happened to get right, and are documented in §4.5 and §4.6. A
second, independent check is that the naive implementation must also *fail* the
eight shown examples for each task — otherwise the shown examples do not
demonstrate the rule at all. It scores 5/8, 5/8, and 4/8 respectively, so all
three sets correctly expose the rule.

This must be re-verified by the self-test before the eval is published, and
re-verified after any edit to a held-out set. See §9.1.

### 4.10 Extracting and running model code

The model returns a code block. The harness:

1. Extracts the code: drops any `<think>…</think>` block; if the response
   contains fenced blocks, takes the first that mentions the requested function
   name (else the first); otherwise strips a bare or unterminated fence.
   Prose around a block is ignored — the eval measures reasoning, not formatting.
2. Removes `require` and `import` lines and `export` keywords. `console` is a
   **silent no-op** created inside the sandbox, rather than stripped line by
   line: that also covers calls inside the function and calls split across
   lines. (In 0.1 `console` was undefined, so a correct answer followed by
   `console.log(f(11))` scored as unusable.)
3. Evaluates the code in a fresh `node:vm` context, then looks for the function
   in a separate probe, trying the name the prompt asked for first (`f` for
   SEE, `solve` for DO). Top-level demo code that throws after the function is
   defined does not void the answer.
4. Calls it once per test case, comparing with `deepEqual`.

**Sandbox requirements:**

- `vm.createContext` with no `require`, no `process`, no `fetch`
- A 1000ms timeout per call — a model returning an infinite loop must not hang
  the harness
- Memory and recursion caps where the runtime allows
- The harness treats **any throw as a failed case**, never as a harness error

A model that returns valid JS but exploits the sandbox is not a realistic threat
in a self-hosted evaluation, but the timeout is non-negotiable: an infinite loop
in generated code is a common failure mode, not an attack.



---

## 5. MINESWEEPER — Rules Reference

This section exists so the eval can be implemented and audited without external
references. Minesweeper is used here because the *deduction* it requires is
precisely the skill the eval targets, and because its scoring is objective.

### 5.1 The game

A rectangular grid contains some hidden **mines** and some empty cells. The
player reveals cells to learn how many mines are adjacent to each one.

**Standard difficulty settings:**

| Level | Grid | Mines | Density |
|---|---|---|---|
| Beginner | 9 × 9 | 10 | 12.3% |
| Intermediate | 16 × 16 | 40 | 15.6% |
| Expert | 30 × 16 | 99 | 20.6% |

**Objective:** reveal every non-mine cell. Revealing a mine ends the game
immediately.

### 5.2 Reveal rules

When a cell is revealed:

- **Numbered cell** — displays a count `0`–`8` of adjacent mines (orthogonal
  and diagonal, i.e. up to 8 neighbours).
- **Blank cell (`0`)** — no adjacent mines, so the reveal **floods**: all
  connected blank cells and their bordering numbered cells are revealed too.
- **Mine** — game over.

A cell's count is computed over its 8-neighbourhood, clipped at the grid edges.
Corner cells have 3 neighbours, edge cells 5, interior cells 8.

### 5.3 Flagging

The player may **flag** a cell as a suspected mine. Flags do not reveal
anything — they are the player's own annotation and carry no authority.

**In this eval, flags are ignored entirely.** The model reasons only from the
numbers. A flag cannot make a cell safe.

### 5.4 The deduction rules

This is the heart of the eval. Every safe move must follow from these.

**Rule 1 — the basic constraint.**
A revealed cell showing `N` means *exactly* `N` of its unrevealed neighbours
are mines.

**Rule 2 — saturated set.**
If a numbered cell shows `N` and has *exactly* `N` unrevealed neighbours, all
of them are mines.

**Rule 3 — subset elimination.**
If constraint A's unrevealed set is a subset of constraint B's, and A requires
all of its members to be mines, those members are removed from B's set and B's
count is reduced accordingly.

**Rule 4 — shared-neighbour exclusion.**
If two constraints both have a single unreveaved neighbour in common, and one of
them is already satisfied by known mines elsewhere, the shared cell is safe.

**Rule 5 — global mine-count.**
The total number of mines is known — the model receives it as the second
argument of `solve(board, mines)`. If all remaining unrevealed cells must
contain the remaining mine count, every one of them is a mine; and if the cells
next to the numbers must between them hold every remaining mine, every cell
away from the numbers is safe.

**Consequence:** a move is "certainly safe" if the constraint set proves at
least one unrevealed cell contains no mine. A correct solver returns such a
cell, or `null` when none exists.

### 5.5 Ambiguity — the case that needed a decision

Boards exist where **no move is logically certain**. Standard Minesweeper
resolves this by guessing with odds. This created a scoring problem: if a model
guesses and hits a mine, is that a reasoning failure or an unlucky coin flip?

**Resolution — two pools, split scoring:**

| Pool | Condition | Points | Measures |
|---|---|---|---|
| **A — Solvable** | Generated such that a certain-safe move always exists until the board is won | **40** | Pure deduction. No luck involved. |
| **B — Ambiguous** | Deduction reaches a position where no cell is provably safe | **10** | Knowing when to stop: a correct solver returns `null` there |

Pool A boards are generated by **rejection sampling**: generate, run an oracle
solver with backtracking, and keep only boards that are fully solvable without
guessing. This guarantees the 40 points contain zero luck.

**How Pool B is scored (decided in 0.2).** The prompt says "If no cell can be
proven safe, return null. Do not guess." Version 0.1 scored Pool B on *winning*,
which only a guess can do — so a model that obeyed the prompt perfectly scored
0/10 there, and 40/50 was the real ceiling. A dry run showed it: 60/60 Pool A
boards won, 0/60 Pool B.

A Pool B board now **passes on a correct stop**: the model plays proven moves up
to the stuck position, then returns `null`. Stopping earlier is a
`premature_surrender`; guessing there is an `unproven_move` or a `detonation`.
The pass condition is well defined because the set of cells reachable by pure
deduction does not depend on the order they are revealed in, so every correct
solver reaches the same stuck position.

### 5.6 Contamination and mitigation

The optimal Minesweeper solver is a **textbook algorithm** — constraint
propagation plus backtracking search. A model may reproduce it from memory
rather than deducing it.

Mitigations, in order of importance:

1. **Generated boards.** Layouts come from a seeded PRNG and need not appear in
   any training corpus.
2. **Non-standard density.** Pool A uses densities outside the three classic
   settings, so memorized strategy heuristics tuned for 9×9 do not transfer.
3. **Report the three tiers separately.** A memorized shallow solver does fine
   on Beginner and collapses on Expert. The gradient reveals recall.
4. **Fixed seed, published.** Anyone can regenerate the exact board pool and
   verify a submitted score.

Residual risk: a model that genuinely knows the textbook algorithm will score
well. That is acceptable — it is a real capability — but it is no longer a
measure of novel deduction, and the doc should say so rather than overclaim.

### 5.7 Random baseline

The DO eval reports survival rate **against a random-legal-move baseline**: at
each step, pick uniformly among all unrevealed non-flagged cells.

This baseline is computed by simulation at run time, over the Pool A boards
being scored — every playthrough replays the exact scored board, and only the
random moves vary — and is deterministic given the seed. (0.1 shifted the board
seed on every playthrough, so it measured 40 different boards per entry rather
than the pool.) It is not hardcoded, because a hardcoded
figure can drift from the board shapes it describes without anyone noticing.

**Measured survival is 0% on every tier.** Random play dies after 1–4 calls: it
clicks hidden cells with no regard for the numbers already visible, and on a
board with ~13% mine density that ends almost immediately.

An earlier revision of this document claimed ~11% / ~4% / ~1% for beginner /
intermediate / expert. Those figures were wrong, and the reason is instructive:
they assumed a first click with **no** cascade opening, so the board started
almost entirely hidden. This harness opens until a real information cascade
happens (see §6.6), which reveals a large region before random play takes its
first turn — and a region that is already open cannot be walked into a mine.
A baseline that survived ~11% of the time was measuring a weaker opponent than
the one actually being used.

The DO Index is therefore `model survival − 0` on every tier, which makes it a
clean statement: **any survival at all is deduction.** The index is still
reported per tier, because the *gradient* across tiers remains the interesting
signal — a model that handles the small boards and not the large ones has not
learned deduction, it has learned to look at small boards.



---

## 6. MONKEY DO — Minesweeper Solver

### 6.1 What the model writes

```js
solve(board, mines) -> { row: number, col: number } | null
```

- `board` is a 2D array, indexed `board[row][col]` from zero. Each cell is one of:
  - a number `0`–`8` — revealed
  - `null` — unrevealed
  - `'F'` — flagged (treated identically to `null`; flags carry no authority)
- `mines` is the total number of mines on the board.
- Returns a cell that is **logically guaranteed safe**, or `null` if none exists.
- Pure function. No state between calls. No randomness. The harness compiles
  the function afresh for every board.

**Not** "probably safe." The contract is *guaranteed*, and the harness checks
it on every move (§6.3).

**Why the mine count is given (0.2).** The oracle that certifies Pool A has
always used it (Rule 5). Without it in the prompt, 5 of 60 sampled Pool A boards
could not be won from the model's side, and "premature surrender" was judged
with information the model never had. Real Minesweeper displays the count.

### 6.2 The exact prompt

```
You are a Minesweeper solver. You will be given the current visible board and
the total number of mines on it.

Rules:
- board[row][col] is zero-based. Each cell is a number 0-8 (revealed), null
  (unrevealed), or 'F' (flagged). Flags are annotations only and prove nothing.
- A revealed number N means exactly N of its unrevealed neighbours are mines.
- Neighbours are the up to 8 surrounding cells.
- mines is the total number of mines on the board. Every mine is unrevealed.
- Fractions are not possible. If no unrevealed cells remain, return null.

Write a JavaScript function:

  solve(board, mines) -> { row, col } | null

It must return a cell that is LOGICALLY CERTAIN to be safe, derived from the
numbers and the mine count. If no cell can be proven safe, return null.
Do not guess.

Output only the code, no explanation.
```

The 0.1 prompt gave no mine count and never said how cells are indexed, so a
model returning 1-based coordinates was scored as a broken solver.

No examples are provided. The rules of the game are stated in full; the
*reasoning* is what gets tested.

### 6.3 The harness loop

```
for each board in pool:
  board = replay(seed, tier, attempt)  # mines + cascade opening, from pool.json
  while not won:
    if calls >= capForTier(tier): record stalled; break
    move = solve(visible, mines)
    if move is null:
      record premature_surrender if the oracle can prove a move, else surrender
      break
    if not is_legal(move): record protocol_violation; break
    if is_mine(move):      record detonation; break
    if not provable(move): record unproven_move; break   # safe, but a guess
    reveal(move)                        # flood-fill if it was blank
  record won
```

**The outcomes, all auto-scored:**

| Outcome | Meaning |
|---|---|
| `won` | Board cleared, every move proven safe |
| `surrender` | Returned `null` where no cell was provable — **correct** on Pool B |
| `premature_surrender` | Returned `null` while a provable move existed — an omission |
| `detonation` | Returned a cell that was a mine — **a reasoning failure** |
| `unproven_move` | Returned a cell that happened to be safe but could not have been proven — the same failure, without the bad luck |
| `protocol_violation` | Returned an out-of-bounds, already-revealed or malformed cell, or threw |
| `stalled` | Hit the effort cap; a correct solver never does |

Every move is judged by `verifyMove` in `oracle.mjs`, using exactly the visible
grid and mine count the model had. When the oracle's search runs out of budget
the model gets the benefit of the doubt, and the report counts the move as
unverified.

`detonation` and `surrender` are scored differently. Detonation is confident
error. Surrender is caution. Conflating them — as a naive survival metric would
— punishes careful models and rewards reckless ones identically.

### 6.4 Scoring — 50 points

| Component | Points | Formula |
|---|---|---|
| Pool A — won | 30 | `(A_won / A_total) * 30` |
| Pool A — no confident error | 10 | `(A without detonation, unproven_move or protocol_violation / A_total) * 10` |
| Pool B — correct stop | 10 | `(B_surrender / B_total) * 10` |
| **Total** | **50** | |

`unproven_move` forfeits the 10 like a detonation does: it is the same act —
claiming certainty the position did not support — and Pool A promises zero
luck, so the dice must not change the score.

Pool A is split into two components deliberately. A model that returns `null`
immediately every time has a 100% survival rate and 0 information. The
no-detonation component alone cannot distinguish this from real play, so the
30/10 split rewards *winning* over *not losing*.

### 6.5 The DO Monkey Index

```
DO INDEX = (model survival %) - (random baseline survival %)
```

Reported per tier, because a model that only handles Beginner has not learned
deduction — it has learned to look at small boards.

Computed on Pool A only, per tier. Pool B is broken out separately in every
report; 0.1 grouped both pools under the same tier names, so a perfect solver
showed "won 50%" on every tier.

| Tier | Random baseline (measured) |
|---|---|
| `poolA-small` (11×13, 18 mines) | 0% |
| `poolA-medium` (14×17, 35 mines) | 0% |
| `poolA-large` (19×23, 62 mines) | 0% |

### 6.6 Board pool specification

| Pool | Condition | Measures |
|---|---|---|
| **A — Solvable** | A correct solver wins it: every step deducible, no guessing | Pure deduction. Zero luck. |
| **B — Ambiguous** | A guess is genuinely required at an endgame position | Calibrated risk-taking |

**Fixed seed:** `0x5EED`. Anyone regenerating the pool must get byte-identical
boards. This is what makes submitted scores verifiable.

**The published pool (0.2): 450 boards** — 100 Pool A and 50 Pool B boards on
each of the three tiers — stored in `src/do/minesweeper/pool.json` by
`scripts/gen-pool.mjs`. Generation takes about two minutes (Pool B accepts only
6–19% of candidates, because most boards turn out to be winnable), and
regeneration is byte-identical. Every load verifies the generator fingerprint,
every board's replayed layout, and the list digest; `npm run check-pool`
regenerates the whole pool and compares it byte for byte. 450 rather than 1,000
because each model run replays the solver on every board with every move
verified: 450 keeps a run to a few minutes at 0.1 points per Pool A board.

**Oracle completeness (0.2).** Two gaps were closed, and `GENERATOR_VERSION`
records the change:

- The oracle never tried cells away from the numbers as candidates, so it missed
  endgame deductions from the mine count (two disjoint clues that use up every
  remaining mine make all interior cells safe). 2 of 60 sampled Pool B boards
  were winnable. It now tries one such cell as a representative of all of them.
- A search that ran out of budget on its *last* candidate was reported as
  conclusively ambiguous. It is now inconclusive, and the board is discarded.

#### What measurement changed

Two things in this section were wrong, and both were found by running real
boards rather than by reasoning about them.

**1. The effort cap was binding on the oracle itself.**

A cap of 24 calls was chosen for a 9×9 beginner board and applied unchanged to
the much larger shapes Pool A uses. Measurement on `poolA-small` (143 cells):

| Outcome | Share |
|---|---|
| **Hit the call cap** | **85%** |
| Won outright | 9% |
| Ambiguous / hard stall | the rest |

So the "9% acceptance" first measured was not a property of Minesweeper. It was
a property of my cap. The boards were not reaching an endgame ambiguity; they
were running out of budget, which is a different thing entirely — and calling it
"genuine ambiguity" would have been a serious error in the design.

The cap is now derived from board size:

```js
calls = max(24, ceil(nonMineCells / 4) + 8)
```

Re-measured on `poolA-small`:

| Outcome | Before | After |
|---|---|---|
| Won outright | 9% | **68%** |
| Hit the cap | 85% | 23% |

Median calls on a won board is **32**, against the old cap of 24. The oracle was
being cut off on boards it could otherwise solve.

**2. The opening move was giving away nothing.**

`openBoard` originally revealed one random cell, which made 48 of 100 boards
ambiguous at step 0 — the model was handed a position with nothing to deduce
from, because one click on a sparse board usually sits next to no mines.

| Opening strategy | Ambiguous at step 0 |
|---|---|
| one random cell | 48 / 100 |
| retry until a cascade | **3 / 100** |

Still seeded randomness, still reproducible, free at runtime.

#### Consequence: the pool spec is now workable

With 68% acceptance on the small tier, a large Pool A is a few thousand
candidate boards, not tens of thousands. Pool A now accepts 81–90% of candidates
per tier; Pool B, which needs a genuine endgame, accepts 6–19%, and dominates
generation time (about two minutes for the published 450 boards). That cost is
paid once, by `gen-pool`, not on every run.

#### The cap, derived across all three tiers at once

An effort cap is required, or a stuck solver loops forever. Getting it wrong is
worse than not having one, because **the failure is invisible in the output** —
boards get rejected, acceptance drops, and it reads as "this model is bad at
Minesweeper" when it is really the harness refusing to let the model finish.

It was wrong twice, both times by being fitted to one tier:

| Version | Value | Consequence |
|---|---|---|
| v1 | hardcoded `24` | 256 of 300 `poolA-small` boards hit the cap. Read as "a correct solver does not win most Minesweeper boards." It was not. |
| v2 | `ceil(safe/4) + 8`, fitted to small's median | Fixed small (9% → 68% won) and **silently broke the other two**: 13 of 20 `poolA-medium` boards capped out. |
| **v3** | `max(24, ceil(safe/2) + 12)` | 0 boards capped on any tier. |

v3 was fitted by measuring true call counts against an **unbounded** cap, so the
requirement was measured rather than inferred:

| Tier | Safe cells | Median calls | p95 | Max | Implied cells/call |
|---|---|---|---|---|---|
| `poolA-small` | 125 | 33 | 52 | 52 | 3.79 |
| `poolA-medium` | 203 | 74 | 96 | 96 | **2.74** |
| `poolA-large` | 375 | 105 | 135 | 135 | 3.57 |

The medium tier is the tightest at 2.74 cells per call, so the divisor is set to
**2** — below the worst tier, not at some tier's median. Headroom of 12 covers
the median-to-p95 spread.

**With the cap removed entirely, every tier wins the large majority: 18/20,
15/20, 7/8.** The boards were always solvable. The cap was rejecting them.

Re-measured with the v3 cap:

| Tier | Won | Endgame | Hard stall | Capped | ms/board |
|---|---|---|---|---|---|
| `poolA-small` | **93%** | 1 | 0 | **0** | 20 |
| `poolA-medium` | **73%** | 2 | 2 | **0** | 63 |
| `poolA-large` | **80%** | 3 | 0 | **0** | 293 |

Capped is zero everywhere, so the remaining non-wins are genuine: endgames where
a coin flip is required, and a few hard boards.

#### The harness must not be able to drift from the pool

`capForTier(tier)` is the single source of the cap, and `do/run.mjs` must call it
rather than recomputing anything. If the harness had its own copy of the
formula, a future change to `CELLS_PER_CALL` would silently produce pools full
of boards the oracle can win but the model is never allowed to finish — Pool A
would be measuring the cap instead of reasoning.

A test asserts the two stay equal for every tier, and that `capForTier` rejects
an unknown tier name instead of falling back to the floor (a typo would cap a
437-cell board at 24 calls, which is v1's bug).

#### "Ambiguous" still needs disambiguating

The stalling boards split by how much is left hidden:

| Cells left when stuck | Reading | Pool |
|---|---|---|
| 19–26 of 143 (13–18% hidden) | a real endgame coin flip | **B** |
| 101–132 of 143 (71–92% hidden) | a *hard* board, not an ambiguous one | rejected |

A solver that gives up with 90% of the board hidden has not reached a coin flip;
it has hit a wall it cannot climb. Filing those into Pool B would pad the
"ambiguous" set with boards a stronger solver would win, and Pool B's entire
claim is that guessing is *required*. Boards above the threshold (default: 40%
hidden) are rejected rather than mislabelled.

**Re-measured under the v3 cap and the 0.2 oracle,** while generating the
published pool: hard stalls are real, not cap artefacts. No candidate on any
tier hit the cap or was unclassifiable, and the hard stalls rejected from Pool B
were 36 of 853 candidates on the small tier, 16 of 347 on medium, and 8 of 266
on large.

#### Three outcomes, not two

The oracle distinguishes three cases, and collapsing any two of them would be a
silent corruption of the pool:

| Outcome | Meaning | Pool |
|---|---|---|
| `deducible` | A certain-safe move was proven | A |
| `ambiguous` | Search finished, found nothing — guessing is required | B (if endgame) |
| `inconclusive` | Search **hit its budget** — we do not know | neither, discard |

`inconclusive` is the one that matters. Pool B asserts that no safe move exists.
An exhausted search has not proven that; it has merely failed to disprove
safety. Treating it as ambiguous would let a too-small budget quietly
manufacture ambiguity — which is exactly the mistake described in point 1 above,
and it would have recurred here if the distinction had not been kept.

### 6.7 Effort cap

The cap is `capForTier(tier) = max(24, ceil(safeCells / 2) + 12)` — 75, 114 and
200 calls on the three tiers — the single value shared by pool generation and
the harness (§6.6). A solver that hits it is recorded as `stalled`.

It is generous for any correct solver, not just the oracle's own move order:
replaying Pool A boards with a solver that always takes the *highest*-index
proven cell (the opposite of the oracle) needed at most 55, 89 and 136 calls.



---

## 7. Tech Stack

### 7.1 Language and runtime

| Choice | Rationale |
|---|---|
| **Node.js ≥ 20** | Ships a built-in test runner, `fetch`, and `node:vm`. No build step. |
| **ESM** (`"type": "module"`) | The harness is small; ESM avoids `require` interop awkwardness with `node:vm`. |
| **Zero runtime dependencies** | Deliberate. See below. |

**Why zero dependencies is a design requirement, not asceticism:**

The accessibility claim — "anyone can run this against any model, including a
local one" — collapses if the suite needs a 200MB `node_modules`. Most
providers speak the OpenAI wire protocol, so one hand-written adapter covers
OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio, and Ollama. Everything else
is `node:test`, `node:vm`, and `fetch`.

The only sanctioned dependency is **`vitest`** (dev, optional) if the team
prefers it over the built-in runner. The harness must work without it.

### 7.2 Module map

| Module | Responsibility |
|---|---|
| `adapters/openai.mjs` | Any OpenAI-compatible `/v1/chat/completions` endpoint |
| `adapters/ollama.mjs` | Local models via `http://localhost:11434/api/chat` |
| `adapters/registry.mjs` | Model-string resolution from `config/models.json` and presets; adapter dispatch |
| `sandbox.mjs` | `node:vm` execution with timeout, code extraction, silent console |
| `cli.mjs` | Shared runner plumbing: arguments, temperature rule, keys, self-test gate |
| `self-test.mjs` | Validates the eval itself — see §8.3; runners call it before scoring |
| `prompt-digests.mjs` | Recorded SHA-256 of every prompt |
| `see/reference.mjs` | Ground truth for all three tasks — **never sent to a model** |
| `see/tasks/*.json` | Examples and held-out inputs, data-only |
| `see/run.mjs` | SEE harness: prompt → call → sandbox → score |
| `do/minesweeper/board.mjs` | Board generation, reveal, flood-fill, mine counting |
| `do/minesweeper/pool.mjs` | Seeded rejection sampling, the published pool and its verification |
| `do/minesweeper/pool.json` | The published 450-board pool |
| `do/minesweeper/oracle.mjs` | Ground truth for "provably safe": pool filtering and move verification |
| `do/reference-solver.mjs` | The oracle's logic as sandbox source, for the dry run |
| `do/score.mjs` | DO scoring and the random baseline |
| `do/run.mjs` | DO harness: board loop → score |
| `report.mjs` | JSON reports, including the combined report and the limitations |
| `run-all.mjs` | Both evals against one resolved model |

### 7.3 Reproducibility requirements

Every report embeds:

- model identifier, exactly as passed
- `temperature: 0`, and confirmation that the adapter honoured it
- a SHA-256 hash of the exact prompt sent
- the seed (`0x5EED`) and pool digest
- timestamp

**If a provider cannot guarantee `temperature: 0`, the report must say so**
prominently. A model sampled at `temperature: 1` is a different experiment, and
a score from it is not comparable to one sampled at 0. This is the single
biggest threat to the suite's validity and must never be papered over.

### 7.4 Project structure

```
guide.md                       ← this file
evals/
├── README.md                  ← quickstart
├── package.json
├── config/
│   └── models.example.json    ← copy to models.json: model registry, endpoints, flags
├── src/
│   ├── adapters/              ← openai.mjs, ollama.mjs, registry.mjs
│   ├── sandbox.mjs
│   ├── cli.mjs
│   ├── self-test.mjs
│   ├── prompt-digests.mjs
│   ├── report.mjs
│   ├── run-all.mjs
│   ├── see/
│   │   ├── reference.mjs
│   │   ├── tasks/             ← taskA.json, taskB.json, taskC.json
│   │   ├── tasks.mjs, prompt.mjs, score.mjs, key.mjs, fingerprint.mjs
│   │   └── run.mjs
│   └── do/
│       ├── prompt.mjs, score.mjs, reference-solver.mjs
│       ├── run.mjs
│       └── minesweeper/
│           ├── board.mjs
│           ├── pool.mjs
│           ├── pool.json
│           └── oracle.mjs
├── scripts/
│   ├── self-test.mjs          ← validates the evals (--full regenerates the pool)
│   ├── gen-pool.mjs           ← regenerates / checks the fixed board pool
│   ├── acceptance.mjs         ← the publication gate, §9.1
│   └── show-prompts.mjs, diagnose.mjs, providers.mjs
├── tests/
│   ├── *.test.mjs             ← node:test unit and end-to-end tests
│   └── fixtures/stub-fetch.mjs
└── results/                   ← gitignored
    └── <model>-<date>.json, do-<model>-<date>.json, combined-<model>-<date>.json
```

`src/see/reference.mjs` is kept physically separate from the prompt construction
code so that a reviewer can confirm the ground truth is never interpolated into
a prompt. This is the main integrity risk in the suite and the separation makes
it auditable at a glance.

## 8. Build Instructions

### 8.1 Prerequisites

- Node.js ≥ 20 (`node --version`)
- A model reachable over HTTP — API key, or a local Ollama install
- No compiler, no bundler, no framework

### 8.2 Setup

```bash
cd evals
cp config/models.example.json config/models.json   # optional: presets cover openrouter/, openai/, ollama/
```

There is nothing to install. `config/models.json` shape (an exact `models` entry
wins; otherwise a `providers` entry matching the prefix supplies everything but
the model name; otherwise a built-in preset):

```json
{
  "models": {
    "openai/gpt-4o": {
      "adapter": "openai",
      "endpoint": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY",
      "supportsTemperatureZero": true
    },
    "ollama/qwen2.5-coder:7b": {
      "adapter": "ollama",
      "endpoint": "http://localhost:11434/api/chat",
      "model": "qwen2.5-coder:7b",
      "supportsTemperatureZero": true
    }
  }
}
```

`supportsTemperatureZero: false` causes the runner to **refuse to record a
score** without an explicit `--i-cannot-control-temperature` flag, omits the
temperature parameter from requests (such endpoints reject it), and stamps the
result as not comparable. `null` means unknown until a `--runs 3` check. The
flag name is deliberately awkward so it is not passed casually.

### 8.3 Validate the harness before trusting any score

```bash
node scripts/self-test.mjs
```

This must pass before any model is evaluated. It checks, in order:

1. **Ground truth correctness** — `reference.mjs` produces the documented values
   for every documented example and held-out case.
2. **Naive baseline band** — each task's naive implementation scores between
   **20% and 45%**. Outside that band the eval is miscalibrated and the task is
   rejected.
3. **Naive < perfect** — the reference implementation scores 100% on all
   held-out cases.
4. **Shown examples expose the rule** — the naive implementation must **fail**
   at least one shown example per task. Verified values are 5/8, 5/8, and 4/8.
   If the naive implementation scored 100% on the shown examples, the examples
   would not be demonstrating the rule and must be redesigned. This is the
   polarity that makes the eval meaningful: shown examples that a mimic can pass
   carry no information.
5. **Board pool integrity** — regeneration from seed `0x5EED` reproduces a
   byte-identical pool, and every Pool A board is solvable without guessing.
6. **Sandbox containment** — an infinite loop times out in <1.2s; code calling
   `require` is rejected.
7. **Prompt hashes** — all three SEE prompts and the DO prompt match the
   recorded digests.

Current SEE digests (SHA-256 of the exact prompt text, no trailing newline):

| Prompt | SHA-256 |
|---|---|
| A | `043dd2b70723e976d24c623ae66b9304e7d299d6d37e38198f86a8b0b113e3da` |
| B | `4f200996b3e215e5146455aba6ab22135e8eae4a0fffe48541c110b6057c18fc` |
| C | `2e2bcf3413e5f02ca5ebbd05c2a367fbd90ba22dce5c5a6f529c62ee5186a728` |
| DO | `f2f520b6f29679abaa8ab0b659bb26c66358dbea912cde637cf29b027e28173c` |

They are pinned in `src/prompt-digests.mjs`, and check 7 compares against them.
Regenerate and inspect with `node scripts/show-prompts.mjs`. The DO digest
changed in 0.2 (the prompt gained the mine count and indexing), before any
model was scored. These are recorded
now, before any model has been scored, so that a later digest mismatch means the
prompt changed rather than that a reconstruction drifted. Every report embeds
the digests actually used.

Every runner (`see`, `do`, `run-all`, `acceptance`) runs the self-test before
contacting a model. A failing self-test blocks scoring. There is no override.
`npm run self-test -- --full` adds the slow check: regenerating the whole board
pool and comparing it byte for byte.

### 8.4 Run

```bash
# Both evals
node src/see/run.mjs --model openai/gpt-4o
node src/do/run.mjs  --model openai/gpt-4o

# Or together, three times for the stability check
node src/run-all.mjs --model openai/gpt-4o --runs 3 --out results/

# Local model
node src/run-all.mjs --model ollama/qwen2.5-coder:7b

# Verify the DO harness end to end without a model (must print PASS and 50/50)
node src/do/run.mjs --dry-run
```

### 8.5 Regenerating the board pool

```bash
node scripts/gen-pool.mjs --seed 0x5EED --out src/do/minesweeper/pool.json
node scripts/gen-pool.mjs --check      # regenerate in memory, compare byte for byte
```

Deterministic. Running it twice must produce identical bytes. If it does not,
the generator has a bug and the published baseline is invalid. Any change to
the oracle or to pool classification must bump `GENERATOR_VERSION` in
`pool.mjs`; a pool built by a different generator is refused on load.

---

## 9. Self-Validation

### 9.1 The eval must be able to detect a bad model

The suite's own quality is measured by whether it discriminates. Minimum
acceptance criteria before publication:

| Test | Requirement |
|---|---|
| Discriminates strong from weak | A known-strong model outscores a 7B model on both evals |
| Naive baseline lands in band | 20–45% on every SEE task |
| Random baseline lands in band | DO random survival is 0% on every tier (§5.7) |
| Oracle reaches 100% | The reference solver wins every Pool A board and stops correctly on every Pool B board: a dry run scores 50/50 |
| Variance is low | Three runs at `temperature: 0` differ by ≤ 2 points |
| Self-test passes | All seven checks in §8.3, including the full pool regeneration |

`npm run acceptance -- --strong <model> --weak <model>` runs every criterion and
writes `results/acceptance-<date>.json`. `--quick` rehearses on a subset and can
never report a pass.

If any criterion fails, the eval is not published. An eval that does not
discriminate is worse than no eval, because it manufactures false confidence.

### 9.2 Known limitations

Stated plainly, because a design doc that only lists strengths is not a design
doc.

1. **SEE saturates.** Frontier models reach high scores and the eval stops
   discriminating at the top. Most useful for the mid tier.
2. **Task B's adversarial bucket has been rebuilt.** The original used uppercase
   vowel-initial words, which the naive implementation answered correctly by
   coincidence. It is now lowercase vowel-initial and scores 2/15 against the
   naive implementation. Resolved in this revision; see §4.5 and §4.9.
3. **DO has residual contamination risk.** The textbook solver is memorizable.
   Mitigations in §5.6 reduce but do not eliminate this.
4. **Neither eval tests software engineering.** No file editing, no tool use, no
   multi-step debugging. These complement SWE-bench-style testing and must never
   be presented as replacing it.
5. **Two evals is a small sample of capability.** These measure inference and
   deduction. They say nothing about arithmetic reliability, multilingual
   ability, or factual recall.
6. **The 50-point scales are hand-weighted.** The weights are defensible but not
   canonical. They must be **frozen** before publication, or scores stop being
   comparable across runs.
7. **This document shipped with three calculation errors, all now fixed.** They
   are recorded because they are the argument for the self-test existing:
   - Task B's naive baseline was documented as 40% and was actually 70%; Task
     C's was documented as 38% and was actually 62%. Both held-out sets have
     been rebuilt (§4.5, §4.6).
   - Task C's shown example `f([-1,0,-1])` was documented as `0`, which is the
     *largest* distinct value rather than the second largest. The correct answer
     is `-1`. The stated rule and the stated example contradicted each other,
     and no amount of reading would have caught it — only executing it did.
   - §4.8's Monkey Index compared `SEEN` = 8 against `HELD-OUT` = 150. Both
     arms now pool all three tasks (24 vs 150).

   None of these would have been found by review. They were found by running
   the numbers, which is why `scripts/self-test.mjs` now asserts every one of
   them on every run.
8. **The first implementation shipped with eight more, found by an audit that
   ran the code rather than reading it.** All fixed in 0.2, each with a
   regression test:
   - Every real `do/run.mjs` run crashed after scoring ("source is not
     defined") and saved no report. Only the dry run and `run-all` worked.
   - Pool B was scored on wins, which only a guess can produce, while the
     prompt forbids guessing: the real ceiling was 40/50 (§5.5).
   - The oracle used the mine count, which the prompt never gave the model: 5
     of 60 sampled Pool A boards were unwinnable from the model's side (§6.1).
   - Per-tier figures mixed Pool A and Pool B, so a perfect solver showed
     "won 50%" on every tier and the DO Index was meaningless (§6.5).
   - An unusable SEE response was dropped from the held-out arm and the
     robustness bonus: Monkey Index −33 and a full bonus (§4.7).
   - `console` was undefined in the sandbox, so a trailing `console.log`
     voided a correct answer; and DO called a helper named `f` instead of
     `solve` (§4.10).
   - The oracle missed global-count endgames (2 of 60 Pool B boards were
     winnable) and reported a budget-exhausted final search as conclusively
     ambiguous (§6.6).
   - The random baseline replayed different boards from the ones scored (§5.7).

   Found alongside them: the pool digest hashed `{ ...poolA, ...poolB }`, which
   lets Pool B overwrite Pool A's same-named tiers, so it covered Pool B alone;
   and the key loader read a whole `.env` file as the key.



## 10. Output Format

### 10.1 Console

Illustrative figures, not a real result.

```
🐒 MONKEY SEE · openai/gpt-4o · 2026-09-29

  Task A    held-out  43/50   86%    [████████████████░░░░]
  Task B    held-out  47/50   94%    [███████████████████░]
  Task C    held-out  38/50   76%    [██████████████░░░░░░]

  robustness  +5.0   (no throws in 150)

  SEEN 100%   HELD-OUT 85%
  🐒 MONKEY INDEX  15                        (mostly reasoned)
                                                42/50

────────────────────────────────────────────────

🐒 MONKEY DO · openai/gpt-4o · 2026-09-29

  Pool A · solvable      300 boards
    won                   84%   [█████████████████░░░]
    no confident error    97%
  Pool B · ambiguous     150 boards
    stopped correctly     62%   [████████████░░░░░░░░]

  Pool A by tier (the DO Index is the gap to random play)
    poolA-small    won  96%   det 1%  guess 0%  gave up 3%  (random 0%)
    poolA-medium   won  85%   det 2%  guess 1%  gave up 12% (random 0%)
    poolA-large    won  71%   det 4%  guess 2%  gave up 23% (random 0%)

                                                41/50

════════════════════════════════════════════════

  SEE 42/50  ·  DO 41/50  ·  combined 83/100

  💬 This model reasons past the shown examples (index 15) and
     wins 71% of the large boards, where random play wins none.
```

### 10.2 Machine-readable

`results/<model>-<date>.json` (SEE) and `results/do-<model>-<date>.json` (DO)
contain every number, the prompt hashes, the pool digest and seed, the
temperature statement, and per-case or per-board outcomes, so any claim can be
re-derived. `run-all` also writes `results/combined-<model>-<date>.json`.

### 10.3 Report structure

Reports must state, in this order: model, date, temperature guarantee, SEE
score + index, DO score + baseline gap, both limitations (saturates / not a
coding benchmark), and the combined total. A report omitting the limitations is
invalid, regardless of the scores. The combined report follows this order
exactly; every report carries the full limitations list, and the console
prints it after every run.

---

## 11. Roadmap

| Phase | Deliverable | Blocking? | Status |
|---|---|---|---|
| 1 | `reference.mjs` + task JSON + self-test checks 1–4 | Yes — nothing is valid without it | Done |
| 2 | `sandbox.mjs` + adapters + `see/run.mjs` | Yes — SEE must be runnable | Done (OpenAI-compatible + Ollama) |
| 3 | Minesweeper `board.mjs` + `pool.mjs` + `oracle.mjs` | Yes — DO needs a correct pool | Done; pool published |
| 4 | `do/run.mjs` + baseline | Yes | Done |
| 5 | `report.mjs` + JSON output | No | Done, incl. combined report |
| 6 | Acceptance run against 2–3 known models | **Yes — publication gate** | Script built (`npm run acceptance`); **not yet run** |
| 7 | Public board pool + leaderboard README | No | Pool published in-repo; README written; no leaderboard yet |

Phase 3 is the highest-risk phase: board generation with correct flood-fill,
correct 8-neighbour counting at edges, and deterministic rejection sampling are
where subtle bugs live. Budget the most time there.

---

## 12. Success Criteria

The project is done when:

1. `node scripts/self-test.mjs` passes all seven checks on a clean checkout.
2. A model can be evaluated end-to-end with one command and no arguments beyond
   its identifier.
3. Two models produce clearly separated scores, and the ranking is stable across
   three runs.
4. The board pool regenerates byte-identically from seed `0x5EED`.
5. A stranger can clone the repo, add a model to `config/models.json`, and get a
   comparable score without asking a question.
6. Every published report carries its limitations.

**Criterion 5 is the real test.** If adding a model requires understanding the
code, the accessibility goal has failed and the zero-dependency design was
wasted.

---

## 13. Open Questions

Resolved in 0.2: the effort cap scales with board size (§6.7); pool size is 450
boards (§6.6); Pool B is scored on a correct stop (§5.5); multi-sample runs are
opt-in (`--runs 3`) for normal scoring and required by the acceptance gate.
Still open:

1. ~~**Effort cap for DO.**~~ Resolved: `max(24, ceil(safeCells / 2) + 12)`.
2. **Should Task B stay at three buckets?** Its adversarial bucket is now
   discriminating (2/15 against the naive implementation). Resolved this
   revision. Open sub-question: the boundary bucket still contains 6/15 cases
   the naive answer gets right, mostly single consonants. Tighten or accept?
3. **Should surrender be penalised on Pool A?** Currently it costs the win
   component but not the no-detonation component. A model that always returns
   `null` scores 10/50 (it gets nothing on Pool B, where stopping early is
   premature). Is that the intended floor?
4. ~~**Board pool size.**~~ Resolved: 450 boards (§6.6).
5. ~~**Multi-sample runs.**~~ Resolved: opt-in for scoring, required by the gate.
6. **Weights are not yet frozen.** §9.2 item 6 requires freezing the 50-point
   weights before publication. The reports state "frozen at suite version
   0.2.0"; treat any change after the acceptance run as a new suite version.

---

*End of design document. The implementation lives in `evals/`; where this
document and the code disagree, the code's tests are the tie-breaker and this
document should be corrected.*

---
