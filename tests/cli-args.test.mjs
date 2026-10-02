// parseArgs is strict: the first version ignored anything it did not recognise,
// so a mistyped --config silently scored against the default registry, and
// --seed abc silently reached the wire as JSON null. These pin the errors.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/cli.mjs";

test("the recognised vocabulary parses as before", () => {
  const a = parseArgs([
    "-m", "openrouter/x", "--key", "sk-1", "--runs", "3", "--per-tier", "5",
    "--seed", "7", "--out", "o", "--config", "c.json", "--only-provider", "P",
    "--order-provider", "A,B", "--no-fallback", "--dry-run",
    "--i-cannot-control-temperature",
  ]);
  assert.equal(a.model, "openrouter/x");
  assert.equal(a.key, "sk-1");
  assert.equal(a.runs, 3);
  assert.equal(a.perTier, 5);
  assert.equal(a.seed, 7);
  assert.equal(a.out, "o");
  assert.equal(a.config, "c.json");
  assert.equal(a.onlyProvider, "P");
  assert.equal(a.orderProvider, "A,B");
  assert.equal(a.noFallback, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.temperatureOverride, true);
});

test("the --flag=value form is accepted for long value flags", () => {
  const a = parseArgs(["--model=openrouter/x", "--runs=3", "--seed=42", "--out=/tmp/x"]);
  assert.equal(a.model, "openrouter/x");
  assert.equal(a.runs, 3);
  assert.equal(a.seed, 42);
  assert.equal(a.out, "/tmp/x");
});

test("unknown arguments are errors, not silent no-ops", () => {
  // The regression: a typo'd --config used to be dropped, and the run proceeded
  // against the default registry, scoring a different model than intended.
  assert.throws(() => parseArgs(["--confg", "my-models.json"]), /unknown argument "\-\-confg"/);
  assert.throws(() => parseArgs(["-m", "x", "--verbose"]), /unknown argument "--verbose"/);
});

test("--seed abc is an error, not a silent null on the wire", () => {
  // NaN JSON-serializes to null, so the old behaviour silently sent seed: null.
  assert.throws(() => parseArgs(["--seed", "abc"]), /--seed needs a number/);
  assert.throws(() => parseArgs(["-s", "abc"]), /--seed needs a number/);
  // A seed left dangling as the last token too.
  assert.throws(() => parseArgs(["--seed"]), /--seed needs a number|--seed" needs a value/);
});

test("--runs and --per-tier must be integers of 1 or more", () => {
  assert.throws(() => parseArgs(["--runs", "2.5"]), /integer/);
  assert.throws(() => parseArgs(["-r", "0"]), /integer/);
  assert.throws(() => parseArgs(["--per-tier", "x"]), /integer/);
  assert.equal(parseArgs(["--runs", "9"]).runs, 9);
});

test("a value flag missing its value is an error", () => {
  assert.throws(() => parseArgs(["--model"]), /"--model" needs a value/);
});

test("a boolean flag given a value is an error", () => {
  assert.throws(() => parseArgs(["--dry-run=true"]), /takes no value/);
});

test("all problems are reported at once, and --help suppresses parsing", () => {
  assert.throws(
    () => parseArgs(["--nope", "--seed", "abc"]),
    (err) => {
      assert.match(err.message, /--nope/);
      assert.match(err.message, /--seed/);
      return true;
    }
  );
  // --help anywhere wins: a user asking for help gets it even with typos.
  const h = parseArgs(["--model", "x", "--completely-unknown", "--help"]);
  assert.equal(h.help, true);
});
