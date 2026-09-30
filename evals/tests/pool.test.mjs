// MONKEY DO — the board pool.
//
// The pool's entire value rests on one property: regenerating it from the seed
// must produce the same boards, so that any published score can be checked
// against the boards it was scored on. A pool that cannot be regenerated is not
// a benchmark, it is an anecdote.
//
// These tests are therefore mostly about determinism, plus the guarantees that
// make a stored board meaningful: that replaying it reproduces its
// classification, and that a board is never accepted into a pool whose claim it
// does not support.
import { test } from "node:test";
import assert from "node:assert/strict";

import { layoutDigest, reveal, isWon } from "../src/do/minesweeper/board.mjs";
import { analyse } from "../src/do/minesweeper/oracle.mjs";
import {
  POOL_SEED,
  callsFor,
  capForTier,
  classifyBoard,
  generatePool,
  replayBoard,
  poolDigest,
  ENDGAME_HIDDEN_FRACTION,
  MIN_CALLS,
  CELLS_PER_CALL,
} from "../src/do/minesweeper/pool.mjs";
import { TIERS } from "../src/do/minesweeper/board.mjs";

// A small pool. Big enough to exercise rejection sampling across several
// attempts, small enough to run in a unit test. poolA-small has the highest
// measured acceptance rate (~68%), so a handful of boards needs few attempts.
const SMALL = { "poolA-small": 4 };

// --- The cap ------------------------------------------------------------

test("the call cap scales with board size, and never drops below the floor", () => {
  // The regression this guards has happened TWICE. A hardcoded 24 truncated the
  // oracle on 85% of small-tier boards. Replacing it with CELLS_PER_CALL = 4,
  // fitted to the small tier alone, then truncated 13 of 20 MEDIUM boards. Both
  // looked like a property of the game rather than of the cap.
  //
  // So the divisor is now set below the worst measured tier (medium needs 2.74
  // cells per call; small 3.79; large 3.57) rather than at one tier's median.
  const beginner = callsFor(9, 9, 10);
  const big = callsFor(19, 23, 62);
  assert.ok(big > beginner, `a 437-cell board needs more than ${beginner}, got ${big}`);

  // A tiny board hits the floor, which exists to stop a small board from being
  // effectively uncapped.
  assert.equal(callsFor(2, 2, 1), MIN_CALLS, "a 2x2 board uses the floor");
});

test("every Pool A tier's cap exceeds what the oracle actually needs", () => {
  // The decisive check, and the one that would have caught both past mistakes.
  // Measured true call counts (unbounded cap, 20 boards/tier):
  //   small  median 33  max 52
  //   medium median 74  max 96
  //   large  median 105 max 135
  // If a cap ever falls below the observed maximum, boards the oracle can win
  // are being rejected — and that failure is invisible in the output, it just
  // looks like a hard game.
  for (const tier of ["poolA-small", "poolA-medium", "poolA-large"]) {
    const observedMax = { "poolA-small": 52, "poolA-medium": 96, "poolA-large": 135 }[tier];
    const cap = capForTier(tier);
    assert.ok(
      cap >= observedMax,
      `${tier}: cap ${cap} is below the observed max ${observedMax} — boards will be wrongly rejected`
    );
  }
});

test("capForTier matches callsFor, so the harness cannot drift from the pool", () => {
  for (const [tier, spec] of Object.entries(TIERS)) {
    assert.equal(
      capForTier(tier),
      callsFor(spec.rows, spec.cols, spec.mines),
      `${tier}: the model-facing cap must be the same value the pool used`
    );
  }
});

test("capForTier rejects an unknown tier rather than returning a default", () => {
  // A typo'd tier name silently falling back to a floor value would cap a 437
  // cell board at 24 calls, which is the original bug.
  assert.throws(() => capForTier("poolA-huge"), /unknown tier/);
});

test("the cap is derived from CELLS_PER_CALL, and the constant is conservative", () => {
  // 2 is the documented, measured choice. It is asserted rather than merely
  // used, so that changing it is a deliberate act and the comment above has to
  // be updated with it.
  assert.equal(CELLS_PER_CALL, 2, "see the v3 history in pool.mjs before changing this");
  // 203 safe cells / 2 = 102, + 12 headroom = 114, which clears the medium
  // tier's observed max of 96.
  assert.equal(callsFor(14, 17, 35), 114);
});

