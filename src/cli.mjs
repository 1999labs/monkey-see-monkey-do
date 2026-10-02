// Command-line plumbing shared by the three runners (see, do, run-all).
//
// They used to carry three copies of the same argument parser and provider
// logic, which is how one of them ended up with a key variable that was out of
// scope where it was read. One copy now.

import { resolveModel, temperatureStatus, TEMPERATURE_OVERRIDE_FLAG } from "./adapters/registry.mjs";
import { resolveKey, setupHint } from "./key.mjs";

export { temperatureStatus, TEMPERATURE_OVERRIDE_FLAG };

// Which flags take a value, and which stand alone.
const VALUE_FLAGS = new Set([
  "--model", "-m", "--key", "-k", "--out", "--config", "--runs", "-r",
  "--per-tier", "--seed", "-s", "--only-provider", "--order-provider",
]);
const BOOL_FLAGS = new Set([
  "--interactive", "-i", "--no-fallback", "--dry-run",
  TEMPERATURE_OVERRIDE_FLAG, "--help", "-h", "--bands",
]);

/**
 * Parse the shared CLI vocabulary.
 *
 * STRICT ON PURPOSE. The first version ignored anything it did not recognise,
 * so a mistyped --config silently scored against the default registry and a
 * typo'd flag was indistinguishable from a flag that worked. Unknown arguments,
 * missing values, --seed abc (NaN reaches the wire as JSON null) and fractional
 * --runs are all ERRORS now, thrown with the offending token named. The
 * runners print the message and exit 1.
 *
 * Both "--flag value" and "--flag=value" are accepted for long value flags.
 */
export const parseArgs = (argv) => {
  const args = {
    runs: 1,
    model: null,
    key: null,
    help: false,
    interactive: false,
    seed: undefined,
    onlyProvider: null,
    orderProvider: null,
    noFallback: false,
    out: "results",
    config: null,
    perTier: null,
    dryRun: false,
    bands: false,
    temperatureOverride: false,
  };
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq !== -1) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }

    if (a === "--help" || a === "-h") {
      // --help wins outright, even over a bad argument seen earlier: a user
      // asking for help gets it, not an error about the flag they got wrong.
      args.help = true;
      return args;
    }
    if (BOOL_FLAGS.has(a)) {
      if (inline !== null) {
        problems.push(`"${a}" takes no value (got "${argv[i]}")`);
        continue;
      }
      if (a === "--interactive" || a === "-i") args.interactive = true;
      else if (a === "--no-fallback") args.noFallback = true;
      else if (a === "--dry-run") args.dryRun = true;
      else if (a === "--bands") args.bands = true;
      else if (a === TEMPERATURE_OVERRIDE_FLAG) args.temperatureOverride = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) {
      problems.push(`unknown argument "${argv[i]}"`);
      continue;
    }

    let value = inline;
    if (value === null) {
      value = argv[++i];
      if (value === undefined) {
        problems.push(`"${a}" needs a value`);
        continue;
      }
    }

    if (a === "--runs" || a === "-r" || a === "--per-tier") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        problems.push(`"${a}" needs an integer of 1 or more, got "${value}"`);
        continue;
      }
      if (a === "--per-tier") args.perTier = n;
      else args.runs = n;
      continue;
    }
    if (a === "--seed" || a === "-s") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        problems.push(`--seed needs a number, got "${value}" (a bad seed would silently reach the endpoint as null)`);
        continue;
      }
      args.seed = n;
      continue;
    }
    if (a === "--model" || a === "-m") args.model = value;
    else if (a === "--key" || a === "-k") args.key = value;
    else if (a === "--out") args.out = value;
    else if (a === "--config") args.config = value;
    else if (a === "--only-provider") args.onlyProvider = value;
    else if (a === "--order-provider") args.orderProvider = value;
  }

  if (problems.length) {
    throw new Error(
      `bad argument${problems.length > 1 ? "s" : ""}:\n  - ${problems.join("\n  - ")}\n\nRun with --help to see the recognised flags.`
    );
  }
  return args;
};

