// MONKEY DO — the oracle. Ground truth for "logically certain".
//
// THE MODEL'S CONTRACT is to return a cell that is *guaranteed* safe, or null
// when no cell can be proven safe. This module decides that question. It is the
// only thing standing between a board pool and meaningless numbers: Pool A is
// built by rejection sampling against this solver, so a wrong oracle produces
// a pool that is wrong in a way no output ever reveals.
//
// Two things make that hard, and both are handled here:
//
//   1. PROPAGATION IS INCOMPLETE. The five deduction rules settle most
//      positions, but they are not sound on their own. There are boards where
//      a cell is provably safe only after exhausting the search space. Treating
//      "propagation found nothing" as "nothing is provable" would be wrong.
//
//   2. SO THE SEARCH IS EXACT. `provablySafe` answers one question rigorously:
//      is there ANY consistent mine assignment in which this cell holds a
//      mine? If not, it is safe. That is sound in both directions, which is
//      what lets Pool A mean "solvable without guessing".
//
// The search is budgeted. If the budget runs out we answer null rather than
// guess: returning null is a surrender, which is scored as caution. Returning
// an unproven cell would be a detonation, which is a reasoning failure. When in
// doubt, the oracle must decline.
//
// Determinism: cells are always visited in ascending index order and no
// iteration depends on Set insertion order, so the oracle returns the same move
// for the same board on every run. The board pool depends on this.

import { inBounds } from "./board.mjs";

/** Default node budget for the exact search. */
export const DEFAULT_BUDGET = 20000;

/**
 * A /developer-typed phase of one analyse() call's reasoning. Bands derive from
 * the WORST phase seen across a board's replay:
 *
 *   rule2  Rule 2 alone (saturated set). Band 1 (easy).
 *   rule5  global mine count forced a cell. Still band 2 (chained).
 *   rule3  subset elimination. Band 2 (chained).
 *   search exhaustive consistency check. Band 3 (wall).
 *
 * Order matters in worstPhase: rule2 < rule5 = rule3 < search. Rule 5 is not
 * strictly weaker than Rule 3 in general, but neither dominates Band 1, so
 * either being present moves a board from Band 1 to Band 2.
 */
export const PHASE_RANK = { rule2: 0, rule5: 1, rule3: 1, search: 2 };

const worstPhase = (rules) => {
  if (!rules || rules.length === 0) return "rule2"; // propagation fixed point with no decision — shouldn't happen because we only call this when a cell was decided
  let worstRule = rules[0].rule;
  for (let i = 1; i < rules.length; i++) if (PHASE_RANK[rules[i].rule] > PHASE_RANK[worstRule]) worstRule = rules[i].rule;
  return worstRule;
};

/** A cell as seen by the reasoning code: a flat index, for Set speed. */
const idx = (r, c, cols) => r * cols + c;
const rowOf = (i, cols) => Math.floor(i / cols);
const colOf = (i, cols) => i % cols;

/** Is this cell unknown to the solver? null and 'F' both count. */
const isUnknown = (v) => v === null || v === "F";

/**
 * Is this grid a position the solver can legitimately be asked about?
 *
 * A revealed MINE (-1) means the player clicked a mine and the game ended. The
 * harness never passes such a position on, because the round is already scored.
 * Rejecting it here means a harness bug shows up as a clear refusal rather than
 * as confident nonsense derived from an impossible position: -1 is a number, so
 * without this check it would be read as a revealed cell showing "-1 adjacent
 * mines", which is not a thing, and every constraint built from it would be
 * garbage that happens to be self-consistent.
 */
const isSolvablePosition = (grid, rows, cols) => {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      if (isUnknown(v)) continue;
      // -1 is a revealed mine. The round ended the moment it was clicked, so
      // the harness must never ask about this position. It is REJECTED, not
      // skipped: treating it as an ordinary number would build constraints from
      // a cell claiming "-1 adjacent mines", which is not a thing.
      if (v === -1) return false;
      if (typeof v !== "number" || v < 0 || v > 8) return false;
      // A revealed number can never exceed the number of its neighbours.
      if (v > neighbourCountOf(r, c, rows, cols)) return false;
    }
  }
  return true;
};

const neighbourCountOf = (r, c, rows, cols) => {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds({ rows, cols }, nr, nc)) n++;
    }
  }
  return n;
};