test("a denser board needs fewer calls than a sparse one of the same size", () => {
  // Fewer non-mine cells means less to reveal, so a smaller cap is correct.
  const sparse = callsFor(16, 16, 20);
  const dense = callsFor(16, 16, 90);
  assert.ok(sparse >= dense, `sparse ${sparse} should not need fewer than dense ${dense}`);
});

test("the cap is big enough that the oracle wins most boards", () => {
  // The measurement that justified the change, kept as a test so the cap cannot
  // silently regress. Re-measured at 93% won on this tier with the v3 cap; the
  // threshold is set well below that so ordinary seed variance will not make
  // this flaky, but a return to a tight cap will fail loudly.
  let won = 0;
  const N = 30;
  for (let i = 1; i <= N; i++) {
    const board = replayBoard("poolA-small", i, POOL_SEED);
    if (classifyBoard(board).won) won++;
  }
  assert.ok(
    won / N > 0.6,
    `oracle won only ${won}/${N} — the cap is probably too tight again`
  );
});

// --- Reproducibility: the property the whole module exists for -----------

test("the same seed regenerates a byte-identical pool", () => {
  const a = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  const b = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  assert.equal(poolDigest(a), poolDigest(b), "the same seed must give the same pool");
  assert.deepEqual(
    a["poolA-small"].boards.map((x) => x.attempt),
    b["poolA-small"].boards.map((x) => x.attempt),
    "and the same accepted boards, in the same order"
  );
});

test("a different seed gives a different pool", () => {
  const a = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  const c = generatePool({ seed: POOL_SEED + 1, count: SMALL, want: "A" });
  assert.notEqual(poolDigest(a), poolDigest(c), "the seed must actually matter");
});

test("every stored board can be replayed exactly, and still classifies the same", () => {
  // The strongest guarantee here. A stored board is only meaningful if the
  // attempt index rebuilds the same puzzle AND the oracle still agrees about it.
  // This catches opening drift, oracle changes, and cap changes alike — any of
  // which would silently invalidate a published score.
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  for (const stored of pool["poolA-small"].boards) {
    const replayed = replayBoard(stored.tier, stored.attempt, POOL_SEED);
    assert.equal(
      layoutDigest(replayed),
      layoutDigest({ mines: stored.mines, rows: replayed.rows, cols: replayed.cols }),
      `board at attempt ${stored.attempt} did not replay to the same mine layout`
    );
    const result = classifyBoard(replayed);
    assert.equal(result.won, true, `board at attempt ${stored.attempt} no longer wins`);
    assert.equal(result.calls, stored.calls, "and takes the same number of calls");
  }
});

test("replayBoard is deterministic across repeated calls", () => {
  for (const attempt of [1, 7, 42]) {
    const a = layoutDigest(replayBoard("poolA-small", attempt, POOL_SEED));
    const b = layoutDigest(replayBoard("poolA-small", attempt, POOL_SEED));
    assert.equal(a, b, `attempt ${attempt} did not replay identically`);
  }
});

test("the pool digest changes when the opening changes, not just the mines", () => {
  // Two boards can share a mine layout and still be different puzzles, because
  // the opening decides what the solver can see. A digest over mines alone would
  // call those identical, and two different scores would share a digest.
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  const stored = pool["poolA-small"].boards[0];
  const original = poolDigest(pool);

  // Same mines, different opening: shift the attempt so the reveal differs.
  const shifted = {
    "poolA-small": {
      boards: [{ ...stored, attempt: stored.attempt + 1 }],
    },
  };
  assert.notEqual(
    poolDigest(shifted),
    original,
    "the digest must notice a changed attempt index"
  );
});

// --- A board is only accepted into a pool it actually belongs to ---------

