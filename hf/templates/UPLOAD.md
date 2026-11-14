# Upload-ready package

Target: `noahmclaughlin/monkey-see-monkey-do` (repository type: dataset).
This directory is a prepared package. Preparation does not create a Hub repository
or publish files.

From this directory, verify first:

```sh
node verify.mjs
hf auth whoami
```

After authenticating as the intended account, create the dataset if needed and
upload the contents of **this directory**, not the entire evaluation repository:

```sh
hf repos create noahmclaughlin/monkey-see-monkey-do --repo-type dataset --public --exist-ok
hf upload noahmclaughlin/monkey-see-monkey-do . . --repo-type dataset --commit-message "Publish Monkey See / Monkey Do suite 2.1.0"
```

Use `--private` instead of `--public` if the initial repository should be private.
Creation flags do not change an existing repository's visibility. Do not put tokens
in command arguments, scripts or package files; use the CLI's authentication flow.
Record the returned Hub commit and use it as `revision` in downstream evaluations.
Do not silently replace a published version's task files with another suite.

Hugging Face guidance:
- https://huggingface.co/docs/hub/en/agents-cli
- https://huggingface.co/docs/hub/en/datasets-manual-configuration
- https://huggingface.co/docs/hub/en/datasets-cards

Rebuild from the evaluation repository with `node scripts/export-hf.mjs`.
The exporter verifies frozen suite files against source commit
`{{SOURCE_COMMIT}}` and refuses to overwrite differing package files. For a fresh
build use `node scripts/export-hf.mjs --out /tmp/monkey-see-monkey-do-hf`.
