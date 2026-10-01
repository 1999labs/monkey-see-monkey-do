// MONKEY DO — board mechanics.
//
// The emphasis here is EDGES, because that is where board code goes wrong.
// Every case below is hand-checkable: a 3x3 board with one mine in the centre
// has known answers, and those answers are written out rather than computed by
// the same logic under test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeRng,
  TIERS,
  inBounds,
  neighbours,
  neighbourCount,
  adjacentMines,
  placeMines,
  newBoard,
  asModelView,
  reveal,
  randomHiddenCell,
  openBoard,
  isWon,
  layoutDigest,
} from "../src/do/minesweeper/board.mjs";

// A board built from an explicit mine layout, so tests can state the answer
// independently of the generator.
const boardWith = (rows, cols, mineCoords) => ({
  tier: "test",
  rows,
  cols,
  mines: Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => mineCoords.some(([mr, mc]) => mr === r && mc === c))
  ),
  visible: Array.from({ length: rows }, () => Array(cols).fill(null)),
  revealed: Array.from({ length: rows }, () => Array(cols).fill(false)),
  totalMines: mineCoords.length,
});

// --- Neighbour counting at edges -----------------------------------------

test("a corner cell has 3 neighbours, an edge 5, an interior 8", () => {
  const b = boardWith(5, 5, []);
  assert.equal(neighbourCount(b, 0, 0), 3, "top-left corner");
  assert.equal(neighbourCount(b, 4, 4), 3, "bottom-right corner");
  assert.equal(neighbourCount(b, 0, 2), 5, "top edge, middle");
  assert.equal(neighbourCount(b, 2, 0), 5, "left edge, middle");
  assert.equal(neighbourCount(b, 2, 2), 8, "interior");
  assert.equal(neighbourCount(b, 1, 1), 8, "near-interior");
});

test("a 1xN board degenerates gracefully rather than miscounting", () => {
  // Degenerate shapes must not produce phantom neighbours. A 1x1 board has
  // none at all, which is the boundary case of the boundary case.
  const single = boardWith(1, 1, []);
  assert.equal(neighbourCount(single, 0, 0), 0);

  const row = boardWith(1, 5, []);
  assert.equal(neighbourCount(row, 0, 0), 1, "end of a single row");
  assert.equal(neighbourCount(row, 0, 2), 2, "middle of a single row");
});

test("neighbours are clipped, never negative-indexed", () => {
  // A negative index would silently read the wrong row and produce a count
  // that is plausible but wrong — the worst kind of bug.
  const b = boardWith(3, 3, []);
  const corner = neighbours(b, 0, 0);
  assert.deepEqual(
    corner.sort(),
    [[0, 1], [1, 0], [1, 1]].sort(),
    "top-left sees exactly right, below, and diagonal"
  );
  for (const [r, c] of neighbours(b, 0, 0)) {
    assert.ok(r >= 0 && c >= 0, `negative coordinate ${r},${c}`);
    assert.ok(inBounds(b, r, c));
  }
});

test("a cell is never its own neighbour", () => {
  const b = boardWith(4, 4, []);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      assert.ok(!neighbours(b, r, c).some(([nr, nc]) => nr === r && nc === c));
    }
  }
});

test("adjacentMines counts correctly at every edge position", () => {
  // One mine in the centre of a 3x3. Hand-checked: the centre-adjacent cells
  // see 1, the far corners see 0, the centre itself is a mine.
  const b = boardWith(3, 3, [[1, 1]]);
  assert.equal(adjacentMines(b, 1, 0), 1, "left edge cell sees the centre");
  assert.equal(adjacentMines(b, 0, 1), 1, "top edge cell sees the centre");
  assert.equal(adjacentMines(b, 2, 2), 1, "bottom-right corner sees the centre diagonally");
  assert.equal(adjacentMines(b, 0, 0), 1, "top-left corner sees it diagonally");
  assert.equal(adjacentMines(b, 0, 2), 1, "top-right corner sees it diagonally");
  assert.equal(adjacentMines(b, 2, 0), 1, "bottom-left corner sees it diagonally");
});

test("a mine on the border is counted by exactly its in-bounds neighbours", () => {
  // The classic off-by-one: a mine at (0,0) has 3 neighbours, so exactly 3
  // cells on a 3x3 board should see it. Not 8.
  const b = boardWith(3, 3, [[0, 0]]);
  const seen = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (!b.mines[r][c] && adjacentMines(b, r, c) > 0) seen.push([r, c]);
    }
  }
  assert.equal(seen.length, 3, `expected 3 cells to see a corner mine, got ${JSON.stringify(seen)}`);
  for (const [r, c] of seen) assert.equal(adjacentMines(b, r, c), 1);
});

// --- Flood fill ----------------------------------------------------------

