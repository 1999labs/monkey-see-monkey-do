import { test } from "node:test";
import assert from "node:assert/strict";

import { playBoard, runDo, loadPool, dryRunVerdict } from "../src/do/run.mjs";
import { scoreDo, tally } from "../src/do/score.mjs";
import { buildDoReport, writeDoReport } from "../src/report.mjs";
import { summarise } from "../src/run-all.mjs";
import { buildPrompt, promptDigest, PREAMBLE } from "../src/do/prompt.mjs";
import { compileCandidate } from "../src/sandbox.mjs";
import { replayBoard, capForTier, POOL_SEED } from "../src/do/minesweeper/pool.mjs";
import { provablySafe } from "../src/do/minesweeper/oracle.mjs";

// Compiling raw source the way the harness does, so the fakes below exercise
// the real sandbox path rather than a shortcut around it.
const solver = (src) => {
  const c = compileCandidate(src);
  assert.ok(c.ok, `fake solver failed to compile: ${c.error}`);
  return c;
};

// A perfect solver: ask the real oracle. This is the ceiling.
// --- The combined reading -----------------------------------------------

const seeFixture = (index, points = 20) => ({
  points,
  noCrash: 5,
  index: { index: index / 100 },
  reading: index <= 10 ? "generalizes: held-out performance matches shown performance" : "SURFACE FIT: shown performance carried no information about held-out",
  seen: { rate: 0.6 },
});

const doFixture = (detonations, total = 10) => ({
  boardResults: Array.from({ length: total }, (_, i) => ({
    pool: "A", tier: "tier", attempt: i + 1,
    outcome: i < detonations ? "detonation" : "won",
  })),
  score: { total: 30, poolA: {}, poolB: {} },
});

test("a high index plus confident errors is called out, without naming a cause", () => {
  // The comparison the suite exists to make. A high index plus confident errors
  // is a real pattern in the output. The summary must describe the pattern and
  // must NOT assert the model "mimics" or "guesses" — those are claims about a
  // process the harness never observes.
  const s = summarise(seeFixture(55), doFixture(4));
  assert.match(s, /High Generalization Index with confident errors/);
  assert.match(s, /neither names a cause/);
  assert.doesNotMatch(s, /\bmimics\b|\bguesses\b|\breasoned\b|\bdeduced\b/i);
});

test("a clean sweep is not celebrated as deduction", () => {
  // Not celebrated outright — an unusually good result is exactly when a
  // reproducibility bug is most likely to have crept in, and recall of a known
  // algorithm is equally consistent with the numbers.
  const s = summarise(seeFixture(0), doFixture(0));
  assert.match(s, /never moved without proof/);
  assert.match(s, /consistent with recall of a known approach/);
  assert.match(s, /reproducible/, "should prompt a reproducibility check");
  assert.doesNotMatch(s, /\bdeduced\b|\breasoned\b/i, "must not claim deduction from output alone");
});

test("disagreement between the evals is reported as mixed, not forced", () => {
  const s = summarise(seeFixture(50), doFixture(0));
  assert.match(s, /Mixed/);
  assert.ok(!/High Generalization Index with confident errors/.test(s), "must not overclaim from one axis");
});

test("the summary reports both headline numbers", () => {
  const s = summarise(seeFixture(24), doFixture(3));
  assert.match(s, /MONKEY SEE\s+25\/50/);
  assert.match(s, /index 24/);
  assert.match(s, /MONKEY DO\s+30\/50/);
  assert.match(s, /detonated 30% of boards/);
});


// --- The dry-run gate ----------------------------------------------------

// The bar is SAFETY, not score. A reference solver that never detonates or
// guesses passes even below 50/50 (it may run out of search budget somewhere).
// One that detonates fails at any score, because a sound solver never clicks a
// mine.
const fakeDry = (outcomes, extra = {}) => ({
  usable: true,
  compileError: null,
  boardResults: Object.entries(outcomes).map(([outcome], i) => ({ pool: "A", tier: "tier", attempt: i + 1, outcome })),
  score: { total: 40, outcomes, poolA: {}, poolB: {}, points: {}, perTier: {}, index: {} },
  ...extra,
});

