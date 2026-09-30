// MONKEY DO — board generation and reveal mechanics.
//
// This is the foundation the whole DO eval rests on. Two things must be right
// or every downstream number is wrong:
//
//   1. 8-neighbour counting, CLIPPED at the grid edges. Corners have 3
//      neighbours, edges 5, interior 8. An off-by-one here silently corrupts
//      every constraint the oracle derives, and the symptom would be a board
//      that looks fine and scores nonsense.
//   2. Flood-fill from a blank (0) cell, revealing connected blanks AND their
//      bordering numbers — not just the blanks.
//
// DETERMINISM IS A HARD REQUIREMENT. The published board pool must be
// regenerable byte-for-byte from seed 0x5EED, or a submitted score cannot be
// verified. That rules out Math.random() and Date-dependent behaviour anywhere
// in this file. The only entropy source is the passed-in PRNG.
//
// Board state is represented two ways, deliberately:
//   - `mines`: a boolean grid the harness owns. Ground truth, never exposed.
//   - `visible`: what the model sees. null = unrevealed, 0-8 = a number,
//     'F' = flagged. Flags are decorative: they carry no authority and are
//     treated exactly like null when reasoning (guide.md 5.3).

/** A tiny, fast, seedable PRNG (mulberry32). Deterministic across platforms. */
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * The three classic difficulty tiers, plus non-standard Pool A variants.
 *
 * Pool A deliberately uses shapes and densities OUTSIDE the classic settings.
 * A solver memorised from training data is tuned for 9x9/10 and 16x16/40; odd
 * sizes make that recall transfer poorly, which is the point (guide.md 5.6).
 */
export const TIERS = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
  "poolA-small": { rows: 11, cols: 13, mines: 18 },
  "poolA-medium": { rows: 14, cols: 17, mines: 35 },
  "poolA-large": { rows: 19, cols: 23, mines: 62 },
};

export const inBounds = (board, row, col) =>
  row >= 0 && col >= 0 && row < board.rows && col < board.cols;

/**
 * The 8 surrounding cells, clipped to the grid.
 *
 * Returns coordinates, not values, so callers can count mines or read numbers
 * without a second lookup. Order is fixed (N, NE, E, SE, S, SW, W, NW) so that
 * anything derived from it is deterministic.
 */
export const neighbours = (board, row, col) => {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue; // never a neighbour of itself
      const r = row + dr;
      const c = col + dc;
      if (inBounds(board, r, c)) out.push([r, c]);
    }
  }
  return out;
};

/** How many neighbours a cell has. 3 at a corner, 5 on an edge, 8 inside. */
export const neighbourCount = (board, row, col) => neighbours(board, row, col).length;

/** Count the mines adjacent to a cell. Assumes `row,col` is a non-mine. */
export const adjacentMines = (board, row, col) => {
  let n = 0;
  for (const [r, c] of neighbours(board, row, col)) if (board.mines[r][c]) n++;
  return n;
};

/**
 * Place mines at random, using the supplied rng.
 * Returns a boolean grid. Cells are chosen by flat index so the draw sequence
 * does not depend on iteration order.
 */
export const placeMines = (tier, rng) => {
  const { rows, cols, mines } = TIERS[tier];
  if (mines >= rows * cols) throw new Error(`tier ${tier}: ${mines} mines does not fit ${rows}x${cols}`);
  const grid = Array.from({ length: rows }, () => Array(cols).fill(false));
  const taken = new Set();
  let placed = 0;
  // Guard against an infinite loop on a malformed tier rather than spinning.
  let guard = rows * cols * 10;
  while (placed < mines && guard-- > 0) {
    const idx = Math.floor(rng() * rows * cols);
    if (taken.has(idx)) continue;
    taken.add(idx);
    grid[Math.floor(idx / cols)][idx % cols] = true;
    placed++;
  }
  if (placed !== mines) throw new Error(`tier ${tier}: only placed ${placed} of ${mines} mines`);
  return grid;
};