/** The 8 neighbours, as flat indices, clipped at the edges. */
const neighbourIdx = (r, c, rows, cols) => {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds({ rows, cols }, nr, nc)) out.push(idx(nr, nc, cols));
    }
  }
  return out;
};

/**
 * Every constraint implied by the visible board.
 *
 * One per revealed non-zero number, plus the global mine-count constraint. A
 * number of 0 yields nothing: all of its neighbours are already provably safe
 * by Rule 2, so an empty constraint would only cost time.
 */
const buildConstraints = (grid, rows, cols, totalMines, safe, mines) => {
  const cons = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      if (typeof v !== "number" || v <= 0) continue;
      const cells = [];
      for (const n of neighbourIdx(r, c, rows, cols)) {
        if (isUnknown(grid[rowOf(n, cols)][colOf(n, cols)])) cells.push(n);
      }
      if (cells.length) cons.push({ need: v, cells });
    }
  }
  // Rule 5. Every mine is in an unrevealed cell, because a revealed mine ends
  // the game and is never passed to the solver.
  const all = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (isUnknown(grid[r][c])) all.push(idx(r, c, cols));
  }
  // Marked `global` so the search knows not to branch on it. See isConsistent.
  if (all.length) cons.push({ need: totalMines, cells: all, global: true });
  return cons;
};


/**
 * Apply the deductive rules to a fixpoint. Mutates `safe` and `mines`.
 * Returns false on a contradiction (the position is impossible).
 *
 * Rules implemented:
 *   Rule 2  saturated set     need === 0, or need === set size
 *   Rule 3  subset removal   A's set inside B's set transfers the difference
 *   Rule 5  global count     all remaining mines are accounted for
 *
 * `instrument` (optional) records which rule forced each newly-decided cell.
 * Used by Phase 1 band classification; absent in normal solves, where the
 * cost would be pointless. Cells already in safe/mines when propagate starts
 * are NOT recorded — the caller cares about decisions made THIS call, not the
 * history. Each entry is { cell, rule } with rule in {"rule2","rule3","rule5"}.
 */
const propagate = (grid, rows, cols, totalMines, safe, mines, instrument = null) => {
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    const cons = buildConstraints(grid, rows, cols, totalMines, safe, mines);
    const refined = cons.map((c) => refine(c, safe, mines));

    for (let i = 0; i < refined.length; i++) {
      const { need, set, list, global } = refined[i];
      if (need < 0 || need > list.length) return false; // contradiction
      if (list.length === 0) continue;
      // Rule 2. This is the workhorse: it resolves most of every position.
      if (need === 0) {
        for (const cell of list) {
          const fresh = !safe.has(cell);
          safe.add(cell);
          if (fresh && instrument) instrument.push({ cell, rule: global ? "rule5" : "rule2" });
        }
        changed = true;
      } else if (need === list.length) {
        for (const cell of list) {
          const fresh = !mines.has(cell);
          mines.add(cell);
          if (fresh && instrument) instrument.push({ cell, rule: global ? "rule5" : "rule2" });
        }
        changed = true;
      }
    }

    // Rule 3, subset elimination. If A's remaining set lies inside B's, then
    // the cells in B but not A must hold exactly B.need - A.need mines. This is
    // sound because B's mines are a superset-compatible: every mine B still
    // needs is in B's set, and A already accounts for A.need of them inside
    // A's set (A's set being a subset of B's).
    //
    // A.need has already had A's known mines subtracted by refine(), so both
    // sides are counted in the same "still undecided" currency. Comparing a
    // refined need against an unrefined one here would be the classic
    // off-by-a-mine bug this comment is here to prevent.
    for (let i = 0; i < refined.length; i++) {
      for (let j = 0; j < refined.length; j++) {
        if (i === j) continue;
        const A = refined[i];
        const B = refined[j];
        if (A.list.length === 0 || B.list.length === 0) continue;
        if (A.list.length >= B.list.length) continue; // A must be the smaller
        if (!A.list.every((cell) => B.set.has(cell))) continue;
        const rest = B.list.filter((cell) => !A.set.has(cell));
        const restNeed = B.need - A.need;
        if (rest.length === 0) continue;
        if (restNeed < 0 || restNeed > rest.length) return false; // contradiction
        if (restNeed === 0) {
          for (const cell of rest) {
            const fresh = !safe.has(cell);
            safe.add(cell);
            if (fresh && instrument) instrument.push({ cell, rule: "rule3" });
          }
          changed = true;
        } else if (restNeed === rest.length) {
          for (const cell of rest) {
            const fresh = !mines.has(cell);
            mines.add(cell);
            if (fresh && instrument) instrument.push({ cell, rule: "rule3" });
          }
          changed = true;
        }
      }
    }

    // A cell must never be in both sets. If propagation has produced such a
    // cell, the position is contradictory — but reporting it as a contradiction
    // makes provablySafe return null, which is safe. Silently preferring one
    // set over the other is what let a mine be returned as safe.
    for (const cell of safe) {
      if (mines.has(cell)) return false;
    }

    if (!changed) return true; // fixpoint reached
  }
  // 200 passes without a fixpoint would indicate a cycle. Returning true keeps
  // the search's "consistent" answer, which is the conservative direction.
  return true;
};

