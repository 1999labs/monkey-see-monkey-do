// Regression tests for the three-way hang.
//
// The interactive key prompt left users staring at a silent terminal three
// times. These tests pin the property that fixes it: with no key anywhere and
// no --interactive flag, resolveKey MUST return promptly and never block on
// stdin. A hang is the failure mode; returning null is the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveKey, setupHint, keyFilePath, readDotenvKey } from "../src/key.mjs";

const UNSET = "DEFINITELY_UNSET_KEY_9X8Y7Z";

const withCleanEnv = (fn) => {
  const saved = process.env[UNSET];
  delete process.env[UNSET];
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[UNSET];
    else process.env[UNSET] = saved;
  }
};

// A real key may exist on the machine running the tests (the developer set one
// up). resolveKey consults ~/.config/monkeydo/key BEFORE .env, so tests that
// need "no key at all" must be given an isolated HOME, not merely an unset
// env var. Skipping that made four tests fail once a real key was present.
const withIsolatedHome = (env, fn) => {
  const saved = { home: process.env.HOME, env: process.env[env], cwd: process.cwd() };
  const dir = mkdtempSync(join(tmpdir(), "md-home-"));
  process.env.HOME = dir;
  delete process.env[env];
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.env.HOME = saved.home;
    if (saved.env === undefined) delete process.env[env];
    else process.env[env] = saved.env;
    process.chdir(prevCwd);
  }
};

const withIsolatedHomeAsync = async (env, fn) => {
  const saved = { home: process.env.HOME, env: process.env[env], cwd: process.cwd() };
  const dir = mkdtempSync(join(tmpdir(), "md-home-"));
  process.env.HOME = dir;
  delete process.env[env];
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.env.HOME = saved.home;
    if (saved.env === undefined) delete process.env[env];
    else process.env[env] = saved.env;
    process.chdir(prevCwd);
  }
};

/** Fail the test rather than hang if the promise does not settle in time. */
const withDeadline = async (promise, ms, label) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms — it would hang`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

test("NEVER HANGS: with no key and no --interactive, it returns null fast", async () => {
  const result = await withDeadline(
    withIsolatedHomeAsync(UNSET, (dir) => resolveKey(UNSET, { cwd: dir })),
    2000,
    "resolveKey with no key"
  );
  assert.equal(result.key, null);
  assert.equal(result.source, "none");
});

test("NEVER HANGS: even with --interactive omitted and a TTY-like stdin", async () => {
  // The old code blocked on readline here. It must not now.
  const orig = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    const result = await withDeadline(
      withIsolatedHomeAsync(UNSET, (dir) => resolveKey(UNSET, { cwd: dir })),
      2000,
      "resolveKey with TTY stdin"
    );
    assert.equal(result.key, null, "must not block waiting for input");
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
  }
});

test("an explicit --key is used and trimmed", async () => {
  const { key, source } = await withCleanEnv(() => resolveKey(UNSET, { flagValue: "  sk-or-v1-flag  " }));
  assert.equal(key, "sk-or-v1-flag");
  assert.equal(source, "--key flag");
});

test("an environment key is used and trimmed", async () => {
  process.env[UNSET] = "  sk-env-456\n";
  try {
    const { key, source } = await resolveKey(UNSET);
    assert.equal(key, "sk-env-456");
    assert.equal(source, `$${UNSET}`);
  } finally {
    delete process.env[UNSET];
  }
});

test("a .env file is used when no key file or env var is present", async () => {
  const { key, source } = await withIsolatedHome(UNSET, (dir) => {
    writeFileSync(join(dir, ".env"), "sk-from-dotenv-789\n");
    return resolveKey(UNSET, { cwd: dir });
  });
  assert.equal(key, "sk-from-dotenv-789");
  assert.equal(source, ".env file");
});

test("a per-provider key file in HOME takes priority over .env", async () => {
  const { key, source } = await withIsolatedHome(UNSET, (dir) => {
    writeFileSync(join(dir, ".env"), "sk-from-dotenv-789\n");
    const cfg = join(dir, ".config", "monkeydo", "keys");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, UNSET), "sk-from-keyfile-abc\n");
    return resolveKey(UNSET, { cwd: dir });
  });
  assert.equal(key, "sk-from-keyfile-abc");
  assert.equal(source, "key file");
});

test("the original single key file is used for OpenRouter only", async () => {
  // It used to be returned for whatever variable was asked for, which would
  // send an OpenRouter key to OpenAI or Groq once more providers existed.
  const writeLegacy = (dir) => {
    const cfg = join(dir, ".config", "monkeydo");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "key"), "sk-or-legacy\n");
  };
  const other = await withIsolatedHome(UNSET, (dir) => {
    writeLegacy(dir);
    return resolveKey(UNSET, { cwd: dir });
  });
  assert.equal(other.key, null, "an OpenRouter key must not be offered to another provider");
  const openrouter = await withIsolatedHome("OPENROUTER_API_KEY", (dir) => {
    writeLegacy(dir);
    return resolveKey("OPENROUTER_API_KEY", { cwd: dir });
  });
  assert.equal(openrouter.key, "sk-or-legacy");
});

test("a .env in the documented NAME=value format yields just the value", async () => {
  // The first version returned the whole file — comments, variable name and all
  // — as the bearer token.
  const { key } = await withIsolatedHome(UNSET, (dir) => {
    writeFileSync(join(dir, ".env"), `# comment\nOTHER_KEY=nope\n${UNSET}="sk-quoted-123"\n`);
    return resolveKey(UNSET, { cwd: dir });
  });
  assert.equal(key, "sk-quoted-123");
});

