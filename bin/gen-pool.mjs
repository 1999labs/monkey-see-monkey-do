// Regenerate the published MONKEY DO board pool.
//
//   node bin/gen-pool.mjs                 write src/do/minesweeper/pool.json
//   node bin/gen-pool.mjs --check         regenerate in memory and compare
//                                             byte for byte with the file
//
// Deterministic: running it twice must produce identical bytes. If it does not,
// the generator has a bug and every score computed on the published pool is
// unverifiable (success criterion 4).
//
// Takes a couple of minutes: Pool B accepts only 10-20% of candidate boards,
// because most boards turn out to be winnable without a guess.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

import {
  buildPublishedPool,
  serializePool,
  POOL_FILE,
  POOL_SEED,
  PUBLISHED_PER_TIER,
} from "../src/do/minesweeper/pool.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const seed = Number(opt("--seed", String(POOL_SEED)));
const out = opt("--out", POOL_FILE);
const perTier = {
  A: Number(opt("--per-tier-a", PUBLISHED_PER_TIER.A)),
  B: Number(opt("--per-tier-b", PUBLISHED_PER_TIER.B)),
};
const check = args.includes("--check");

if (!Number.isInteger(seed) || !Number.isInteger(perTier.A) || !Number.isInteger(perTier.B)) {
  console.error("usage: node bin/gen-pool.mjs [--seed 0x5EED] [--out FILE] [--per-tier-a N] [--per-tier-b N] [--check]");
  process.exit(1);
}

console.log(`\nMONKEY DO · board pool`);
console.log(`  seed 0x${seed.toString(16).toUpperCase()}  ·  ${perTier.A} Pool A + ${perTier.B} Pool B boards per tier`);
const started = Date.now();
const pool = buildPublishedPool({ seed, perTier, onProgress: (m) => console.log(`  generating ${m}...`) });
const text = serializePool(pool);
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`  ${pool.boards.length} boards in ${secs}s  ·  sha256 ${pool.sha256}`);

for (const [p, tiers] of Object.entries(pool.stats)) {
  for (const [tier, s] of Object.entries(tiers)) {
    const accepted = pool.boards.filter((b) => b.pool === p && b.tier === tier).length;
    console.log(
      `    Pool ${p} ${tier.padEnd(13)} accepted ${String(accepted).padStart(3)} of ${String(s.attempts).padStart(4)} ` +
        `(wrong pool ${s.rejectedWrongPool}, unclassifiable ${s.rejectedUnclassifiable}, hard stall ${s.rejectedHardStall})`
    );
  }
}

if (check) {
  if (!existsSync(out)) {
    console.error(`\n  FAIL  ${out} does not exist, so there is nothing to check against.\n`);
    process.exit(1);
  }
  const existing = readFileSync(out, "utf8");
  if (existing === text) {
    console.log(`\n  \x1b[32mPASS\x1b[0m  regeneration is byte-identical to ${out}\n`);
    process.exit(0);
  }
  const a = existing.split("\n");
  const b = text.split("\n");
  const line = a.findIndex((l, i) => l !== b[i]);
  console.error(`\n  \x1b[31mFAIL\x1b[0m  regeneration differs from ${out}, first at line ${line + 1}:`);
  console.error(`    file:        ${a[line] ?? "(end of file)"}`);
  console.error(`    regenerated: ${b[line] ?? "(end of file)"}`);
  console.error(`\n  Either the generator changed (bump GENERATOR_VERSION and regenerate) or it is not deterministic.\n`);
  process.exit(1);
}

writeFileSync(out, text);
console.log(`\n  wrote ${out}\n`);
