# Maintaining suite 2

Run `npm test`, `npm run self-test`, `npm run dry-run` and `npm run check-pool`
before publishing changes. `npm run self-test:full` includes deterministic pool
regeneration. CI runs the tests and gate on Node 20; full checks also run nightly.

Active code and data live in `src/v2/`. `version.mjs` pins suite and generator
versions, `pool.json` holds the versioned data, and `prompt-digests.json` pins all
51 prompts. Prompt changes require a deliberate suite bump and new pins. Changes
to data generation require a generator bump and `npm run gen-pool`. Read
`calibration.md` before changing any experiment-defining parameter.

Commit combined model reports with their cohort evidence. Keep raw per-eval reports
local. Do not delete unexplained files in `results/`; other sessions may own them.
Check `git log -1` before assuming HEAD is unchanged. Run model cohorts sequentially.
No report writer may silently overwrite evidence.

`npm run acceptance -- --strong MODEL --weak MODEL` collects three repeats of each
model. It checks completeness and at most two points of observed spread on each
axis. It does not enforce the expected ranking or certify general validity. Reports
are saved in the printed temporary directory; copy combined evidence into `results/`
and commit it before publishing a cohort. Provider and effort settings must be
recorded and comparable. The names strong and weak are historical CLI vocabulary.

V1 engines and commands are historical compatibility paths. Use `legacy:` commands
only for explicitly labeled historical reproduction. Current charts need a v2-aware
consumer of separate SEE and DO summaries; the legacy adjusted-score chart is not
such a consumer.
