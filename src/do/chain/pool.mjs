// MONKEY DO — the chain pool.
//
// A pool of {start, target, length, steps} chains across 5 length bands,
// deterministically generated from a single seed. The pool is the artifact
// that every other change in DO is computed against.
//
// DESIGN CONVENTIONS (shared with the pool regime):
//   - POOL_SEED          the published seed; changing it invalidates every score
//   - GENERATOR_VERSION  bump on any change to generator, rules or band layout
//   - generatorFingerprint: a stable hash of every constant that decides what
//                          chains a seed produces
//   - loadPublishedPool:  verifies the file, rejects stale or edited pools
//   - serializePool:     one chain per line for readable diffs
//
// REPRODUCIBILITY is the point: same seed → same chains → same scores.
// That requires no Math.random, no Date, no iteration order dependency.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { RULES, SYMBOLS } from "./rules.mjs";
import { solveChain, verifyDerivation } from "./reference.mjs";
import { POOL_BANDS, generatePool, POOL_SEED as GEN_SEED } from "./generator.mjs";

/** Re-export for callers. */
export { RULES, SYMBOLS };

/** The published seed. Bumping this invalidates every score ever reported. */
export const POOL_SEED = GEN_SEED;

/**
 * Bump whenever a change alters WHICH chains a seed produces without
 * touching any constant recorded in generatorFingerprint(). In practice:
 * a change to rules.mjs, generator.mjs, or the band layout.
 *
 *   1  original generator (Phase 2)
 *
 * The published pool.json records the version it was built with. Loading a
 * pool built by a different version fails loudly — that failure is
 * intended, not a bug to work around (a stale pool measures something
 * different from what the current code assumes).
 */
export const GENERATOR_VERSION = 1;

/**
 * How many chains each band wants. Frozen at Phase 1: 10 chains per band,
 * 5 bands, 50 chains total. The pool weights derive from this layout —
 * each band is worth 10 points, so the pool maxes out at 50.
 */
export const PUBLISHED_PER_BAND = Object.fromEntries(POOL_BANDS.map((b) => [b.name, b.count]));

/** Total chains in the published pool. */
export const TOTAL_CHAINS = POOL_BANDS.reduce((n, b) => n + b.count, 0);

/** Where the published pool lives. */
export const POOL_FILE = fileURLToPath(new URL("./pool.json", import.meta.url));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Everything that decides which chains a seed produces, apart from the code
 * itself. A pool whose fingerprint differs from the running code's was built
 * by a different generator and cannot be trusted to mean what this code
 * thinks.
 */
export const generatorFingerprint = (seed = POOL_SEED) => ({
  version: GENERATOR_VERSION,
  seed,
  rules: RULES.map((r) => ({ id: r.id, trigger: r.trigger, rewrite: r.rewrite })),
  symbols: SYMBOLS,
  bands: POOL_BANDS.map((b) => ({ name: b.name, length: b.length, count: b.count })),
});

/**
 * A stable digest of one chain: the joined step records.
 */
export const chainDigest = (chain) =>
  sha256(chain.steps.map((s) => `${s.rule}@${s.start}->${s.next}`).join("\n"));

/**
 * SHA-256 over the chain list (one digest line per chain).
 *
 * The recorded digest covers start, target, length AND the steps. Two pools
 * with identical start/target but different step lists fail the check —
 * important because the published pool's per-step choices are the evidence
 * that the chains are actually solvable by the recorded derivation.
 */
export const chainListSha256 = (chains) =>
  sha256(chains.map((c, i) => `${i}:${c.start}|${c.target}|${c.length}|${chainDigest(c)}`).join("\n"));

/**
 * Build the published pool in memory. Deterministic: the same seed produces
 * the same chains. Slow (50 chains × BFS), so the result is written to
 * `pool.json` once and read on subsequent runs.
 */
export const buildPublishedPool = ({ seed = POOL_SEED, onProgress } = {}) => {
  const { chains, stats } = generatePool({ seed });
  onProgress?.(`generated ${chains.length} chains from seed 0x${seed.toString(16)}`);
  // Compact the per-step shape so the JSON file stays small. Each step is
  // { rule, start, next }; the rule id and the next state together are
  // everything the verifier needs to check a step.
  const compactChains = chains.map((c) => ({
    band: c.band,
    bandIndex: c.bandIndex,
    length: c.length,
    start: c.start,
    target: c.target,
    attempt: c.attempt,
    steps: c.steps.map((s) => ({ rule: s.rule, start: s.start, next: s.next })),
  }));
  return {
    schema: "monkey-do/chain-pool@1",
    generator: generatorFingerprint(seed),
    perBand: PUBLISHED_PER_BAND,
    sha256: chainListSha256(compactChains),
    stats,
    chains: compactChains,
  };
};

