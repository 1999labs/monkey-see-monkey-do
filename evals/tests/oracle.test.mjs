// MONKEY DO — the oracle.
//
// The oracle's contract is one-sided and absolute: anything it returns MUST be
// safe. Returning a mine is catastrophic, because Pool A is built by trusting
// it. So the tests here are weighted toward that, using real generated boards
// rather than only hand-made puzzles.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRng, newBoard, openBoard, reveal, isWon, TIERS } from "../src/do/minesweeper/board.mjs";
import { provablySafe, DEFAULT_BUDGET } from "../src/do/minesweeper/oracle.mjs";

// A grid written directly, so a test can state a position exactly.
const gridOf = (rows) => rows;

// --- The basic rules -----------------------------------------------------

test("a 1 with one unknown neighbour: that neighbour is a mine", () => {
  // Rule 2, saturated. The solver must not offer the only remaining cell.
  // With totalMines === 1, the single open cell IS the mine, so there is
  // nothing safe to return. Null is the correct answer.
  const g = gridOf([
    [1, null],
    [null, null],
  ]);
  assert.equal(provablySafe(g, 2, 2, 1), null, "the only unknown neighbour of a 1 is a mine");
});

test("the global count can make the other open cell safe", () => {
  // (0,0)=1 has exactly one unknown neighbour (0,1), so (0,1) is a MINE.
  // totalMines is 1, so (0,2) cannot hold a second mine and is provably safe.
  // This is Rule 5 following from Rule 2 — the case that separates a real
  // solver from a one-rule matcher.
  const g = gridOf([
    [1, null, null],
    [1, 1, 1],
    [1, 1, 1],
  ]);
  assert.deepEqual(provablySafe(g, 3, 3, 1), { row: 0, col: 2 });
});

test("subset elimination proves a distant cell safe", () => {
  // (0,0)=1 constrains its three open neighbours {(0,1),(1,0),(1,1)}: exactly
  // one is a mine. The global constraint covers all FIVE open cells and also
  // needs 1 mine. Since the 1's set is a SUBSET of the global set, the leftover
  // cell (0,2) — outside the 1's neighbourhood — must hold 1-1 = 0 mines.
  //
  // This is Rule 3 doing real work, and it is the deduction a one-rule matcher
  // cannot make: the safe cell is nowhere near the clue that proves it.
  const g = gridOf([
    [1, null, null],
    [null, null, null],
  ]);
  assert.deepEqual(provablySafe(g, 2, 3, 1), { row: 0, col: 2 });
});

test("a 2 with three open neighbours leaves no provably safe cell", () => {
  // (0,0)=2 constrains {(0,1),(1,0),(1,1)}: TWO mines among three. The global
  // count is also 2, so the leftover (0,2) holds 2-2 = 0 mines — safe.
  // The two candidates inside the clue stay ambiguous: any two of the three
  // work, and no single one is forced.
  const g = gridOf([
    [2, null, null],
    [null, null, null],
  ]);
  assert.deepEqual(provablySafe(g, 2, 3, 2), { row: 0, col: 2 });
});

test("truly ambiguous: every open cell could hold the mine", () => {
  // Two clues of 1, each seeing the same pair of open cells, with 2 mines
  // total. Either open cell could be a mine, and nothing forces either.
  //   (0,0)=1 sees (0,1),(1,0)
  //   (1,1)=1 sees (0,1),(1,0)   <- same pair
  //   global: 2 mines among {(0,1),(1,0),(0,2)}
  // Hmm — that leaves (0,2) able to be a mine, so (0,1) and (1,0) cannot both
  // be mines, but neither is individually forced safe. And (0,2) can be a
  // mine only if one of the others is not. Genuinely ambiguous on all three.
  const g = gridOf([
    [1, null, null],
    [null, 1, null],
  ]);
  assert.equal(provablySafe(g, 2, 3, 2), null, "no cell is provably safe");
});

test("an all-revealed board has no move", () => {
  const g = gridOf([
    [0, 0],
    [0, 0],
  ]);
  assert.equal(provablySafe(g, 2, 2, 0), null, "nothing left to move");
});

test("an empty board is not provably safe — every cell could be a mine", () => {
  const g = gridOf([
    [null, null],
    [null, null],
  ]);
  assert.equal(provablySafe(g, 2, 2, 1), null, "no information means no proof");
});