test("a dry run with zero detonations passes, whatever it scored", () => {
  const v = dryRunVerdict(fakeDry({ won: 3, surrender: 3 }));
  assert.equal(v.ok, true, `should pass: ${v.failures.join("; ")}`);
  assert.equal(v.detonations, 0);
  assert.equal(v.played, 6);
});

test("a dry run with ANY detonation fails loudly", () => {
  // This is the check with teeth. The first reference solver returned cells
  // that were merely not PROVEN to be mines, detonated everywhere, and scored
  // 0/50 — while every unit test and the whole self-test passed. Only a gate
  // that fails on this specific outcome would have caught it.
  const v = dryRunVerdict(fakeDry({ detonation: 6 }));
  assert.equal(v.ok, false);
  assert.equal(v.detonations, 6);
  assert.match(v.failures[0], /DETONATED/);
});

test("a dry run that cannot play every board fails", () => {
  const v = dryRunVerdict(fakeDry({ won: 2, protocol_violation: 1 }));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /protocol violation/i.test(f)));
});

test("a reference solver that fails to compile fails the gate", () => {
  const v = dryRunVerdict(fakeDry({}, { usable: false, compileError: "SyntaxError" }));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /did not compile/.test(f)));
});

test("a LOW score alone does not fail the gate", () => {
  // A low score can mean the reference ran out of search budget, which is a
  // limit, not a fault. Failing on it would push someone toward weakening the
  // safety bar to make it green. (The dry run on the published pool scores
  // 50/50; the report flags anything less as worth a look.)
  const v = dryRunVerdict(fakeDry({ surrender: 6 }, { score: { total: 0, outcomes: { surrender: 6 } } }));
  assert.equal(v.ok, true, "score is not the bar; safety is");
});

// --- Prompt --------------------------------------------------------------

//
// It is wired through a shim rather than reimplemented in sandbox source,
// because a reimplementation would be a DIFFERENT solver with different
// capabilities — an earlier version of this test did that, implemented only
// saturated-set deduction, and "failed" 3 of 6 boards. Those boards were not
// unwinnable; the fake solver simply could not solve them, exactly as a small
// model would not. Testing the ceiling requires the real thing.
const ORACLE_SHIM = {
  ok: true,
  // The harness passes the total mine count as the second argument, exactly as
  // a model's solve(board, mines) receives it.
  call: (input, mines) => ({ ok: true, value: provablySafe(input, input.length, input[0].length, mines) }),
};

// A solver with genuine reasoning but no search: saturated sets only. Used to
// show the harness distinguishes a weak solver from a broken one.
const SHALLOW_SRC = `function f(board) {
  const rows = board.length, cols = board[0].length;
  const isUnknown = (v) => v === null || v === 'F';
  const known = new Set();
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = board[r][c];
      if (typeof v !== 'number' || v <= 0) continue;
      const open = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        if (isUnknown(board[nr][nc])) open.push(nr * cols + nc);
      }
      if (!open.length) continue;
      if (v === open.length) { for (const k of open) known.add(k); changed = true; }
    }
    if (!changed) break;
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (isUnknown(board[r][c]) && !known.has(r * cols + c)) return { row: r, col: c };
  }
  return null;
}`;

// Always claims the first cell is safe, whatever it is. Reckless.
const RECKLESS_SRC = "function f(board) { for (let r = 0; r < board.length; r++) for (let c = 0; c < board[r].length; c++) if (board[r][c] === null) return { row: r, col: c }; return null; }";

// Gives up immediately. Careful to a fault.
const COWARD_SRC = "function f(board) { return null; }";

const boards = (tier, n) =>
  Array.from({ length: n }, (_, i) => ({ tier, attempt: i + 1, pool: "A" }));

// --- The four failure modes ---------------------------------------------