test("every Pool A board is winnable by the oracle without guessing", () => {
  // Pool A claims "pure deduction, zero luck". If a stored board can be won only
  // by guessing, the claim is false for that board and its 40 points are
  // measuring luck.
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  for (const stored of pool["poolA-small"].boards) {
    const board = replayBoard(stored.tier, stored.attempt, POOL_SEED);
    // Replay the whole game, asserting a certain move at every single step.
    let calls = 0;
    while (!isWon(board) && calls <= 200) {
      const verdict = analyse(board.visible, board.rows, board.cols, board.totalMines);
      assert.ok(verdict.conclusive, "a Pool A board must never need an inconclusive search");
      assert.ok(verdict.deducible, `a Pool A board stalled at step ${calls} — it was never solvable`);
      assert.ok(!board.mines[verdict.move.row][verdict.move.col], "the oracle must never step on a mine");
      reveal(board, verdict.move.row, verdict.move.col);
      calls++;
    }
    assert.ok(isWon(board), "the board must actually be won, not merely un-stalled");
  }
});

test("a Pool A board is never accepted on the strength of a guess", () => {
  // The inverse check, stated separately because it is the failure that would
  // be most damaging: a board that only a guess could finish, quietly filed as
  // "solvable", inflating Pool A with luck.
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  for (const stored of pool["poolA-small"].boards) {
    const result = classifyBoard(replayBoard(stored.tier, stored.attempt, POOL_SEED));
    assert.equal(result.won, true, "stored Pool A boards must classify as won");
    assert.equal(result.pool, "A");
  }
});

test("Pool B boards are genuine endgames, not hard boards", () => {
  // Pool B claims a guess is REQUIRED. That is only true if the position is
  // ambiguous with few cells left. A board that stalls with most of itself
  // hidden is a wall, not a coin flip.
  const pool = generatePool({ seed: POOL_SEED, count: { "poolA-small": 2 }, want: "B" });
  for (const stored of pool["poolA-small"].boards) {
    const result = classifyBoard(replayBoard(stored.tier, stored.attempt, POOL_SEED));
    assert.equal(result.pool, "B", "stored Pool B boards must classify as B");
    assert.equal(result.isEndgame, true, "a Pool B board must be an endgame ambiguity");
    assert.ok(
      result.hiddenAtStall <= ENDGAME_HIDDEN_FRACTION,
      `Pool B board stalled with ${result.hiddenAtStall} hidden, above the endgame threshold`
    );
  }
});

test("an unclassifiable board is never accepted into either pool", () => {
  // A board the oracle could not resolve must be discarded, not filed as
  // "ambiguous". Pool B asserts no safe move exists; an exhausted search has
  // not proven that.
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  for (const stored of pool["poolA-small"].boards) {
    const result = classifyBoard(replayBoard(stored.tier, stored.attempt, POOL_SEED));
    assert.notEqual(result.pool, null, "an unclassifiable board must never be stored");
  }
});

test("generation reports why boards were rejected, and the numbers add up", () => {
  // A silently collapsing acceptance rate is the kind of thing that only shows
  // up as a mystery score months later.
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  const { stats, boards } = pool["poolA-small"];
  const accounted = boards.length + stats.rejectedWrongPool + stats.rejectedUnclassifiable + stats.rejectedHardStall;
  assert.equal(accounted, stats.attempts, "every attempt must be accounted for");
  assert.ok(stats.attempts >= boards.length, "attempts must be at least the accepted count");
});

test("a pool that cannot be filled fails loudly rather than returning short", () => {
  // Silently returning fewer boards than asked for would produce a score that
  // looks like any other but was computed over a different sample.
  assert.throws(
    () => generatePool({ seed: POOL_SEED, count: { "poolA-small": 100000 }, want: "A", maxAttempts: 50 }),
    /only accepted/
  );
});

test("the pool stores the attempt index, so boards are addressable", () => {
  const pool = generatePool({ seed: POOL_SEED, count: SMALL, want: "A" });
  for (const stored of pool["poolA-small"].boards) {
    assert.equal(typeof stored.attempt, "number", "a board without an attempt index cannot be replayed");
    assert.ok(stored.attempt > 0, "attempt indices start at 1");
  }
});

