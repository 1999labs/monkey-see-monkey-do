---
pretty_name: Monkey See / Monkey Do — suite 2.1.0
license: mit
language:
- en
task_categories:
- text-generation
size_categories:
- n<1K
tags:
- evaluation
- synthetic
- rule-induction
- program-synthesis
- string-rewriting
- javascript
- code
configs:
- config_name: see_tasks
  default: true
  data_files:
  - split: test
    path: data/see_tasks.jsonl
- config_name: see_prompts
  data_files:
  - split: test
    path: data/see_prompts.jsonl
- config_name: do_chains
  data_files:
  - split: test
    path: data/do_chains.jsonl
- config_name: do_systems
  data_files:
  - split: test
    path: data/do_systems.jsonl
---

# Monkey See / Monkey Do — suite 2.1.0

A deterministic, synthetic evaluation dataset for two narrow tasks:
**Monkey See (SEE)** measures identification of a rule from examples within a
specified finite hypothesis class. **Monkey Do (DO)** measures the quality of
JavaScript solver programs for string-rewrite systems.

This package contains the frozen suite **2.1.0** task sets, exact prompts, rule
definitions, reference programs and answers, and provenance. Intended Hub repository:
`noahmclaughlin/monkey-see-monkey-do`. Noah McLaughlin is the repository's named
copyright holder; the dataset publisher is `noahmclaughlin`.

This is evaluation material, including public answer keys. The `test` designation
identifies the evaluation split; it does not mean the contents are secret or
uncontaminated. There is no training or validation split. Training on this package
invalidates claims that a subsequent score measures unseen-task performance.

## Contents and loading

| Configuration | Test rows | Unit |
|---|---:|---|
| `see_tasks` | 12 | One rule instance; 16 shown and 50 held-out examples with reference answers |
| `see_prompts` | 48 | One instance at one sample level (2, 4, 8 or 16) |
| `do_chains` | 60 | One start/target pair with a reference derivation |
| `do_systems` | 3 | One rule system, exact solver prompt and reference solver |

SEE has six families, each with two instances: threshold arithmetic, modular
arithmetic, conditional string transforms, rotations, distinct order statistics,
and array filtering with ordering. Across instances there are 192 shown examples
and 600 held-out examples. DO has growth, reversible swaps and reductions, with
four chains per system at each shortest-distance band 5, 10, 20, 30 and 50.
Rows across configurations are related records, not independent observations.

After publication:

```python
import json
from datasets import load_dataset

repo = "noahmclaughlin/monkey-see-monkey-do"
tasks = load_dataset(repo, "see_tasks", split="test")
prompts = load_dataset(repo, "see_prompts", split="test")
chains = load_dataset(repo, "do_chains", split="test")
systems = load_dataset(repo, "do_systems", split="test")

example = tasks[0]["held_out_examples"][0]
input_value = json.loads(example["input_json"])
reference_answer = json.loads(example["output_json"])
```

For a local download, replace `repo` with the package directory. To reproduce a
published experiment, also pin `revision` to its Hub commit and record the source
suite and pool hashes. Loading this dataset does not execute its JavaScript.
The Python `datasets` library is optional; JSONL files can be read directly.

## Schema

All four configurations carry `suite_version`, `pool_sha256` and `source_commit`.

**SEE tasks:** `task_id`, `family_id`, `input_type`, `hypothesis_class`,
`target_candidate_index` (zero-based index into `rules.json`),
`reference_function_js`, `shown_examples` and `held_out_examples`.
Each example has a zero-based `index`, `input_json` and `output_json`.
Mixed integers, strings, arrays and null answers are encoded as JSON **strings**
to keep a stable Arrow schema. Decode them with `json.loads`; the string `"null"`
represents a null answer, not a missing label. Shown example order is significant.

**SEE prompts:** `task_id`, `family_id`, `sample_level`,
`contributes_to_headline`, `prompt`, `prompt_sha256` and
`compatible_candidate_count`. Use the exact `prompt` field as model input.
Do not include the task's selected candidate, reference code or held-out answers.

**DO chains:** `chain_id`, `system_id`, `shortest_distance`, `band`, `start`,
`target` and `reference_steps`. Each step has `rule` (rule ID), `start` (zero-based
substring position), and `next` (the complete resulting string). A step's `start`
is an integer position, distinct from the chain's `start` string.

**DO systems:** `system_id`, `rules`, `prompt`, `prompt_sha256`,
`reference_solver_js` and `chain_count`. Each rule has `id`, `from` and `to`.
Only one matching substring is rewritten per move; other characters are inert.
Rule IDs are scoped to the system. Join chains to systems by `system_id`.

`rules.json` includes all six SEE candidate classes, all candidate JavaScript
functions, naive baselines, and all DO rule definitions. Reference functions and
solvers are executable JavaScript source strings; they are not model responses.
`source/pool.json` and `source/prompt-digests.json` preserve the exact source files.

## Evaluation protocol and scoring

A full repeat makes **51 model calls**: 48 SEE calls and **three DO calls**.
For DO, the model receives one general solver prompt per system, returns a
`solve(start, target)` program, and the harness executes it on that system's 20
chains. Supplying individual chain pairs to the model would be a different task.