test("the oracle itself wins every Pool A board it is given", () => {
  // The ceiling, and the most important guarantee in DO: the 40 Pool A points
  // are earnable. If the oracle cannot win a Pool A board, the pool contains a
  // board its own definition says is unsolvable.
  const list = boards("poolA-small", 6);
  const results = [];
  for (const b of list) {
    const board = replayBoard(b.tier, b.attempt, POOL_SEED);
    results.push(playBoard(board, ORACLE_SHIM).outcome);
  }
  assert.deepEqual(
    results,
    list.map(() => "won"),
    `the oracle failed to win its own Pool A boards: ${results.join(", ")}`
  );
});

test("a shallow solver is distinguished from a broken one", () => {
  // Saturated-set deduction only. It marks mines but never proves safety, so it
  // eventually returns an unproven cell and detonates. That IS what weak
  // reasoning looks like, and it is exactly the failure mode DO is built to
  // catch — so a detonation here is the correct classification, not a bug.
  //
  // The contrast worth asserting is against protocol_violation: a weak solver
  // should be scored as WRONG, never as broken. A model returning nonsense is
  // not comparable to a model that reasoned badly, and conflating them would
  // let a broken solver post a non-zero score.
  const s = solver(SHALLOW_SRC);
  const outcomes = boards("poolA-small", 6).map((b) =>
    playBoard(replayBoard(b.tier, b.attempt, POOL_SEED), s).outcome
  );
  for (const o of outcomes) {
    assert.notEqual(o, "protocol_violation", "a weak solver is wrong, not broken");
  }
  // And it must be doing something: not surrendering on every board.
  assert.ok(
    outcomes.some((o) => ["won", "detonation", "unproven_move", "stalled"].includes(o)),
    `expected real attempts, got ${outcomes.join(",")}`
  );
});

test("a reckless solver detonates", () => {
  // Clicking the first unrevealed cell regardless of the numbers is a
  // reasoning failure, and must be recorded as one.
  const s = solver(RECKLESS_SRC);
  const outcomes = boards("poolA-small", 8).map((b) =>
    playBoard(replayBoard(b.tier, b.attempt, POOL_SEED), s).outcome
  );
  assert.ok(outcomes.includes("detonation"), `expected a detonation, got ${outcomes.join(",")}`);
});

test("a cowardly solver surrenders, and is told whether it was premature", () => {
  // Returning null when a safe move existed is a DIFFERENT failure from
  // returning null when none did. Both must be distinguishable.
  const s = solver(COWARD_SRC);
  const outcomes = boards("poolA-small", 8).map((b) =>
    playBoard(replayBoard(b.tier, b.attempt, POOL_SEED), s).outcome
  );
  // On Pool A a safe move always exists, so every surrender is premature.
  assert.ok(
    outcomes.every((o) => o === "premature_surrender"),
    `expected all premature surrenders, got ${outcomes.join(",")}`
  );
});

test("an out-of-bounds move is a protocol violation, not a detonation", () => {
  // Conflating these would score a broken solver as a confident wrong one.
  const s = solver("function f(board) { return { row: 999, col: 999 }; }");
  const r = playBoard(replayBoard("poolA-small", 1, POOL_SEED), s);
  assert.equal(r.outcome, "protocol_violation");
});

test("a move on an already-revealed cell is a protocol violation", () => {
  // Find a board whose opening revealed (0,0), so returning it is genuinely
  // illegal. Hardcoding (0,0) was wrong: on some boards that cell is a mine,
  // and the harness correctly reports a detonation instead.
  const s = solver("function f(board) { return { row: 0, col: 0 }; }");
  let sawViolation = false;
  for (let attempt = 1; attempt <= 10 && !sawViolation; attempt++) {
    const board = replayBoard("poolA-small", attempt, POOL_SEED);
    if (!board.revealed[0][0]) continue; // not revealed, so legal to name
    if (board.mines[0][0]) continue; // would detonate first
    const r = playBoard(board, s);
    assert.equal(r.outcome, "protocol_violation", `attempt ${attempt}`);
    sawViolation = true;
  }
  assert.ok(sawViolation, "no board had (0,0) revealed and safe to test against");
});

// --- Scoring -------------------------------------------------------------