test("readDotenvKey handles export, inline comments, and a blank value", () => {
  assert.equal(readDotenvKey("export FOO=sk-1 # trailing\n", "FOO"), "sk-1");
  assert.equal(readDotenvKey("FOO='sk-2'\n", "FOO"), "sk-2");
  assert.equal(readDotenvKey("# copied from .env.example\nFOO=\n", "FOO"), null, "an empty value is no key");
  assert.equal(readDotenvKey("BAR=sk-3\n", "FOO"), null, "another variable is not this key");
  assert.equal(readDotenvKey("«redacted:sk-…»\n", "FOO"), "«redacted:sk-…»", "a lone bare token is still accepted");
  // Unspaced trailing comments: "KEY=sk-foo#staging" used to keep "#staging"
  // in the key, and the resulting 401 surfaced as an unexplained auth failure.
  assert.equal(readDotenvKey("FOO=sk-4#staging\n", "FOO"), "sk-4", "API keys do not contain #");
});

test("the key file lives outside the repository", () => {
  const p = keyFilePath();
  assert.ok(p.includes(".config"), p);
  assert.ok(p.includes("monkeydo"), p);
  assert.ok(!p.includes("monkey-see-monkey-do/evals"), `key must not live in the repo: ${p}`);
});

test("the setup hint names the exact commands and does not leak a key", () => {
  const hint = setupHint(UNSET);
  assert.ok(hint.includes("read -s"), "must show a non-echoing read");
  assert.ok(hint.includes("chmod 600"), "must lock the file down");
  assert.ok(hint.includes("~/.config/monkeydo"), "must say where the key goes");
  assert.ok(hint.includes(UNSET), "must name the env var it looked for");
  assert.ok(!/sk-or-v1-[A-Za-z0-9]{10,}/.test(hint), "hint must not contain a key");
});

test("empty files are treated as absent, not as an empty key", async () => {
  const { key } = await withIsolatedHome(UNSET, (dir) => {
    writeFileSync(join(dir, ".env"), "   \n");
    return resolveKey(UNSET, { cwd: dir });
  });
  assert.equal(key, null, "a blank .env must not shadow the setup hint");
});