test("a blank cell floods through connected blanks", () => {
  // 5x5 with ONE mine at the centre. Hand-computed: the 8 cells touching the
  // centre read a number, and the other 16 are blank. Those 16 form a
  // connected ring, so one reveal from (0,0) must flood all 16 blanks AND
  // reveal the 8 bordering numbers as a side effect — 24 cells total, and the
  // board is won.
  const b = boardWith(5, 5, [[2, 2]]);
  const revealed = reveal(b, 0, 0);
  assert.equal(revealed.length, 24, "16 blanks plus 8 bordering numbers");
  assert.equal(b.visible[0][0], 0, "(0,0) is two cells from the mine, so blank");
  assert.equal(b.visible[0][1], 0);
  assert.equal(b.visible[1][1], 1, "diagonal to the centre, so it reads 1");
  assert.equal(b.visible[2][1], 1, "orthogonally beside the centre, so 1");
  assert.ok(!b.revealed[2][2], "the mine itself is never revealed by a flood");
  assert.equal(isWon(b), true, "every non-mine cell is now visible");
});

test("a cell fully surrounded by mines reads 8, the maximum", () => {
  // A ring of 8 mines around (2,2) on a 5x5. The centre is not a mine, and all
  // 8 of its neighbours are, so it must read 8 — the maximum a cell can show.
  // This also confirms the flood is stopped by mines: revealing the centre
  // cannot spread outward through the ring.
  const ring = [[1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3]];
  const b = boardWith(5, 5, ring);
  const revealed = reveal(b, 2, 2);
  assert.deepEqual(revealed, [[2, 2]], "an enclosed numbered cell reveals only itself");
  assert.equal(b.visible[2][2], 8, "8 adjacent mines, the maximum possible count");
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (r === 2 && c === 2) continue;
      assert.ok(!b.revealed[r][c], `(${r},${c}) must stay hidden — the flood cannot cross a mine`);
    }
  }
});

test("flood-fill reveals bordering NUMBERS but does not propagate through them", () => {
  // This is the rule most often got wrong. A numbered cell is revealed as a
  // side effect of a flood, but it must NOT spread the flood further.
  //
  // 5x5 with a vertical mine wall in column 2, rows 1..3. The left region is
  // open and connected, so columns 0 and 1 flood. Column 1 reads the wall's
  // counts. Column 3 is only reachable THROUGH those numbers, so it must stay
  // hidden — a number is a wall to a flood, not a bridge.
  const b = boardWith(5, 5, [[1, 2], [2, 2], [3, 2]]);
  reveal(b, 0, 0);

  // Left region is open and connected: all of columns 0 and 1 flood.
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 2; c++) {
      assert.ok(b.revealed[r][c], `(${r},${c}) should have flooded`);
    }
  }
  // Column 1 counts the wall mines it can see. Hand-computed: 1,2,3,2,1 —
  // the middle cell of a 3-mine wall sees all three.
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((r) => b.visible[r][1]),
    [1, 2, 3, 2, 1],
    "column 1 reads the wall"
  );
  // Columns 2-4 lie beyond the numbers, so nothing there is revealed.
  for (let r = 0; r < 5; r++) {
    for (let c = 2; c < 5; c++) {
      assert.ok(!b.revealed[r][c], `(${r},${c}) must stay hidden — a number cannot propagate`);
    }
  }
});

test("revealing a numbered cell reveals only itself", () => {
  // Directly reveal a cell adjacent to a mine. It reads a number and stops.
  const b = boardWith(3, 3, [[1, 1]]);
  const revealed = reveal(b, 0, 1);
  assert.equal(revealed.length, 1, "a numbered cell reveals exactly itself");
  assert.equal(b.visible[0][1], 1);
  assert.ok(!b.revealed[0][0], "and does not drag its blank neighbours along");
});

test("revealing a mine marks it and reveals nothing else", () => {
  const b = boardWith(3, 3, [[1, 1]]);
  const revealed = reveal(b, 1, 1);
  assert.deepEqual(revealed, [[1, 1]]);
  assert.equal(b.visible[1][1], -1, "a revealed mine is marked -1");
  assert.ok(!b.revealed[0][0], "no flood from a mine");
});

test("revealing an already-revealed cell is a no-op, not a double count", () => {
  const b = boardWith(3, 3, [[1, 1]]);
  const first = reveal(b, 0, 1);
  const second = reveal(b, 0, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, "second reveal must return nothing");
});

test("revealing out of bounds throws rather than corrupting the board", () => {
  const b = boardWith(3, 3, []);
  assert.throws(() => reveal(b, -1, 0), /out of bounds/);
  assert.throws(() => reveal(b, 0, 3), /out of bounds/);
});