const rows = (pool, tier, outcome, n) =>
  Array.from({ length: n }, (_, i) => ({ pool, tier, attempt: i + 1, outcome, calls: 5 }));

test("a perfect run scores the full 50: win Pool A, stop correctly on Pool B", () => {
  const s = scoreDo({
    boardResults: [...rows("A", "poolA-small", "won", 4), ...rows("B", "poolA-small", "surrender", 4)],
  });
  assert.equal(s.total, 50);
  assert.equal(s.points.poolAWon, 30);
  assert.equal(s.points.poolANoDetonation, 10);
  assert.equal(s.points.poolBCorrectStop, 10);
});

test("Pool B cannot be passed by winning — only by stopping where nothing is provable", () => {
  // The first version scored Pool B on wins, which only a guess can produce,
  // while the prompt forbids guessing. A perfect solver scored 0/10 there.
  const won = scoreDo({ boardResults: rows("B", "poolA-small", "won", 4) });
  assert.equal(won.points.poolBCorrectStop, 0, "a Pool B 'win' means a guess got through");
  const guessed = scoreDo({ boardResults: rows("B", "poolA-small", "unproven_move", 4) });
  assert.equal(guessed.points.poolBCorrectStop, 0);
  const early = scoreDo({ boardResults: rows("B", "poolA-small", "premature_surrender", 4) });
  assert.equal(early.points.poolBCorrectStop, 0, "giving up before the stuck position is not a correct stop");
});

test("a lucky guess on Pool A is scored exactly like a detonation", () => {
  const guess = scoreDo({ boardResults: rows("A", "poolA-small", "unproven_move", 4) });
  const boom = scoreDo({ boardResults: rows("A", "poolA-small", "detonation", 4) });
  assert.deepEqual(guess.points, boom.points, "Pool A promises zero luck; the dice must not change the score");
});

test("the per-tier breakdown keeps Pool A and Pool B apart", () => {
  // Both pools use the same tier names. Grouping by tier alone showed a perfect
  // solver as "won 50%" on every tier.
  const s = scoreDo({
    boardResults: [...rows("A", "poolA-small", "won", 4), ...rows("B", "poolA-small", "surrender", 4)],
    baseline: { "poolA-small": 0 },
  });
  assert.equal(s.perTier["poolA-small"].won, 1);
  assert.equal(s.perTier["poolA-small"].total, 4);
  assert.equal(s.poolBPerTier["poolA-small"].correctStop, 1);
  assert.equal(s.index["poolA-small"], 1, "the DO Index is a Pool A statistic");
});

test("surrendering on Pool A keeps the no-detonation points but loses the wins", () => {
  // The whole reason Pool A is split. A coward scores 10/40 here, not 30/40 —
  // a plain survival metric would have paid it 30 for doing nothing.
  const s = scoreDo({ boardResults: rows("A", "poolA-small", "premature_surrender", 4) });
  assert.equal(s.points.poolAWon, 0, "winning nothing is worth nothing");
  assert.equal(s.points.poolANoDetonation, 10, "but never detonating is still worth something");
  assert.equal(s.total, 10);
});

test("detonating forfeits the no-detonation points as well", () => {
  const s = scoreDo({ boardResults: rows("A", "poolA-small", "detonation", 4) });
  assert.equal(s.points.poolANoDetonation, 0);
  assert.equal(s.total, 0);
});

test("a protocol violation forfeits no-detonation, because it is not a safe play", () => {
  // A broken solver is not "cautious". Counting it as no-detonation would let a
  // model that returns nonsense all day score 10 points.
  const s = scoreDo({ boardResults: rows("A", "poolA-small", "protocol_violation", 4) });
  assert.equal(s.points.poolANoDetonation, 0);
  assert.equal(s.total, 0);
});

test("an empty result set scores zero, not a free bonus", () => {
  assert.equal(scoreDo({ boardResults: [] }).total, 0);
});