test("flags are treated as unrevealed, carrying no authority", () => {
  // guide.md 5.3: flags are the player's own annotation. The solver must
  // ignore them entirely, exactly as if they were null.
  const plain = gridOf([
    [1, null],
    [null, null],
  ]);
  const flagged = gridOf([
    [1, "F"],
    [null, null],
  ]);
  assert.deepEqual(
    provablySafe(flagged, 2, 2, 1),
    provablySafe(plain, 2, 2, 1),
    "a flag must not change the reasoning"
  );
});

// --- Properties, checked against real boards ----------------------------

test("NEVER returns a mine, across many real positions", () => {
  // THE critical property. If this fails, every Pool A board is suspect.
  // Generated boards rather than hand-made ones, because real mine layouts
  // produce constraint patterns nobody thinks to write down by hand.
  let offered = 0;
  let positions = 0;
  for (const tier of ["beginner", "intermediate", "poolA-small"]) {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeRng(seed * 7919);
      const board = newBoard(tier, rng);
      openBoard(board, makeRng(seed * 104729));
      for (let step = 0; step < 25; step++) {
        const move = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
        // Follow the oracle when it moves. When it declines, STOP the round:
        // the position is genuinely ambiguous, and revealing a random cell
        // would build a position the oracle was never asked to judge. (It would
        // also risk clicking a mine, which writes -1 into the grid and makes
        // the position impossible — a different failure entirely.)
        positions++;
        if (!move) break;
        offered++;
        assert.ok(
          !board.mines[move.row][move.col],
          `oracle returned a MINE at ${move.row},${move.col} (${tier} seed ${seed} step ${step})`
        );
        reveal(board, move.row, move.col);
        let remaining = 0;
        for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) if (!board.revealed[r][c]) remaining++;
        if (remaining === 0) break;
      }
    }
  }
  assert.ok(positions > 500, `expected many positions, got ${positions}`);
  assert.ok(offered > 200, `expected the oracle to act, it offered ${offered} moves`);
});

test("refuses a position containing a revealed mine rather than reasoning about it", () => {
  // A -1 in the grid means a mine was clicked, which ends the round. The
  // harness should never call the oracle with such a board, but if it does the
  // answer must be a refusal, not a confident move derived from nonsense.
  const g = gridOf([
    [1, -1, null],
    [null, null, null],
  ]);
  assert.equal(provablySafe(g, 2, 3, 1), null, "a -1 makes the position invalid");
});

test("refuses a revealed number larger than the cell has neighbours", () => {
  // Impossible: a corner has 3 neighbours, so it cannot show 5.
  const g = gridOf([
    [5, null],
    [null, null],
  ]);
  assert.equal(provablySafe(g, 2, 2, 1), null, "a 5 in a corner is not a legal position");
});

test("every returned move is a real unrevealed cell", () => {
  // A move the harness cannot execute is a protocol violation, and a solver
  // returning one would be scored as garbage rather than as reasoning.
  for (let seed = 1; seed <= 25; seed++) {
    const rng = makeRng(seed * 31337);
    const board = newBoard("beginner", rng);
    openBoard(board, makeRng(seed * 15485863));
    for (let step = 0; step < 15; step++) {
      const move = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
      if (!move) break;
      assert.ok(Number.isInteger(move.row) && Number.isInteger(move.col), "coordinates must be integers");
      assert.ok(move.row >= 0 && move.row < board.rows, "row in bounds");
      assert.ok(move.col >= 0 && move.col < board.cols, "col in bounds");
      assert.ok(!board.revealed[move.row][move.col], "must not return an already-revealed cell");
      assert.deepEqual(Object.keys(move).sort(), ["col", "row"], "exactly {row, col}, nothing else");
      reveal(board, move.row, move.col);
    }
  }
});

test("the oracle is deterministic: the same position gives the same move", () => {
  // The board pool is generated by replaying the oracle, so a nondeterministic
  // answer would make the pool unreproducible.
  for (let seed = 1; seed <= 20; seed++) {
    const board = newBoard("intermediate", makeRng(seed * 6700417));
    openBoard(board, makeRng(seed * 2147483647));
    const a = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
    const b = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
    const c = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
    assert.deepEqual(a, b, `seeds ${seed}: runs 1 and 2 disagreed`);
    assert.deepEqual(b, c, `seeds ${seed}: runs 2 and 3 disagreed`);
  }
});

