// List the OpenRouter providers serving a model, so you know what to pin to.
//
//   node bin/providers.mjs -m openrouter/dots-3-note-preview:free
//
// A different provider is a different machine, which is one reason the same
// prompt can return different code. Pinning removes that variable.

import { listProviders } from "../src/adapters/openai.mjs";
import { resolveKey, setupHint } from "../src/key.mjs";

const args = process.argv.slice(2);
let model = null;
let keyFlag = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-m" || args[i] === "--model") model = args[i + 1];
  if (args[i] === "-k" || args[i] === "--key") keyFlag = args[i + 1];
}

if (!model || model.startsWith("openrouter/") === false) {
  console.error("usage: node bin/providers.mjs -m openrouter/<model-id>");
  if (model && !model.startsWith("openrouter/")) {
    console.error("  (drop the openrouter/ prefix — pass just the model id)");
  }
  process.exit(1);
}
const modelId = model.slice("openrouter/".length);

const { key, source } = await resolveKey("OPENROUTER_API_KEY", { flagValue: keyFlag });
if (!key) {
  // The same hint src/cli.mjs prints when a runner finds no key, so
  // `npm run providers` and the eval runners never disagree about how to
  // store one. The old message named setup-key.sh, which no longer exists.
  console.error(setupHint("OPENROUTER_API_KEY"));
  process.exit(1);
}
process.env.OPENROUTER_API_KEY = key;

console.log(`\nProviders for ${modelId}`);
console.log(`(key from ${source})\n`);

let list;
try {
  list = await listProviders(modelId);
} catch (err) {
  console.error(`could not list providers: ${err.message}`);
  process.exit(1);
}

if (!list.length) {
  console.log("  none reported.");
} else {
  console.log("  PROVIDER            QUANTIZATION        UPTIME(30m)");
  for (const p of list) {
    const uptime = p.uptime != null ? `${(p.uptime * 100).toFixed(1)}%` : "n/a";
    console.log(`  ${String(p.provider).padEnd(20)} ${String(p.quantization ?? "n/a").padEnd(19)} ${uptime}`);
  }
  console.log(`\n  Pin to one with, for example:`);
  console.log(`    npm run see -- -m ${model} --only-provider ${list[0].provider} --no-fallback -r 3 -s 42`);
}
console.log("");
