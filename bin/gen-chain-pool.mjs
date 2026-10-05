// Regenerate the published MONKEY DO chain pool.
//
//   node bin/gen-chain-pool.mjs                   write src/do/chain/pool.json
//   node bin/gen-chain-pool.mjs --check           regenerate in memory and compare
//                                                 byte for byte with the file
//                                                 (and re-derive every chain)
//
// Deterministic: running it twice must produce identical bytes. If it does
// not, the generator has a bug and every score computed on the published
// pool is unverifiable (Phase 2's success criterion 4).
//
// Time: a few minutes per run. The reference solver re-derivation step in
// `--check` is the largest cost (50 chains × BFS); the bare build is faster.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

import {
  buildPublishedPool,
  serializePool,
  loadPublishedPool,
  POOL_FILE,
  POOL_SEED,
  chainListSha256,
} from "../src/do/chain/pool.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const seed = Number(opt("--seed", String(POOL_SEED)));
const out = opt("--out", POOL_FILE);
const check = args.includes("--check");

if (!Number.isInteger(seed)) {
  console.error("usage: node bin/gen-chain-pool.mjs [--seed N] [--out FILE] [--check]");
  process.exit(1);
}

console.log(`\nMONKEY DO · chain pool`);
console.log(`  seed 0x${seed.toString(16).toUpperCase()}`);
const started = Date.now();

let pool;
try {
  pool = buildPublishedPool({
    seed,
    onProgress: (m) => console.log(`  ${m}...`),
  });
} catch (err) {
  console.error(`\n  \x1b[31mFAIL\x1b[0m  ${err?.message ?? err}\n`);
  process.exit(1);
}
const text = serializePool(pool);
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`  ${pool.chains.length} chains in ${secs}s  ·  sha256 ${pool.sha256.slice(0, 16)}…`);

if (check) {
  if (!existsSync(out)) {
    console.error(`\n  FAIL  ${out} does not exist, so there is nothing to check against.\n`);
    process.exit(1);
  }
  const existing = readFileSync(out, "utf8");
  if (existing === text) {
    console.log(`\n  regenerating from disk for replay verification...`);
    let ok = true;
    try {
      loadPublishedPool({ path: out, verifyReplay: true });
    } catch (err) {
      ok = false;
      console.error(`\n  \x1b[31mFAIL\x1b[0m  replay verification: ${err?.message ?? err}\n`);
    }
    if (ok) {
      console.log(`\n  \x1b[32mPASS\x1b[0m  regeneration is byte-identical to ${out} and every chain replays\n`);
      process.exit(0);
    }
    process.exit(1);
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