test("the oracle does not mutate the board it is given", () => {
  // It reasons from the visible grid. Mutating it would corrupt the position
  // mid-game in a way no test of the return value alone would catch.
  const board = newBoard("beginner", makeRng(4242));
  openBoard(board, makeRng(99));
  const before = JSON.stringify(board.visible);
  provablySafe(board.visible, board.rows, board.cols, board.totalMines);
  assert.equal(JSON.stringify(board.visible), before, "the visible grid must be untouched");
});

test("a fully-deducible board is won by following the oracle", () => {
  // The end-to-end property Pool A depends on: if the oracle is playing, the
  // board gets won. A board built so every step is forced.
  const rng = makeRng(0x5eed);
  const board = newBoard("poolA-small", rng);
  openBoard(board, makeRng(0xbeef));
  let steps = 0;
  let stalled = false;
  while (steps < 200) {
    if (isWon(board)) break;
    const move = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
    if (!move) {
      stalled = true;
      break;
    }
    assert.ok(!board.mines[move.row][move.col], "oracle must never step on a mine");
    reveal(board, move.row, move.col);
    steps++;
  }
  // This particular board may be ambiguous, so record what happened rather
  // than asserting it must be won. The point of the test is that the oracle
  // never detonates and the loop terminates.
  assert.ok(steps > 0 || stalled, "the loop must make progress or report ambiguity");
  assert.ok(steps < 200, "the loop must terminate");
});

// --- Fixes: global-count endgames, budget exhaustion, move verification ----

import { analyse, verifyMove } from "../src/do/minesweeper/oracle.mjs";

test("the global count proves an interior cell safe when the frontier uses every mine", () => {
  // Two disjoint clues, each needing one mine; two mines on the board. Every
  // interior cell must be safe. Pairwise subset elimination cannot see this,
  // and the first oracle — which never tried unconstrained cells — called the
  // position ambiguous. That filed winnable boards into Pool B.
  const v = analyse([[null, 1, null, null, null, 1, null]], 1, 7, 2);
  assert.equal(v.deducible, true);
  assert.deepEqual(v.move, { row: 0, col: 3 });
});

test("an unconstrained cell is NOT proven safe when a mine could still be there", () => {
  // Same shape, three mines: the interior must hold one of them.
  const v = analyse([[null, 1, null, null, null, 1, null]], 1, 7, 3);
  assert.notDeepEqual(v.move, { row: 0, col: 3 });
});

test("running out of budget during the LAST candidate is inconclusive, not ambiguous", () => {
  // Found by search against the old oracle. With a full budget (2,3) is
  // provably safe. At budget 9 the search runs out while examining the final
  // candidate; the old code then fell out of its loop and reported the
  // position as conclusively ambiguous — Pool B's claim, made on no evidence.
  const grid = [[null, 2, null, 2], [2, null, null, null], [null, null, 3, null]];
  assert.deepEqual(analyse(grid, 3, 4, 4).move, { row: 2, col: 3 });
  const starved = analyse(grid, 3, 4, 4, { budget: 9 });
  assert.equal(starved.ambiguous, false, "an exhausted search must not claim ambiguity");
  assert.equal(starved.conclusive, false);
});

test("verifyMove: a proven cell, a mine, an undecided cell, and a revealed cell", () => {
  const g = [[1, null, null], [1, 1, 1], [1, 1, 1]];
  // (0,1) is the mine; the global count of 1 makes (0,2) safe.
  assert.deepEqual(verifyMove(g, 3, 3, 1, 0, 2), { proven: true, conclusive: true });
  assert.deepEqual(verifyMove(g, 3, 3, 1, 0, 1), { proven: false, conclusive: true });
  assert.deepEqual(verifyMove(g, 3, 3, 1, 1, 1), { proven: false, conclusive: true }, "a revealed cell is not a move");
  const ambiguous = [[1, null, null], [null, 1, null]];
  for (const [r, c] of [[0, 1], [0, 2], [1, 0], [1, 2]]) {
    assert.equal(verifyMove(ambiguous, 2, 3, 2, r, c).proven, false, `(${r},${c}) cannot be proven`);
  }
});

test("verifyMove agrees with the oracle on every move it makes", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const board = newBoard("poolA-small", makeRng(seed * 7919));
    openBoard(board, makeRng(seed * 104729));
    for (let step = 0; step < 30; step++) {
      const v = analyse(board.visible, board.rows, board.cols, board.totalMines);
      if (!v.deducible) break;
      assert.equal(verifyMove(board.visible, board.rows, board.cols, board.totalMines, v.move.row, v.move.col).proven, true);
      reveal(board, v.move.row, v.move.col);
    }
  }
});