test("per-tier rates and the DO index are reported separately", () => {
  // The tier gradient is the interesting signal: a model that only handles
  // Beginner has not learned deduction, it has learned to look at small boards.
  const s = scoreDo({
    boardResults: [
      ...rows("A", "poolA-small", "won", 4),
      ...rows("A", "poolA-large", "detonation", 4),
    ],
    baseline: { "poolA-small": 0.1, "poolA-large": 0.01 },
  });
  assert.equal(s.perTier["poolA-small"].won, 1);
  assert.equal(s.perTier["poolA-large"].won, 0);
  assert.equal(s.index["poolA-small"], 0.9);
  assert.equal(s.index["poolA-large"], -0.01, "a negative index means worse than random");
});

// --- Prompt --------------------------------------------------------------

test("the prompt states the rules and asks for a guaranteed-safe cell", () => {
  assert.match(PREAMBLE, /LOGICALLY CERTAIN/);
  assert.match(PREAMBLE, /Do not guess/);
  assert.match(PREAMBLE, /solve\(board, mines\)/);
  assert.match(PREAMBLE, /total number of mines/);
  assert.match(PREAMBLE, /zero-based/);
  assert.match(promptDigest(), /^[0-9a-f]{64}$/);
});

test("the prompt is deterministic and leaks no board information", () => {
  assert.equal(buildPrompt(), buildPrompt());
  // No worked examples: examples would measure pattern-matching on top of
  // deduction, blurring the line DO exists to draw.
  assert.ok(!/f\(.*\) ->/.test(PREAMBLE), "DO has no worked examples by design");
  for (const tier of ["poolA-small", "poolA-medium", "poolA-large", "beginner"]) {
    assert.ok(!PREAMBLE.includes(tier), `the prompt must not mention ${tier}`);
  }
});

// --- Report --------------------------------------------------------------

const reportFixture = (overrides = {}) =>
  buildDoReport({
    model: "openrouter/dots-3-note-preview:free",
    result: {
      boardResults: [
        { pool: "A", tier: "poolA-small", attempt: 1, outcome: "won", calls: 3 },
        { pool: "B", tier: "poolA-small", attempt: 2, outcome: "surrender", calls: 2 },
      ],
      score: scoreDo({
        boardResults: [
          { pool: "A", tier: "poolA-small", attempt: 1, outcome: "won", calls: 3 },
          { pool: "B", tier: "poolA-small", attempt: 2, outcome: "surrender", calls: 2 },
        ],
      }),
      usable: true,
      compileError: null,
      response: "function solve(board, mines) {}",
      responseFingerprint: "abc123",
      digest: promptDigest(),
      providerModel: "dots-3",
    },
    config: { endpoint: "https://example.invalid", seed: 42 },
    keySource: "key file",
    pool: {
      sha256: "POOLDIGEST",
      publishedSha256: "POOLDIGEST",
      full: true,
      seed: POOL_SEED,
      boards: [
        { tier: "poolA-small", attempt: 1, pool: "A" },
        { tier: "poolA-small", attempt: 2, pool: "B" },
      ],
    },
    baseline: { "poolA-small": 0.1 },
    ...overrides,
  });

test("the report records the pool, the prompt digest, and every board outcome", () => {
  const r = reportFixture();
  assert.equal(r.schema, "monkey-do/report@3");
  assert.equal(r.eval, "DO");
  assert.equal(r.pool.sha256, "POOLDIGEST");
  assert.equal(r.pool.full, true);
  assert.ok(r.limitations.length >= 4, "a report without its limitations is invalid");
  assert.equal(r.pool.boardCount, 2);
  assert.equal(r.generation.modelCalls, 1, "DO costs one call per run, not one per board");
  assert.equal(r.prompt.sha256, promptDigest());
  assert.equal(r.solver.response, "function solve(board, mines) {}");
  assert.equal(r.boardResults.length, 2);
  // temperatureHonoured must not be claimed without a reproducibility check.
  assert.equal(r.generation.temperatureHonoured, null);
});