/** Build the provider-pinning object from CLI flags, or null if unpinned. */
export const providerFrom = (args) => {
  const only = args.onlyProvider;
  const order = args.orderProvider ? args.orderProvider.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (!only && !order && !args.noFallback) return null;
  return {
    ...(only ? { only } : {}),
    ...(order ? { order } : {}),
    ...(args.noFallback ? { allowFallbacks: false } : {}),
  };
};

/** Print the temperature statement prominently when it is not a plain yes. */
export const temperatureNotice = (config, log = console.log) => {
  const t = temperatureStatus(config);
  if (t.supported === false) log(`\n  \x1b[31m\x1b[1m!!\x1b[0m ${t.statement}`);
  else if (t.supported === null) log(`\n  note: ${t.statement}`);
};

/**
 * Resolve the model, enforce the temperature rule, and load the key.
 *
 * THROWS on any failure rather than exiting the process: a setup error must
 * never be mistaken for a model result, and a caller that has already collected
 * evidence (the acceptance gate has, by the time it scores its second model)
 * must be able to catch it and still write its report. The runners' main()
 * catch prints the message and exits 1, so the command-line behaviour is
 * unchanged.
 */
export const prepareModel = async (args, { log = console.log } = {}) => {
  let config;
  try {
    config = resolveModel(args.model, { seed: args.seed, provider: providerFrom(args), configPath: args.config });
  } catch (err) {
    err.message = String(err.message ?? err).trim();
    throw err;
  }
  log(`  endpoint: ${config.endpoint}  (${config.source})`);

  if (config.provider) {
    const how = config.provider.only
      ? `only ${[].concat(config.provider.only).join(", ")}`
      : `order ${[].concat(config.provider.order ?? []).join(" -> ")}`;
    log(`  pinned to provider: ${how}${config.provider.allowFallbacks === false ? ", no fallback" : ""}`);
  }
  if (config.seed !== undefined) log(`  seed: ${config.seed}`);

  // A provider that cannot run at temperature 0 is a different
  // experiment. Refuse to record a score unless the user says, awkwardly, that
  // they know.
  if (config.supportsTemperatureZero === false) {
    if (!args.temperatureOverride) {
      throw new Error(
        `${args.model} is configured with supportsTemperatureZero: false.\n` +
          `  A model sampled above temperature 0 is a different experiment, and its score\n` +
          `  is not comparable with any score sampled at 0. Refusing to record one.\n` +
          `  If you understand that and want the number anyway, add:\n    ${TEMPERATURE_OVERRIDE_FLAG}\n` +
          `  The result will be stamped as not comparable.`
      );
    }
    config = { ...config, temperatureOverride: true };
    temperatureNotice(config, log);
  }

  let keySource = "not required";
  if (config.apiKeyEnv) {
    const { key, source } = await resolveKey(config.apiKeyEnv, {
      flagValue: args.key,
      interactive: args.interactive,
    });
    if (!key) {
      throw new Error(setupHint(config.apiKeyEnv));
    }
    // Hand the key to the adapter without ever writing it down.
    process.env[config.apiKeyEnv] = key;
    keySource = source;
    log(`  key loaded from: ${source} (not saved to this project)`);
  }
  return { config, keySource };
};

/**
 * A failing self-test blocks scoring. There is no override.
 *
 * Imported lazily: the self-test imports the runners' own modules, and a static
 * import here would be circular.
 */
export const selfTestGate = async ({ log = console.log } = {}) => {
  const { runSelfTest } = await import("./self-test.mjs");
  const started = Date.now();
  const result = await runSelfTest({ log: () => {} });
  if (!result.ok) {
    console.error(`\n  \x1b[31mSELF-TEST FAILED\x1b[0m — ${result.failures.length} check(s). Scoring is blocked.\n`);
    for (const f of result.failures) console.error(`    - ${f}`);
    console.error(`\n  Run  npm run self-test  for the full report. There is no override.\n`);
    process.exit(1);
  }
  log(`  self-test passed (${result.passed} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return result;
};

/** The limitations every report must carry, for the console. */
export const printLimitations = (limitations, log = console.log) => {
  log(`\n  LIMITATIONS — read before quoting this score`);
  for (const l of limitations) log(`    - ${l}`);
};