SEE's headline is **50 × mean held-out accuracy at level 16**, equally weighted
across the 12 instances. Earlier levels are diagnostics only. Their examples
preserve multiple plausible candidates through level 8; level 16 identifies a
unique candidate within the declared class. Held-out witnesses independently
separate the target from every incorrect declared candidate. Inputs are unique
and shown/held-out sets are disjoint **within each instance**; no disjointness
between different instances or families is promised.

DO's headline is **50 × mean solved fraction**, balanced across systems and
bands. Full credit requires all moves to be legal and the final string to equal
the target. Any valid complete derivation is accepted, including a different or
longer path than the stored reference. Legal prefixes earn zero. Limits: 1000
moves, intermediate strings of at most 128 characters, and 3000 ms execution per
chain. SEE uses 1000 ms per input. Each invocation gets a fresh JavaScript context.
The reference search's 100000-state stopping threshold is a reference algorithm
choice, not an extra restriction on model programs.

There is **no adjusted or combined headline score**. Non-throwing rate and the
shown-minus-held-out gap are diagnostics. Unusable programs retain their case
denominators. API failures are missing measurements, not model zeros. Record
provider, reasoning effort, sampling settings, effective API/output budgets and
runtime alongside any results. Pin routed providers when measuring a hosted model.

Use the [source scoring specification](https://github.com/1999labs/monkey-see-monkey-do/blob/6b1a6be1975561240edfd4dffab77236b036798e/docs/scoring-detail.md)
and harness for comparable measurements; this dataset is not a replacement scorer.
No empirical model-performance results or downstream validity claims are included.

## Generation, references and provenance

Data were generated programmatically, without human annotators or model-generated
labels, from seed `0xC0FFEE` (12648430), generator version `2.1.0`.
SEE selects two candidate rules per family, reserves held-out discriminating
witnesses, and constructs controlled ambiguous prefixes. Its reference answers
are computed from the selected functions. DO chains are constructed for the five
bands, independently solved with bidirectional BFS, and replay-verified.

- Source repository: [1999labs/monkey-see-monkey-do](https://github.com/1999labs/monkey-see-monkey-do)
- Frozen source commit: [`6b1a6be1975561240edfd4dffab77236b036798e`](https://github.com/1999labs/monkey-see-monkey-do/tree/6b1a6be1975561240edfd4dffab77236b036798e)
- Canonical pool hash: `aaa29189f284bb9624a5fc45649c13ac8e8adc625540614c9e93744324508ae6`
- Detailed source-file hashes, transformation notes, counts and gate results:
  [`provenance.json`](provenance.json)
- File-byte checksums: [`manifest.json`](manifest.json)

The pool hash is over the canonical JSON body without its `sha256` member; it is
not the SHA-256 of the formatted pool file. The manifest separately hashes file
bytes. The package does not include credentials, user records or model-run reports.

Verify the downloaded package offline with Node 20 or newer:

```sh
node verify.mjs
```

This checks file checksums, all 792 SEE reference outputs, exact prompt hashes,
all 60 recorded paths, and all 60 independently searched DO solutions. The
repository exporter also runs the full self-test and deterministic regeneration.
A checksum establishes consistency, not authenticity; compare provenance against
the pinned source commit when auditing origin. For source-level reproduction:

```sh
git clone https://github.com/1999labs/monkey-see-monkey-do.git
cd monkey-see-monkey-do
git checkout 6b1a6be1975561240edfd4dffab77236b036798e
npm test
npm run self-test
npm run check-pool
npm run dry-run
```

The packaging exporter is maintained separately as `scripts/export-hf.mjs` in the
source repository; its digest is recorded in provenance. It does not modify suite
inputs, rule definitions, prompts or score calculations.

## Intended use and limitations

Suitable uses include reproducible solver-program evaluation, debugging narrow
failure modes, and studying behavior under controlled changes in available examples.

- Six finite rule classes and three rewrite systems provide narrow coverage.
  Unique identification holds only within the declared candidate class.
- Early examples are deliberately ambiguous. The information transition is
  constructed; the curve is not a natural random-example sample-efficiency estimate.
- DO scores a generated program, not the model executing a chain of thought.
  Length, branching, search strategy and resource budget are confounded.
- Public data and textbook algorithms may be recalled. Prompt/version hashes do
  not detect prior exposure. Avoid training on the answers before evaluating.
- Within-family instances and chains answered by one solver are correlated.
  Counts of cases are not counts of independent model decisions.
- There is no demonstrated relationship to agentic software-engineering success.
  This suite does not edit repositories or use tools on the evaluated model's behalf.
  Do not compare its scores directly with external benchmark leaderboards.
- The harness's `node:vm` timeouts do not provide a security boundary or memory cap.
- 2.1.0 is incompatible with earlier SEE scores; pool changes also affect DO pairs.
  Compare only measurements with matching suite, prompt and pool identifiers.

The synthetic domains and designed rule choices encode researcher preferences;
expanding their count does not establish population representativeness. There are
no personal-data subjects in these generated task sets. No empirical fairness
assessment or broad capability validation is claimed.

## License and attribution

MIT; see [LICENSE](LICENSE). Copyright (c) 2026 Noah McLaughlin.
When citing an evaluation, include the dataset ID, suite 2.1.0, source commit,
pool digest and the Hub revision used. This package has no associated paper or DOI.