test("the pool digest does not depend on key order", () => {
  const one = generatePool({ seed: POOL_SEED, count: { "poolA-small": 2 }, want: "A" });
  const two = {
    "poolA-small": one["poolA-small"],
  };
  assert.equal(poolDigest(one), poolDigest(two), "digest must be order-independent");
});

// --- The published pool ---------------------------------------------------

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPublishedPool,
  buildPublishedPool,
  serializePool,
  boardListSha256,
  POOL_FILE,
  PUBLISHED_PER_TIER,
  GENERATOR_VERSION,
} from "../src/do/minesweeper/pool.mjs";

test("the published pool loads, verifies, and holds the documented counts", () => {
  const pool = loadPublishedPool();
  assert.equal(pool.full, true);
  assert.equal(pool.seed, POOL_SEED);
  assert.equal(pool.boards.filter((b) => b.pool === "A").length, PUBLISHED_PER_TIER.A * 3);
  assert.equal(pool.boards.filter((b) => b.pool === "B").length, PUBLISHED_PER_TIER.B * 3);
  assert.equal(pool.sha256, pool.publishedSha256);
});

test("the pool digest covers BOTH pools", () => {
  // The first digest hashed { ...poolA, ...poolB }. Both use the same tier
  // names, so Pool B overwrote Pool A and the digest covered Pool B alone.
  const { boards, sha256 } = loadPublishedPool();
  const onlyB = boardListSha256(boards.filter((b) => b.pool === "B"));
  assert.notEqual(sha256, onlyB);
  const flipped = boards.map((b, i) => (i === 0 ? { ...b, attempt: b.attempt + 1 } : b));
  assert.notEqual(boardListSha256(flipped), sha256, "changing one Pool A board must change the digest");
});

test("a subset takes a deterministic prefix per pool and tier, and says so", () => {
  const sub = loadPublishedPool({ perTier: 2 });
  assert.equal(sub.full, false);
  assert.equal(sub.boards.length, 12, "2 boards x 3 tiers x 2 pools");
  assert.notEqual(sub.sha256, sub.publishedSha256);
  assert.deepEqual(loadPublishedPool({ perTier: 2 }).boards, sub.boards);
});

test("a tampered pool file is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "md-pool-"));
  const original = JSON.parse(readFileSync(POOL_FILE, "utf8"));

  const badLayout = structuredClone(original);
  badLayout.boards[5].layout = "0000000000000000";
  writeFileSync(join(dir, "layout.json"), JSON.stringify(badLayout));
  assert.throws(() => loadPublishedPool({ path: join(dir, "layout.json") }), /no longer replays/);

  const oldGenerator = structuredClone(original);
  oldGenerator.generator.version = GENERATOR_VERSION - 1;
  writeFileSync(join(dir, "gen.json"), JSON.stringify(oldGenerator));
  assert.throws(() => loadPublishedPool({ path: join(dir, "gen.json") }), /different generator/);

  const edited = structuredClone(original);
  edited.boards.pop();
  writeFileSync(join(dir, "edited.json"), JSON.stringify(edited));
  assert.throws(() => loadPublishedPool({ path: join(dir, "edited.json") }), /recorded digest/);

  assert.throws(() => loadPublishedPool({ path: join(dir, "missing.json") }), /npm run gen-pool/);
});

test("building and serializing a pool is byte-deterministic", () => {
  const perTier = { A: 2, B: 1 };
  const a = serializePool(buildPublishedPool({ perTier }));
  const b = serializePool(buildPublishedPool({ perTier }));
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a).perTier, perTier);
});

test("the published file starts with the same boards a small regeneration produces", () => {
  // A cheap slice of `gen-pool --check`: the first boards of each (pool, tier)
  // do not depend on how many are requested.
  const small = buildPublishedPool({ perTier: { A: 2, B: 1 } }).boards;
  const published = loadPublishedPool({ perTier: 2 }).boards;
  for (const b of small) {
    assert.ok(
      published.some((p) => p.pool === b.pool && p.tier === b.tier && p.attempt === b.attempt && p.layout === b.layout),
      `Pool ${b.pool} ${b.tier} attempt ${b.attempt} is missing from pool.json — regenerate with npm run gen-pool`
    );
  }
});
