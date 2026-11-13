# Migration to 2.0.0

The default npm commands now run `src/v2/cli.mjs`. Shared provider adapters, key
resolution and JavaScript sandbox remain in `src/`. Historical v1 engines remain
at their original source paths for reproduction, and their npm commands have
`legacy:` aliases. Their data and score definitions are frozen; historical defects
and caveats still apply to their results.

V2 replaces three fixed SEE functions with six declared finite hypothesis classes
and two parameter instances each. It removes shown/held-out overlap and duplicates,
requires identifiable scored prefixes, and treats two-example performance as a
diagnostic. This explicitly changes the construct to constrained rule identification.

All scored submissions contribute to robustness. Missing and malformed programs
keep their denominator. Robustness and GZ are descriptive, with no adjusted total.
Three rewrite systems replace the single DO system. Legal prefixes earn zero;
malformed steps are handled as failures. Reference dry-runs search from scratch.

Reports use `monkey-report@2`, include `suiteVersion: 2.0.0`, and carry full raw
responses and prompt text in combined evidence. API failures are missing values.
Repeated response-text identity is not treated as a requirement for score stability.

Existing reports, cohort JSON and SVG files have not been transformed. Their charts
and build scripts remain v1-only. The historical README is `legacy-v1.md`.
Use a separate checkout of the original commit for byte-exact original environments.

No hosted models were called to establish this release. Offline oracle checks verify
harness behavior; new model cohorts must be measured and published separately.