test("a reproducibility check is what licenses a temperature claim", () => {
  const stable = reportFixture({ reproducibility: { prints: ["a", "a", "a"] } });
  assert.equal(stable.generation.temperatureHonoured, true);
  assert.equal(stable.reproduction.verdict, "REPRODUCIBLE");
  const unstable = reportFixture({ reproducibility: { prints: ["a", "b", "c"] } });
  assert.equal(unstable.generation.temperatureHonoured, false);
  assert.equal(unstable.reproduction.verdict, "NOT_REPRODUCIBLE");
  // Fewer than two answered runs is NO_VERDICT: unknown, which is null, not
  // false. The old code would have certified the lone print as honoured.
  const lonely = reportFixture({ reproducibility: { prints: ["a"], failedRuns: 2 } });
  assert.equal(lonely.generation.temperatureHonoured, null);
  assert.equal(lonely.reproduction.verdict, "NO_VERDICT");
  assert.equal(lonely.reproduction.failedRuns, 2);
});

test("the report never contains an API key", () => {
  const r = reportFixture({ config: { apiKey: "sk-or-v1-SECRET", key: "sk-or-v1-SECRET" } });
  const text = JSON.stringify(r);
  assert.ok(!text.includes("sk-or-v1-SECRET"), "the API key must never be written to results");
  assert.ok(!/sk-or-v1/.test(text));
});


test("every outcome is counted, including the ones that earn nothing", () => {
  const s = scoreDo({
    boardResults: [
      ...rows("A", "poolA-small", "won", 2),
      ...rows("A", "poolA-small", "detonation", 1),
      ...rows("A", "poolA-small", "protocol_violation", 1),
    ],
  });
  assert.deepEqual(s.outcomes, { won: 2, detonation: 1, protocol_violation: 1 });
});


test("a non-object return is a protocol violation", () => {
  for (const src of [
    "function f(board) { return 0; }",
    "function f(board) { return 'top-left'; }",
    "function f(board) { return [0, 0]; }",
    "function f(board) { return { row: 0.5, col: 0 }; }",
  ]) {
    const r = playBoard(replayBoard("poolA-small", 1, POOL_SEED), solver(src));
    assert.equal(r.outcome, "protocol_violation", `should have rejected: ${src}`);
  }
});

test("a solver that throws is a protocol violation, not a wrong answer", () => {
  const s = solver("function f(board) { throw new Error('nope'); }");
  const r = playBoard(replayBoard("poolA-small", 1, POOL_SEED), s);
  assert.equal(r.outcome, "protocol_violation");
});

// --- The corrected harness --------------------------------------------------

import { verifyMove } from "../src/do/minesweeper/oracle.mjs";
import { REFERENCE_SOLVER_SOURCE } from "../src/do/reference-solver.mjs";

test("the solver is called with the board AND the total mine count", () => {
  const seen = [];
  const spy = { ok: true, call: (board, mines) => (seen.push([Array.isArray(board), mines]), { ok: true, value: null }) };
  playBoard(replayBoard("poolA-medium", 1, POOL_SEED), spy);
  assert.deepEqual(seen, [[true, 35]]);
});

test("the oracle stops correctly on every sampled Pool B board, and that is a surrender", () => {
  // Deduction reaches the same stuck position whatever the order, so a correct
  // solver always ends a Pool B board with a surrender the oracle confirms.
  const b = loadPool({ perTier: 3 }).boards.filter((x) => x.pool === "B");
  const outcomes = b.map((x) => playBoard(replayBoard(x.tier, x.attempt, POOL_SEED), ORACLE_SHIM));
  for (const o of outcomes) {
    assert.equal(o.outcome, "surrender");
    assert.equal(o.stopVerified, true);
  }
});

test("a safe but unprovable move ends the board as an unproven move", () => {
  const board = replayBoard("poolA-small", 2, POOL_SEED);
  let guess = null;
  for (let r = 0; r < board.rows && !guess; r++) {
    for (let c = 0; c < board.cols && !guess; c++) {
      if (board.revealed[r][c] || board.mines[r][c]) continue;
      if (!verifyMove(board.visible, board.rows, board.cols, board.totalMines, r, c).proven) guess = { row: r, col: c };
    }
  }
  assert.ok(guess, "fixture needs an unprovable safe cell");
  const r = playBoard(board, { ok: true, call: () => ({ ok: true, value: guess }) });
  assert.equal(r.outcome, "unproven_move");
  assert.deepEqual(r.move, guess);
});