/**
 * Is this position consistent with the given extra assumptions?
 *
 * `assumeSafe` / `assumeMines` are cells committed to a value by the caller.
 * Answers "does at least one valid mine assignment exist?", which is the
 * question `provablySafe` needs: a cell is provably safe exactly when assuming
 * it holds a mine makes the position impossible.
 *
 * Depth-first with propagation at every node. Cells are branched in ascending
 * index order so the search is deterministic.
 */
const isConsistent = (grid, rows, cols, totalMines, assumeSafe, assumeMines, budget) => {
  // COPY the sets. This is not tidiness: cells added by propagate() are only
  // forced GIVEN the current branch's assumptions. If branch 1 assumed a cell
  // safe and propagation deduced others, those deductions do not survive into
  // branch 2, which assumes the opposite. Sharing the sets across branches
  // would silently poison the search and produce unsound "provably safe"
  // answers — the exact failure this module exists to prevent.
  const safe = new Set(assumeSafe);
  const mines = new Set(assumeMines);
  if (!propagate(grid, rows, cols, totalMines, safe, mines)) return false;

  const cons = buildConstraints(grid, rows, cols, totalMines, safe, mines).map((c) => refine(c, safe, mines));

  // BRANCH ONLY ON CONSTRAINED CELLS. Cells that appear in no numbered
  // constraint are interchangeable as far as the local rules are concerned:
  // the global mine count is the only thing that cares, and it is satisfied by
  // placing the remaining mines anywhere among them. Branching on them instead
  // is what turns this into an exponential search over hundreds of cells — the
  // first version did exactly that and hung on a 16x16 board.
  let target = null;
  let targetNeed = 0;
  let targetSize = 0;
  for (let i = 0; i < cons.length; i++) {
    if (cons[i].global) continue; // handled by the count check below
    const { need, list } = cons[i];
    if (list.length === 0) continue;
    if (need === 0 || need === list.length) continue; // already saturated
    // Branch on the most constrained cell: fewest candidates, closest to
    // decided. This is the standard Minesweeper heuristic and it collapses the
    // search dramatically.
    const score = list.length - Math.min(need, list.length - need);
    if (target === null || score < targetSize - Math.min(targetNeed, targetSize - targetNeed)) {
      target = list[0];
      targetNeed = need;
      targetSize = list.length;
    }
  }

  if (target === null) {
    // No constrained cell is open. Only the global count remains: the mines
    // already placed plus some of the unconstrained cells must total
    // totalMines, and there must be room for them. Anything consistent is a
    // valid completion, so the position is satisfiable.
    const remaining = totalMines - mines.size;
    if (remaining < 0) return false; // already over-placed
    let unconstrained = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (!isUnknown(v)) continue;
        const i = idx(r, c, cols);
        if (safe.has(i) || mines.has(i)) continue;
        unconstrained++;
      }
    }
    return remaining <= unconstrained;
  }

  // Out of budget. Report "consistent", which is the CONSERVATIVE answer: the
  // caller will not call this cell safe, so the oracle declines rather than
  // guessing. The alternative would be to guess, and a wrong guess here
  // silently corrupts the board pool.
  //
  // `exhausted` is recorded so the caller can tell this conservative "true"
  // apart from a real one. Without it, running out of budget on the LAST
  // candidate looked exactly like a finished search, and the position was
  // reported as conclusively ambiguous — the inconclusive-as-ambiguous mistake
  // that would manufacture ambiguity. Once exhausted, every call returns true and that true
  // propagates to the root, so a root answer of `false` is always trustworthy.
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return true;
  }
  budget.remaining--;

  const withSafe = new Set(safe);
  withSafe.add(target);
  if (isConsistent(grid, rows, cols, totalMines, withSafe, mines, budget)) return true;

  const withMine = new Set(mines);
  withMine.add(target);
  return isConsistent(grid, rows, cols, totalMines, safe, withMine, budget);
};

