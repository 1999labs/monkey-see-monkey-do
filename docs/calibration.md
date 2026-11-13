# Suite 2.1.0 calibration

The v2 pool is deterministic from seed `0xC0FFEE`, with generator version `2.1.0`.
It has 12 SEE instances in six families and 60 DO chains in three systems. Its
SHA-256 is `aaa29189f284bb9624a5fc45649c13ac8e8adc625540614c9e93744324508ae6`.

Re-derive structural and oracle checks:

```sh
npm run self-test
npm run check-pool
npm run dry-run -- --out /tmp/monkey-v2-reference
npm run audit
```

The reference reaches SEE 50/50 and DO 50/50 (60/60 chains). It independently
searches DO solutions; replaying stored answers is a separate pool-integrity check.
All SEE instances have 16 unique shown inputs and 50 unique, disjoint held-out
inputs. Every scored prefix (16 examples) identifies a unique member of the
prompt's declared hypothesis class. Prefixes through eight examples retain more
than one compatible candidate. Every incorrect declared rule differs from the
target on at least one held-out input. These guarantees are enforced, not inferred
from an aggregate naive baseline.

Naive baselines are reported per instance by `npm run audit`. There is no mandatory
20–45% band and no seed selected to hit a desired random-walk score. A baseline can
coincide with a selected rule; its result describes that instance only. An empty DO
solver scores zero, with no second penalty required to remove nonexistent free points.

Growth paths have shortest distance equal to the target/start length difference;
reductions have the opposite length difference. Swap instances require moving two
markers across independent blocks; shortest distance is their total displacement.
Bidirectional BFS independently confirms all three constructions. Systems differ
in reversibility, branching and length behavior; the suite does not claim these
features are controlled independently of chain length.

There are no v2 model cohorts or downstream predictive-validity studies yet.
Expanded structural coverage is not proof of broad model discrimination. The
publication gate checks completed evidence and repeat spread only.

Before changing families, examples, rules, solver budgets or weights, update the
suite/generator version deliberately, regenerate `src/v2/pool.json`, update prompt
pins if applicable, and rerun all checks. Historical measurements and the former
scoring formulas remain in [calibration-v1.md](calibration-v1.md); they are not v2
calibration and must not be silently recalculated onto the new task set.

## Changes from 2.0.0

The audit found wrong-rule full credit on four SEE instances, an unparseable
acceptance command, a possible empty-evidence pass, output hooks escaping the
execution timeout, and incomplete generation metadata. Version 2.1.0 repairs
these and changes SEE to a level-16 headline with earlier ambiguity diagnostics.
Its SEE results are not comparable with 2.0.0. The shared seed stream changes DO
examples too when SEE generation changes; compare only matching suite/pool hashes.