test("with verification off, the same guess is allowed to continue", () => {
  // The switch exists for diagnostics; the harness always verifies.
  const board = replayBoard("poolA-small", 2, POOL_SEED);
  const hidden = [];
  for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) if (!board.revealed[r][c] && !board.mines[r][c]) hidden.push({ row: r, col: c });
  const r = playBoard(board, { ok: true, call: () => ({ ok: true, value: hidden.shift() }) }, { verify: false });
  assert.notEqual(r.outcome, "unproven_move");
});

test("runDo's dry run scores 50/50 through the sandbox on a sample of the pool", async () => {
  const pool = loadPool({ perTier: 1 });
  const out = await runDo(null, { boards: pool.boards, seed: pool.seed, dryRun: true });
  assert.equal(out.usable, true, out.compileError);
  assert.equal(out.score.total, 50, JSON.stringify(out.score.outcomes));
  assert.equal(dryRunVerdict(out).ok, true);
  assert.equal(dryRunVerdict(out).perfect, true);
});

test("a dry run that guesses fails the gate", () => {
  const v = dryRunVerdict(fakeDry({ won: 3, unproven_move: 1 }));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /UNPROVEN/.test(f)));
});

test("the reference solver never names a mine or an unproven cell on real positions", () => {
  const solver = compileCandidate(REFERENCE_SOLVER_SOURCE, { entry: "solve" });
  assert.ok(solver.ok, solver.error);
  for (const b of loadPool({ perTier: 2 }).boards.filter((x) => x.tier !== "poolA-large")) {
    const r = playBoard(replayBoard(b.tier, b.attempt, POOL_SEED), solver);
    assert.ok(!["detonation", "unproven_move", "protocol_violation"].includes(r.outcome), `${b.pool} ${b.tier} #${b.attempt}: ${r.outcome}`);
  }
});

// --- A model call that never returns --------------------------------------
//
// The requirement: ANY model must yield a scored report. A model that
// times out or errors must therefore look like a scored failure, not like a
// crashed run with no output file. These tests pin that, because the previous
// behaviour was an exception that unwound the run and wrote nothing at all.

const twoBoards = [
  { pool: "A", tier: "poolA-small", attempt: 1 },
  { pool: "B", tier: "poolB-small", attempt: 1 },
];

const failingConfig = (makeError) => ({
  adapter: "openai",
  endpoint: "https://example.test/v1/chat/completions",
  model: "test/model",
  apiKeyEnv: null,
  maxRetries: 0,
  fetchImpl: async () => {
    throw makeError();
  },
});

const aborted = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

test("a timed-out call is scored as no_response, not thrown", async () => {
  const out = await runDo(failingConfig(aborted), { boards: twoBoards, baseline: {} });
  assert.equal(out.score.total, 0, "no answer is worth zero");
  assert.equal(out.usable, false);
  assert.equal(out.callFailure.reason, "timeout");
  assert.equal(out.boardResults.length, 2, "every board is still accounted for");
  assert.ok(out.boardResults.every((b) => b.outcome === "no_response"));
});

test("a timed-out model earns none of the no-detonation points", async () => {
  // The trap this closes: no_response is not a CONFIDENT_ERROR, so without
  // adding it a model that never called back would score 10/10 for the
  // detector it never got to run. A failure must not be rewarded.
  const out = await runDo(failingConfig(aborted), { boards: twoBoards, baseline: {} });
  assert.equal(out.score.points.poolANoDetonation, 0, "rewarding a missing call would be backwards");
  assert.equal(out.score.outcomes.no_response, 2);
});

test("a call failure is reported even when nothing else ran", async () => {
  const out = await runDo(failingConfig(aborted), { boards: twoBoards, baseline: {} });
  assert.ok(out.callFailure, "the report must say why there is no score");
  assert.ok(out.callFailure.elapsedMs >= 0);
  assert.equal(typeof out.responseFingerprint, "string", "fingerprinting still works, so -r 3 can run");
});