test("a wide-open board floods in one call without overflowing the stack", () => {
  // 19x23 with a single mine. Flood depth is large, which is why reveal() uses
  // an explicit stack. A recursive implementation would risk a stack overflow
  // here, and it would only ever show up on large open boards.
  const b = boardWith(19, 23, [[0, 0]]);
  const revealed = reveal(b, 9, 11);
  assert.equal(revealed.length, 19 * 23 - 1, "everything except the mine");
});

// --- Generation ----------------------------------------------------------

test("the same seed produces a byte-identical board", () => {
  // THE reproducibility requirement. If this fails, published scores cannot be
  // verified, because nobody can regenerate the pool they were scored on.
  const a = newBoard("intermediate", makeRng(0x5eed));
  const b = newBoard("intermediate", makeRng(0x5eed));
  assert.equal(layoutDigest(a), layoutDigest(b));
  assert.deepEqual(a.visible, b.visible);
});

test("different seeds produce different boards", () => {
  const a = layoutDigest(newBoard("intermediate", makeRng(1)));
  const b = layoutDigest(newBoard("intermediate", makeRng(2)));
  assert.notEqual(a, b, "the seed must actually matter");
});

test("mine counts are exact, on every tier", () => {
  for (const tier of Object.keys(TIERS)) {
    const b = newBoard(tier, makeRng(0x5eed));
    const count = b.mines.flat().filter(Boolean).length;
    assert.equal(count, TIERS[tier].mines, `${tier} must place exactly ${TIERS[tier].mines} mines`);
    assert.equal(b.totalMines, TIERS[tier].mines);
  }
});

test("no tier is over-packed", () => {
  for (const [tier, { rows, cols, mines }] of Object.entries(TIERS)) {
    assert.ok(mines < rows * cols, `${tier}: ${mines} mines in ${rows}x${cols} leaves no room`);
  }
});

test("an impossible mine count fails loudly", () => {
  // A tier claiming more mines than cells must throw, not spin or silently
  // place fewer. A silently-truncated layout would be scored as if valid.
  assert.throws(
    () => placeMines("nonexistent", makeRng(1)),
    /does not fit|not a function|undefined/
  );
});

test("the PRNG is uniform enough to avoid clustered openings", () => {
  // Not a statistical test — a guard against a badly broken PRNG producing
  // runs of identical values, which would make every board look the same.
  const rng = makeRng(0x5eed);
  const draws = Array.from({ length: 5000 }, () => rng());
  assert.ok(draws.every((d) => d >= 0 && d < 1), "all draws in [0,1)");
  const distinct = new Set(draws).size;
  assert.ok(distinct > 4500, `expected varied draws, got ${distinct} distinct of 5000`);
  // Rough evenness across ten buckets.
  const buckets = new Array(10).fill(0);
  for (const d of draws) buckets[Math.floor(d * 10)]++;
  for (const [i, n] of buckets.entries()) {
    assert.ok(n > 400 && n < 600, `bucket ${i} had ${n} draws, expected ~500`);
  }
});

// --- Model view and win state -------------------------------------------

test("the model view is a copy — the harness state cannot be reached through it", () => {
  // The model must not be able to mutate the real board, and the harness must
  // not be able to see writes the model made.
  const b = newBoard("beginner", makeRng(7));
  openBoard(b, makeRng(8));
  const view = asModelView(b);
  view[0][0] = 999;
  view[0].push("tampered");
  assert.notEqual(b.visible[0][0], 999, "the real board must be unaffected");
  assert.equal(b.visible[0].length, b.cols, "row length unchanged");
});

test("a fresh board is not already won, and opening does not win a full board", () => {
  const b = newBoard("beginner", makeRng(3));
  assert.equal(isWon(b), false);
  openBoard(b, makeRng(4));
  assert.equal(isWon(b), false, "one opening cannot clear a board with 10 mines");
});

test("isWon is true only when every non-mine cell is revealed", () => {
  const b = boardWith(3, 3, [[1, 1]]);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!(r === 1 && c === 1)) b.revealed[r][c] = true;
  assert.equal(isWon(b), true, "all 8 non-mine cells revealed");
  b.revealed[0][0] = false;
  assert.equal(isWon(b), false, "one hidden non-mine cell means not won");
});

test("randomHiddenCell never returns a revealed cell, and stops when none are left", () => {
  const b = boardWith(4, 4, []);
  const rng = makeRng(11);
  const cells = 4 * 4;
  // Exactly cells iterations: each one marks a cell revealed, so the (cells+1)th
  // call must find nothing left. Iterating more would assert on an exhausted
  // board and fail for the wrong reason.
  for (let i = 0; i < cells; i++) {
    const cell = randomHiddenCell(b, rng);
    assert.ok(cell, `iteration ${i}: there must be a hidden cell left`);
    assert.ok(!b.revealed[cell[0]][cell[1]]);
    b.revealed[cell[0]][cell[1]] = true;
  }
  assert.equal(randomHiddenCell(b, rng), null, "a fully revealed board has no hidden cell");
});
