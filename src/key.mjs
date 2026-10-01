// Get an API key without ever writing it into the repository or hanging.
//
// WHY THIS IS SHAPED THIS WAY
//
// The interactive key prompt failed three times in real use: it left the user
// staring at a silent terminal that looked frozen. A hang is undiagnosable from
// the outside, and the cause (TTY detection differing between hosts, readline
// waiting on a stdin that never delivers) is not reliably testable in an
// automated harness. So the prompt is no longer on the default path.
//
//   1. --key "..."        explicit, wins over everything
//   2. $<PROVIDER>_API_KEY  the provider's environment variable
//   3. ~/.config/monkeydo/keys/<ENV_NAME>   a per-provider key file OUTSIDE
//      the repo, mode 600 — or, for OpenRouter only, the original
//      ~/.config/monkeydo/key
//   4. .env             optional convenience, gitignored
//   5. --interactive          opt-in prompt, never the default
//
// Key files are PER PROVIDER. The original single key file was returned for
// whatever variable was asked for, which was harmless while OpenRouter was the
// only provider and would now send an OpenRouter key to OpenAI or Groq.
//
// If none of those produce a key, we print the exact command to run and exit.
// A clear error is debuggable; a silent hang is not.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const keyFilePath = () => join(homedir(), ".config", "monkeydo", "key");

/** The per-provider key file for one environment variable name. */
export const keyFilePathFor = (envName) => join(homedir(), ".config", "monkeydo", "keys", envName);

/**
 * Read `envName` from a .env file.
 *
 * The first version returned the WHOLE FILE as the key. That matched a .env
 * holding a bare key, but .env.example documents the standard
 * `OPENROUTER_API_KEY=sk-...` format — so a .env copied from the example sent
 * its entire text, comments included, as the bearer token.
 *
 * Now: a `NAME=value` line for the requested variable wins (quotes stripped,
 * `export ` allowed). A file that is a single bare token with no `=` anywhere
 * is still accepted as the key, for backwards compatibility.
 */
export const readDotenvKey = (text, envName) => {
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== envName) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return value.trim() || null;
  }
  const meaningful = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (meaningful.length === 1 && !meaningful[0].includes("=") && !/\s/.test(meaningful[0])) return meaningful[0];
  return null;
};

const readKeyFile = (path) => {
  try {
    if (!existsSync(path)) return null;
    const value = readFileSync(path, "utf8").trim();
    return value ? value : null;
  } catch {
    return null;
  }
};

/**
 * Opt-in interactive prompt. Bounded by a hard timeout so it cannot hang
 * forever even on a hostile stdin.
 */
export const promptForKey = (timeoutMs = 5 * 60 * 1000) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write("Paste your key (it will not be shown): ");

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      process.stdout.write("\n");
      resolve(value);
    };
    const timer = setTimeout(() => {
      process.stdout.write("\nTimed out waiting for input.\n");
      finish("");
    }, timeoutMs);
    rl.question("", (answer) => finish(String(answer).trim()));
  });

/**
 * Resolve a key for `envName`.
 * Returns { key, source }. `key` is null when none is available — and this
 * function never blocks unless `interactive` is explicitly true.
 */
export const resolveKey = async (envName, { flagValue, interactive = false, cwd = process.cwd() } = {}) => {
  if (flagValue && String(flagValue).trim()) {
    return { key: String(flagValue).trim(), source: "--key flag" };
  }
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) {
    return { key: fromEnv.trim(), source: `$${envName}` };
  }
  const perProvider = readKeyFile(keyFilePathFor(envName));
  if (perProvider) return { key: perProvider, source: "key file" };
  if (envName === "OPENROUTER_API_KEY") {
    const home = readKeyFile(keyFilePath());
    if (home) return { key: home, source: "key file" };
  }
  const dotenvText = readKeyFile(join(cwd, ".env"));
  const dotenv = dotenvText ? readDotenvKey(dotenvText, envName) : null;
  if (dotenv) return { key: dotenv, source: ".env file" };

  if (interactive) {
    const typed = await promptForKey();
    return typed ? { key: typed, source: "interactive prompt" } : { key: null, source: "none" };
  }
  return { key: null, source: "none" };
};

/** The single command that stores a key safely, printed when none is found. */
export const setupHint = (envName) => {
  const file = `~/.config/monkeydo/keys/${envName}`;
  return [
    "",
    "  No API key found. Here is the one command that sets it up:",
    "",
    `    read -s -p "Paste your ${envName}: " K; echo;`,
    `    mkdir -p ~/.config/monkeydo/keys && echo "$K" > ${file} && chmod 600 ${file}`,
    "",
    "  Paste those two lines, paste your key when asked, then re-run this command.",
    `  The key is stored outside this project, so it can never end up in git.`,
    `  To remove it later:  rm ${file}`,
    "",
    `  (This looks for $${envName}, a key file, or ${envName}= in .env — none were present.)`,
    "",
  ].join("\n");
};

