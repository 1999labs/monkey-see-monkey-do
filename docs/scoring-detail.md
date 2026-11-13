# Suite 2.1.0 scoring

A full run includes 12 SEE instances × four sample levels and three DO solver
submissions. Scored axes are separate; there is no composite or adjusted score.

SEE = 50 × mean held-out pass rate over the 12 submissions at level 16.
Each submission has 50 unique held-out inputs. Families and instances are equally
weighted. Levels 2, 4 and 8 are diagnostic only, because multiple declared rules
remain consistent with those prefixes. Level 16 uniquely identifies the target.
Reports include mean compatible-candidate counts beside per-level accuracy.

The generator reserves held-out witnesses against every incorrect rule before
selecting shown examples. No shown input overlaps a held-out input. Shown examples
through level 8 preserve a plausible rival; later examples eliminate it. This is
a controlled information transition, not a random-example sample-efficiency study.
Every incorrect declared candidate must fail at least one held-out case.

Robustness = mean non-throwing fraction across the 12 scored submissions.
Compilation failure counts as 50 failures and 50 throws. Robustness is diagnostic,
not free points added to correctness. GZ is 100 × mean(shown accuracy − held-out
accuracy), also diagnostic. A low gap alone does not establish generalization.

DO = 50 × mean of the three systems' solved fractions. Each system has four chains
in each of five length bands, so systems and bands have equal weight. Each chain
gets binary credit for a fully legal path ending exactly on its target. Prefix
legality is diagnostic only. Empty, malformed, throwing and timed-out solutions
score zero; a malformed step cannot abort scoring of other chains.

Candidate functions use fresh JavaScript contexts for every input. V2 serializes
returned values under the VM timeout and parses a bounded primitive JSON string
in the host. Getters, proxies and toJSON hooks therefore run within that budget.
Nonfinite values and unsupported JSON values fail instead of becoming null. SEE calls have
1000 ms and DO calls 3000 ms. DO accepts at most 1000 steps with intermediate
strings at most 128 characters. The reference uses bounded bidirectional BFS with
100000 states as its stopping threshold; this algorithmic cap is not imposed on
model code. The independent shortest-path and sandbox gates must solve every chain.

A failed network call has `callFailure` and yields a null affected headline, rather
than a zero attributed to model ability. A failure on an unscored level (2, 4 or 8) does not
invalidate otherwise complete scored levels; the run still records it and exits 2.
A compile failure after a successful response is a scored model failure.

Repeated reports preserve every repeat. The mean is null if any repeat's headline
is missing. Min/max describe the completed subset and are accompanied by completed
and requested run counts. No confidence interval is inferred from correlated cases.

Version 1 formulas and their historical defects are documented in
[scoring-detail-v1.md](scoring-detail-v1.md). Do not apply them to v2.

Combined evidence records adapter/model, effective API request timeout, retry and
attempt budgets, effective output-token cap (or an explicit provider-default
marker), configured overrides, and Node/platform/architecture. API limits are
per attempt; retries and backoff may increase total elapsed time.