/**
 * Serialize with one chain per line, so a regenerated pool diffs readably
 * and `gen-pool --check` can point at the first chain that changed.
 */
export const serializePool = (pool) => {
  const { chains, ...head } = pool;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const lines = chains.map((c) => `    ${JSON.stringify(c)}`);
  return `${top},\n  "chains": [\n${lines.join(",\n")}\n  ]\n}\n`;
};

/**
 * Load, verify and optionally subset the published pool.
 *
 * `perBand` takes the first N chains of every band — a deterministic prefix,
 * useful for a quick run. A subset is marked `full: false` and gets its
 * own digest, because its score is not comparable with a full-pool score.
 *
 * `verifyReplay` (default false) re-derives every chain from (start, target)
 * with the reference solver and confirms the recorded steps match. This is
 * SLOW (50 chains × BFS) and is gated behind the flag so production reads
 * stay cheap. `gen-pool --check` is where it runs.
 *
 * Throws, with the command that fixes it, if the file is missing, was
 * built by a different generator, or any chain no longer produces the
 * recorded derivation when re-derived from (start, target) (with verifyReplay).
 */
export const loadPublishedPool = ({ path = POOL_FILE, perBand = null, verifyReplay = false } = {}) => {
  if (!existsSync(path)) {
    throw new Error(`no chain pool at ${path}. Generate it with:  npm run gen-pool`);
  }
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (file.schema !== "monkey-do/chain-pool@1") {
    throw new Error(`${path}: unknown pool schema "${file.schema}"`);
  }

  const expected = generatorFingerprint(file.generator?.seed);
  const mismatched = Object.keys(expected).filter(
    (k) => JSON.stringify(expected[k]) !== JSON.stringify(file.generator?.[k])
  );
  if (mismatched.length) {
    throw new Error(
      `${path} was built by a different generator (${mismatched.join(", ")} differ from this code). ` +
        `Its chains may not mean what this code assumes. Regenerate it with:  npm run gen-pool`
    );
  }

  if (verifyReplay) {
    // Re-derive each chain's derivation from (start, target) and confirm it
    // matches the recorded steps. A pool whose derivation no longer matches
    // the recorded steps has been edited by hand or built by a different
    // solver — fail loudly either way.
    for (const c of file.chains) {
      const solved = solveChain(c.start, c.target);
      if (!solved.ok) {
        throw new Error(
          `${path}: chain ${c.band} #${c.attempt} no longer solvable from start to target. The reference ` +
            `solver failed: ${solved.reason}. Regenerate the pool with:  npm run gen-pool`
        );
      }
      const v = verifyDerivation(c.start, c.target, c.steps);
      if (!v.ok || !v.reachedTarget) {
        throw new Error(
          `${path}: chain ${c.band} #${c.attempt} recorded steps no longer replay to its target. ` +
            `The pool was edited by hand. Regenerate with:  npm run gen-pool`
        );
      }
    }
  }

  if (chainListSha256(file.chains) !== file.sha256) {
    throw new Error(`${path}: the chain list does not match its recorded digest. The file has been edited by hand.`);
  }

  let chains = file.chains;
  let full = perBand == null;
  if (!full) {
    const taken = {};
    chains = file.chains.filter((c) => {
      taken[c.band] = (taken[c.band] ?? 0) + 1;
      return taken[c.band] <= perBand;
    });
  }
  return {
    chains,
    seed: file.generator.seed,
    full,
    sha256: chainListSha256(chains),
    publishedSha256: file.sha256,
    generator: file.generator,
  };
};

/**
 * Rebuild one chain from (start, target) on demand, independent of the
 * pool file. Useful for ad-hoc probes during development. Always re-derives
 * from scratch so the result reflects the current solver.
 */
export const rebuildChain = (chain) => {
  const solved = solveChain(chain.start, chain.target);
  return solved.ok ? solved : null;
};