/**
 * The oracle's answer: a cell that is LOGICALLY CERTAIN safe, or null.
 *
 * Two stages:
 *   1. Propagate. If that alone proves a cell safe, return it. This handles
 *      the overwhelming majority of real positions and costs microseconds.
 *   2. Otherwise search. For each open cell, ask whether the position stays
 *      consistent if that cell is assumed to be a mine. If not, it is provably
 *      safe. If every open cell admits a mine-assignment, the position is
 *      genuinely ambiguous and the correct answer is null.
 *
 * Returning null on ambiguity is the whole point. Pool B is built from exactly
 * these positions, and a model that guesses there is taking a risk the eval
 * scores as such.
 *
 * @returns {{row: number, col: number}|null}
 */
export const provablySafe = (grid, rows, cols, totalMines, { budget = DEFAULT_BUDGET } = {}) =>
  analyse(grid, rows, cols, totalMines, { budget }).move;

/**
 * The oracle's full analysis of a position.
 *
 * The pool generator needs more than a move. It needs to know which of three
 * things happened, and they are NOT interchangeable:
 *
 *   deducible   a certain-safe move was proven. Pool A keeps only these.
 *   ambiguous   propagation and an EXHAUSTED search both failed to find one.
 *               Pool B keeps only these, because guessing is genuinely
 *               required. Pool B's claim is that a coin flip is unavoidable,
 *               so it must never rest on a search that merely ran out of budget.
 *   inconclusive the search hit its budget. We do not know whether a safe cell
 *               exists. This is neither pool, and the position is discarded —
 *               silently filing it as "ambiguous" would quietly pad Pool B with
 *               positions that a stronger solver would have solved.
 *
 * That distinction is the reason this function exists separately from
 * provablySafe. Inferring it afterwards by re-running the oracle and guessing
 * would defeat the purpose.
 *
 * @returns {{ move: {row,col}|null, deducible: boolean, ambiguous: boolean, conclusive: boolean, phase?: Phase }}
 *
 * `phase` is recorded when `instrument: true` is passed. It is the WORST rule
 * that fired during this call's propagation, plus `search` if the search
 * produced the move. Bands are computed by `classifyBoard` from these phases
 * across a whole replay. A call that did not need instrumentation returns the
 * same shape with no `phase` field, so existing callers (provablySafe,
 * verifyMove) are unchanged.
 */
