# Suite 2.0.0 scoring

A full run includes 12 SEE instances × four sample levels and three DO solver
submissions. Scored axes are separate; there is no composite or adjusted score.

SEE = 50 × mean held-out pass rate over the 36 submissions at levels 4, 8 and 16.
Each submission has 50 unique held-out inputs. Families have equal instance counts,
so this is equal weighting across families, instances and scored sample levels.
The two-example level is diagnostic only. Each scored prefix must distinguish the
selected rule from all other candidates in its explicitly declared class.

Robustness = mean non-throwing fraction across those same 36 submissions.
Compilation failure counts as 50 failures and 50 throws. Robustness is a diagnostic,
not free points added to correctness. GZ is 100 × mean(shown accuracy − held-out
accuracy), also diagnostic. A low gap alone does not establish good generalization.

DO = 50 × mean of the three systems' solved fractions. Each system has four chains
in each of five length bands, so systems and bands have equal weight. Each chain
gets binary credit for a fully legal path ending exactly on its target. Prefix
legality is diagnostic only. Empty, malformed, throwing and timed-out solutions
score zero; a malformed step cannot abort scoring of other chains.

Candidate functions use fresh JavaScript contexts for every input. SEE calls have
1000 ms and DO calls 3000 ms. DO accepts at most 1000 steps with intermediate
strings at most 128 characters. The reference uses bounded bidirectional BFS with
100000 states as its stopping threshold; this algorithmic cap is not imposed on
model code. The independent shortest-path and sandbox gates must solve every chain.

A failed network call has `callFailure` and yields a null affected headline, rather
than a zero attributed to model ability. A failure on the unscored level 2 does not
invalidate otherwise complete scored levels; the run still records it and exits 2.
A compile failure after a successful response is a scored model failure.

Repeated reports preserve every repeat. The mean is null if any repeat's headline
is missing. Min/max describe the completed subset and are accompanied by completed
and requested run counts. No confidence interval is inferred from correlated cases.

Version 1 formulas and their historical defects are documented in
[scoring-detail-v1.md](scoring-detail-v1.md). Do not apply them to v2.
