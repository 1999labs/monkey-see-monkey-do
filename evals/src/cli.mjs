// Command-line plumbing shared by the three runners (see, do, run-all).
//
// They used to carry three copies of the same argument parser and provider
// logic, which is how one of them ended up with a key variable that was out of
// scope where it was read. One copy now.

import { resolveModel, temperatureStatus, TEMPERATURE_OVERRIDE_FLAG } from "./adapters/registry.mjs";
import { resolveKey, setupHint } from "./see/key.mjs";

export { temperatureStatus, TEMPERATURE_OVERRIDE_FLAG };

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
    temperatureOverride: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") args.model = argv[++i];
    else if (a === "--key" || a === "-k") args.key = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--runs" || a === "-r") args.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--per-tier") args.perTier = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--interactive" || a === "-i") args.interactive = true;
    else if (a === "--seed" || a === "-s") args.seed = Number(argv[++i]);
    else if (a === "--only-provider") args.onlyProvider = argv[++i];
    else if (a === "--order-provider") args.orderProvider = argv[++i];
    else if (a === "--no-fallback") args.noFallback = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === TEMPERATURE_OVERRIDE_FLAG) args.temperatureOverride = true;
    else if (a === "--help" || a === "-h") args.help = true;
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
 * Exits with a clear message on any failure: these are setup errors, and a
 * setup error must never be mistaken for a model result.
 */
export const prepareModel = async (args, { log = console.log } = {}) => {
  let config;
  try {
    config = resolveModel(args.model, { seed: args.seed, provider: providerFrom(args), configPath: args.config });
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
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
      console.error(
        `\n  ${args.model} is configured with supportsTemperatureZero: false.\n` +
          `  A model sampled above temperature 0 is a different experiment, and its score\n` +
          `  is not comparable with any score sampled at 0. Refusing to record one.\n` +
          `\n  If you understand that and want the number anyway, add:\n    ${TEMPERATURE_OVERRIDE_FLAG}\n` +
          `  The result will be stamped as not comparable.\n`
      );
      process.exit(1);
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
      console.error(setupHint(config.apiKeyEnv));
      process.exit(1);
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