export const analyse = (grid, rows, cols, totalMines, { budget = DEFAULT_BUDGET, instrument = false } = {}) => {
  const inconclusive = { move: null, deducible: false, ambiguous: false, conclusive: false };
  // Refuse an impossible position rather than reason about it. See
  // isSolvablePosition: a -1 in the grid means a mine was clicked, which ends
  // the round, so the harness should never have called this.
  if (!isSolvablePosition(grid, rows, cols)) return inconclusive;

  const safe = new Set();
  const mines = new Set();
  // A flat list of rule labels, in the order they fired. Worst-of determines
  // the phase. Empty list means propagation made no decision — the search did,
  // or the position was inconclusive.
  const rules = instrument ? [] : null;
  if (!propagate(grid, rows, cols, totalMines, safe, mines, rules)) return inconclusive;

  // A cell propagation already proved safe is the cheapest correct answer.
  // Ascending index order keeps the oracle deterministic, which the published
  // board pool depends on.
  const proven = [...safe].sort((a, b) => a - b)[0];
  if (proven !== undefined) {
    return {
      move: { row: rowOf(proven, cols), col: colOf(proven, cols) },
      deducible: true,
      ambiguous: false,
      conclusive: true,
      ...(instrument ? { phase: worstPhase(rules) } : {}),
    };
  }

  // Propagation stalled. Try to prove each open cell safe by contradiction.
  //
  // Constrained cells (those next to a revealed number) come first, in
  // ascending index order.
  const open = [];
  const seen = new Set();
  const cons = buildConstraints(grid, rows, cols, totalMines, safe, mines).map((c) => refine(c, safe, mines));
  for (const { list, global } of cons) {
    if (global) continue;
    for (const cell of list) {
      if (!seen.has(cell)) {
        seen.add(cell);
        open.push(cell);
      }
    }
  }
  open.sort((a, b) => a - b);

  // Then ONE unconstrained cell, as a representative of all of them.
  //
  // An earlier version skipped unconstrained cells entirely, on the theory that
  // propagation had already checked the global count. It had not: pairwise
  // subset elimination cannot see that two DISJOINT frontier constraints, each
  // needing one mine, together use up the last two mines on the board — which
  // makes every interior cell safe. That is precisely the endgame deduction
  // Pool B boards are built from, and missing it filed winnable boards as
  // "a guess is required" (measured: 2 of 60 Pool B boards).
  //
  // One representative is enough. Unconstrained cells appear only in the global
  // constraint, so they are interchangeable: any assignment with a mine on one
  // can be permuted to put it on another. If the representative can hold a mine,
  // so can every interior cell; if it cannot, none can.
  const rep = firstUnconstrained(grid, rows, cols, seen, safe, mines);
  if (rep !== null) open.push(rep);

  const state = { remaining: budget, exhausted: false };
  for (const cell of open) {
    // Ask: can this cell hold a mine? If no, it is provably safe. A `false`
    // from isConsistent is always trustworthy (see the budget note there).
    if (!isConsistent(grid, rows, cols, totalMines, safe, new Set([...mines, cell]), state)) {
      return {
        move: { row: rowOf(cell, cols), col: colOf(cell, cols) },
        deducible: true,
        ambiguous: false,
        conclusive: true,
        // The search produced the move. Propagation might have fired earlier
        // rules to a fixpoint without a decision, but the move itself came
        // from the search, which is the worst case for band classification.
        ...(instrument ? { phase: "search" } : {}),
      };
    }
    // A `true` reached by running out of budget proves nothing. Checked after
    // EVERY candidate, including the last — checking only before the next one
    // is what let an exhausted final search pass as a finished one.
    if (state.exhausted) return inconclusive;
  }
  // Every candidate was shown consistent with holding a mine, and the search
  // finished. The position is genuinely ambiguous.
  return { move: null, deducible: false, ambiguous: true, conclusive: true };
};

/**
 * Is one SPECIFIC cell provably safe in this position?
 *
 * The harness uses this to audit every move a model makes. The contract is
 * "return a cell that is LOGICALLY CERTAIN to be safe", and a
 * cell that merely turned out safe does not meet it: a lucky guess must not win
 * a Pool A board, and must not let a model play past the point where Pool B
 * asks it to stop.
 *
 * Judged with exactly the information the model is given — the visible grid and
 * the total mine count — so a move is never called a guess on the strength of
 * something the model could not have known.
 *
 * @returns {{ proven: boolean, conclusive: boolean }}
 *   conclusive === false means the search ran out of budget. Callers must give
 *   the model the benefit of the doubt in that case, never count it as a guess.
 */
export const verifyMove = (grid, rows, cols, totalMines, row, col, { budget = DEFAULT_BUDGET } = {}) => {
  if (!isSolvablePosition(grid, rows, cols)) return { proven: false, conclusive: false };
  if (!inBounds({ rows, cols }, row, col) || !isUnknown(grid[row][col])) return { proven: false, conclusive: true };

  const safe = new Set();
  const mines = new Set();
  if (!propagate(grid, rows, cols, totalMines, safe, mines)) return { proven: false, conclusive: false };

  const cell = idx(row, col, cols);
  if (safe.has(cell)) return { proven: true, conclusive: true };
  if (mines.has(cell)) return { proven: false, conclusive: true };

  const state = { remaining: budget, exhausted: false };
  if (!isConsistent(grid, rows, cols, totalMines, safe, new Set([...mines, cell]), state)) {
    return { proven: true, conclusive: true };
  }
  return { proven: false, conclusive: !state.exhausted };
};

/** The lowest-index unknown cell that no numbered constraint mentions, or null. */
const firstUnconstrained = (grid, rows, cols, constrained, safe, mines) => {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isUnknown(grid[r][c])) continue;
      const i = idx(r, c, cols);
      if (constrained.has(i) || safe.has(i) || mines.has(i)) continue;
      return i;
    }
  }
  return null;
};

/** Reduce a constraint against what is already known. */
const refine = (con, safe, mines) => {
  const set = new Set();
  let placed = 0;
  for (const cell of con.cells) {
    if (mines.has(cell)) placed++;
    else if (!safe.has(cell)) set.add(cell);
  }
  // `global` must survive refinement, since isConsistent branches on the flag.
  return { need: con.need - placed, set, list: [...set].sort((a, b) => a - b), global: con.global === true };
};