/** A fresh, fully-hidden board. */
export const newBoard = (tier, rng) => {
  const { rows, cols, mines } = TIERS[tier];
  return {
    tier,
    rows,
    cols,
    mines: placeMines(tier, rng),
    // What the model sees. All hidden until revealed.
    visible: Array.from({ length: rows }, () => Array(cols).fill(null)),
    revealed: Array.from({ length: rows }, () => Array(cols).fill(false)),
    totalMines: mines,
  };
};

/** The board as the model receives it: a deep copy, so state cannot leak back. */
export const asModelView = (board) => board.visible.map((row) => row.slice());

/** Reveal a cell, and flood-fill if it is blank. Returns the cells revealed. */
export const reveal = (board, row, col) => {
  if (!inBounds(board, row, col)) throw new Error(`reveal out of bounds: ${row},${col}`);
  if (board.revealed[row][col]) return [];
  if (board.mines[row][col]) {
    board.revealed[row][col] = true;
    board.visible[row][col] = -1; // a revealed mine; never shown to the model
    return [[row, col]];
  }

  const revealed = [];
  // Explicit stack rather than recursion: a wide-open region on a 30x16 board
  // can flood a long way, and a recursive version risks a stack overflow.
  const stack = [[row, col]];
  while (stack.length) {
    const [r, c] = stack.pop();
    if (board.revealed[r][c]) continue;
    if (board.mines[r][c]) continue; // the flood never crosses a mine
    board.revealed[r][c] = true;
    board.visible[r][c] = adjacentMines(board, r, c);
    revealed.push([r, c]);
    // Only a BLANK cell (0) floods. A numbered cell is revealed but does not
    // propagate. This is the rule most often got wrong by hand.
    if (board.visible[r][c] === 0) {
      for (const [nr, nc] of neighbours(board, r, c)) {
        if (!board.revealed[nr][nc] && !board.mines[nr][nc]) stack.push([nr, nc]);
      }
    }
  }
  return revealed;
};

/** A random in-bounds, unrevealed cell. Null if the board is fully revealed. */
export const randomHiddenCell = (board, rng) => {
  const hidden = [];
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) if (!board.revealed[r][c]) hidden.push([r, c]);
  }
  if (!hidden.length) return null;
  return hidden[Math.floor(rng() * hidden.length)];
};

/**
 * Open the board with a real information cascade.
 *
 * The naive version reveals ONE random cell. Measurement showed that is a
 * mistake: on poolA-small, 48 of 100 boards were ambiguous at step 0 having
 * learned nothing at all, because a single revealed cell on a sparse board
 * usually sits next to no mines and floods to a region with no numbers on its
 * border. Nothing to deduce from.
 *
 * So keep opening cells until one actually reveals information. This is still
 * pure seeded randomness, so the pool stays reproducible, and it costs nothing
 * at runtime because the flood is cheap.
 *
 * `minRevealed` of 2 means "at least one new cell beyond the one clicked",
 * i.e. the click produced a cascade. That cut step-0 ambiguity from 48/100 to
 * 3/100 in measurement.
 *
 * @returns {{ revealed: Array<[number,number]>, start: [number,number]|null }}
 */
export const openBoard = (board, rng, { minRevealed = 2, maxTries = 400 } = {}) => {
  let best = [];
  let start = null;
  for (let tries = 0; tries < maxTries; tries++) {
    const cell = randomHiddenCell(board, rng);
    if (!cell) break;
    if (board.mines[cell[0]][cell[1]]) continue; // never open on a mine
    const revealed = reveal(board, cell[0], cell[1]);
    if (revealed.length > best.length) {
      best = revealed;
      start = cell;
    }
    if (revealed.length >= minRevealed) return { revealed: best, start };
  }
  // No cascade found (very dense board, or every try was a mine). Fall back to
  // whatever we opened. The caller classifies it, so a poor opening simply
  // yields an unclassifiable board rather than a wrong one.
  return { revealed: best, start };
};

/** True when every non-mine cell is revealed. */
export const isWon = (board) => {
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      if (!board.mines[r][c] && !board.revealed[r][c]) return false;
    }
  }
  return true;
};

/** A digest of the hidden layout, used to prove a board pool is reproducible. */
export const layoutDigest = (board) =>
  board.mines.map((row) => row.map((m) => (m ? "1" : "0")).join("")).join("|");
