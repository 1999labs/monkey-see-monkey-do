# Hugging Face release packaging

Published dataset: [noahmclaughlin/monkey-see-monkey-do](https://huggingface.co/datasets/noahmclaughlin/monkey-see-monkey-do).
The exact published revision and integrity hashes are recorded in
[releases/2.1.0.json](releases/2.1.0.json).

The complete upload directory is `hf/monkey-see-monkey-do/`. Its dataset card,
reference validator and upload instructions are generated from `hf/templates/`.
Only that release directory belongs in the dataset repository.

From this Git checkout, rebuild and validate with Node 20 or newer:

```sh
node scripts/export-hf.mjs --out /tmp/monkey-hf-rebuild
node /tmp/monkey-hf-rebuild/verify.mjs
cmp hf/monkey-see-monkey-do/manifest.json /tmp/monkey-hf-rebuild/manifest.json
node --test tests/hf-export.test.mjs
```

Use a fresh output directory. Identical exports are idempotent; differing files
are never overwritten. The exporter checks experiment-defining files against
frozen suite commit `6b1a6be1975561240edfd4dffab77236b036798e` and runs the full
suite gate before exporting. Packaging adds derived reference labels and encodes
mixed-type SEE values as JSON strings; it does not change the evaluation.

To reproduce this exact release later, check out the Git commit containing this
receipt and these exporter/templates. Wall-clock export times are omitted so the
package is byte-reproducible. A changed exporter, template or source requires a
new reviewed package; preserve the old Hub revision for published measurements.

The standalone validator checks manifest hashes, source-pool integrity, reference
answers, exact prompt hashes, legal derivations and independent solver paths.
`tests/hf-export.test.mjs` additionally tests byte-reproducibility, tamper detection
and refusal to overwrite differing files. The four subsets were loaded locally
with Hugging Face `datasets` 4.5.0 / PyArrow 21.0.0 before publication.