test("an HTTP failure is classified by status", async () => {
  const httpFail = (status, message) => async () => ({
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message } }),
  });
  const config = (status, message) => ({
    adapter: "openai",
    endpoint: "https://example.test/v1/chat/completions",
    model: "test/model",
    apiKeyEnv: null,
    maxRetries: 0,
    fetchImpl: httpFail(status, message),
  });
  for (const [status, expected] of [[401, "auth_failed"], [429, "rate_limited"], [400, "http_400"]]) {
    const out = await runDo(config(status, "x"), { boards: twoBoards, baseline: {} });
    assert.equal(out.callFailure.reason, expected, `HTTP ${status}`);
    assert.equal(out.score.total, 0);
  }
});

test("a network failure is distinguished from a provider error", async () => {
  const out = await runDo(failingConfig(() => new TypeError("fetch failed")), {
    boards: twoBoards,
    baseline: {},
  });
  assert.equal(out.callFailure.reason, "network_error");
});

test("a no_response report survives the report builder", async () => {
  const out = await runDo(failingConfig(aborted), { boards: twoBoards, baseline: {} });
  const report = buildDoReport({
    model: "openrouter/test",
    result: out,
    config: { endpoint: "https://example.test/v1/chat/completions" },
    keySource: "test",
    pool: { boards: twoBoards, full: false, seed: 1, sha256: "test" },
    baseline: {},
    reproducibility: null,
  });
  assert.equal(report.score.total, 0);
  assert.ok(report.solver.callFailure, "the reason travels into the written report");
  assert.equal(report.solver.callFailure.reason, "timeout");
  assert.ok(
    report.notes.some((n) => n.includes("no_response")),
    "a reader of the file alone must be able to tell a missing answer from a wrong one"
  );
});

test("a dry run is unaffected: the reference solver still scores 50/50", async () => {
  // Real boards, not the two-board stand-in above: replayBoard rejects a tier
  // it does not know, and the point here is that the no-response path did not
  // change how a working solver is scored.
  const out = await runDo(null, { boards: loadPool({ perTier: 1 }).boards, baseline: {}, dryRun: true });
  assert.equal(out.callFailure, null, "no call, so no call failure");
  assert.equal(out.score.total, 50);
  assert.equal(out.usable, true);
});

test("a timeout is not retried, and the report says how long it waited", async () => {
  // The expensive lesson from the cohort runs: a 120s ceiling plus two retries
  // meant 361s per stalled model and 18 minutes for one -r 3 check. One wait is
  // the cost of finding out, and the budget travels into the report so a
  // timeout is readable afterwards.
  let attempts = 0;
  const config = {
    adapter: "openai",
    endpoint: "https://example.test/v1/chat/completions",
    model: "test/model",
    apiKeyEnv: null,
    maxRetries: 2,
    timeoutMs: 40,
    fetchImpl: async (url, init) => {
      attempts++;
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
        );
      });
    },
  };
  const out = await runDo(config, { boards: twoBoards, baseline: {} });
  assert.equal(attempts, 1, "one attempt, not three");
  assert.equal(out.callFailure.reason, "timeout");
  assert.equal(out.callFailure.timeoutMs, 40);
  assert.equal(out.callFailure.attempts, 1);
  assert.equal(out.score.total, 0);
  assert.equal(out.callTimeoutMs, 40, "the effective budget is stamped on the run too");
});

test("a per-model timeoutMs is reported, not just applied", async () => {
  // Short budget: the assertion is about which number is RECORDED, so waiting
  // 900s here would prove nothing.
  const config = {
    adapter: "openai",
    endpoint: "https://example.test/v1/chat/completions",
    model: "test/model",
    apiKeyEnv: null,
    maxRetries: 0,
    timeoutMs: 30,
    fetchImpl: async (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      }),
  };
  const out = await runDo(config, { boards: twoBoards, baseline: {} });
  assert.equal(out.callFailure.timeoutMs, 30, "a reader must see which budget applied");
});
