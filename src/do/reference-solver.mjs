// MONKEY DO — the reference solver, as sandbox source.
//
// Kept in its own module, like see/reference.mjs, for two reasons: it is ground
// truth for the dry run and must be auditable on its own, and it can be
// imported by tests and tools without loading the runner's CLI.
//
// INTEGRITY: nothing here is ever sent to a model.

/**
 * The reference solver, as SANDBOX SOURCE.
 *
 * The oracle's logic written the way a model would return it, for --dry-run.
 * It is compiled and called through the same sandbox, shim and per-call timeout
 * as a real submission, so a dry run exercises the identical path.
 *
 * It mirrors oracle.mjs: propagate (Rules 2, 3 and 5) to a fixpoint; if that
 * proves nothing, try to prove each constrained cell safe by contradiction, then
 * one unconstrained cell as a representative of all of them; and never return a
 * cell that is merely not proven to be a mine. Given the same budget it reaches
 * the same stuck positions as the oracle, so a dry run should score 50/50.
 *
 * Two historical bugs are guarded against here, and the comments stay so they
 * are not reintroduced:
 *   - returning the first cell that was !isMine instead of isSafe ("no proof of
 *     danger" is not "proof of safety") detonated on every board.
 *   - propagating inside the search on the CALLER's sets let deductions made
 *     under one assumption leak into the other branch. The search works on
 *     copies.
 */
export const REFERENCE_SOLVER_SOURCE = `function solve(board, mines) {
  var rows = board.length, cols = rows ? board[0].length : 0;
  if (!rows || !cols) return null;
  var isU = function (v) { return v === null || v === "F"; };
  var key = function (r, c) { return r * cols + c; };

  var unknown = [];
  for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) if (isU(board[r][c])) unknown.push(key(r, c));
  if (!unknown.length) return null;

  var cons = [];
  var constrained = new Set();
  for (var r1 = 0; r1 < rows; r1++) for (var c1 = 0; c1 < cols; c1++) {
    var v = board[r1][c1];
    if (typeof v !== "number" || v < 1 || v > 8) continue;
    var cells = [];
    for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      var nr = r1 + dr, nc = c1 + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (isU(board[nr][nc])) cells.push(key(nr, nc));
    }
    if (cells.length) {
      cons.push({ need: v, cells: cells });
      for (var k = 0; k < cells.length; k++) constrained.add(cells[k]);
    }
  }
  var all = cons.concat([{ need: mines, cells: unknown, global: true }]);

  // Reduce every constraint against what is known. Stale within a pass is
  // still sound: knowledge only grows, and a deduction from less is still valid.
  var refine = function (s, m) {
    return all.map(function (con) {
      var open = [], placed = 0;
      for (var i = 0; i < con.cells.length; i++) {
        var x = con.cells[i];
        if (m.has(x)) placed++; else if (!s.has(x)) open.push(x);
      }
      return { need: con.need - placed, open: open, global: con.global === true };
    });
  };

  // Rules 2 and 5 always; Rule 3 (subset elimination) when full. Returns false
  // on a contradiction, including a cell deduced both safe and a mine.
  var propagate = function (s, m, full) {
    for (var pass = 0; pass < 200; pass++) {
      var changed = false;
      var ref = refine(s, m);
      for (var i = 0; i < ref.length; i++) {
        var R = ref[i];
        if (R.need < 0 || R.need > R.open.length) return false;
        if (!R.open.length) continue;
        if (R.need === 0) { for (var a = 0; a < R.open.length; a++) s.add(R.open[a]); changed = true; }
        else if (R.need === R.open.length) { for (var b = 0; b < R.open.length; b++) m.add(R.open[b]); changed = true; }
      }
      if (full) {
        for (var p = 0; p < ref.length; p++) for (var q = 0; q < ref.length; q++) {
          if (p === q) continue;
          var A = ref[p], B = ref[q];
          if (!A.open.length || A.open.length >= B.open.length) continue;
          var bset = new Set(B.open), inside = true;
          for (var z = 0; z < A.open.length; z++) if (!bset.has(A.open[z])) { inside = false; break; }
          if (!inside) continue;
          var aset = new Set(A.open);
          var rest = B.open.filter(function (x) { return !aset.has(x); });
          var restNeed = B.need - A.need;
          if (restNeed < 0 || restNeed > rest.length) return false;
          if (restNeed === 0) { for (var d = 0; d < rest.length; d++) s.add(rest[d]); changed = true; }
          else if (restNeed === rest.length) { for (var e = 0; e < rest.length; e++) m.add(rest[e]); changed = true; }
        }
      }
      var clash = false;
      s.forEach(function (x) { if (m.has(x)) clash = true; });
      if (clash) return false;
      if (!changed) return true;
    }
    return true;
  };

  // Does ANY complete mine assignment exist under these assumptions? Works on
  // copies, and branches only on constrained cells: unconstrained cells are
  // interchangeable, and only the global count cares about them.
  var budget = { left: 20000, out: false };
  var consistent = function (s0, m0) {
    var s = new Set(s0), m = new Set(m0);
    if (!propagate(s, m, false)) return false;
    var target = -1, best = Infinity;
    for (var i = 0; i < cons.length; i++) {
      var open = cons[i].cells.filter(function (x) { return !s.has(x) && !m.has(x); });
      if (open.length && open.length < best) { best = open.length; target = open[0]; }
    }
    if (target < 0) {
      var left = mines - m.size, free = 0;
      for (var u = 0; u < unknown.length; u++) if (!s.has(unknown[u]) && !m.has(unknown[u])) free++;
      return left >= 0 && left <= free;
    }
    if (budget.left-- <= 0) { budget.out = true; return true; } // decline rather than guess
    var withSafe = new Set(s); withSafe.add(target);
    if (consistent(withSafe, m)) return true;
    var withMine = new Set(m); withMine.add(target);
    return consistent(s, withMine);
  };

  var safe = new Set(), mine = new Set();
  if (!propagate(safe, mine, true)) return null;
  var first = -1;
  safe.forEach(function (x) { if (first < 0 || x < first) first = x; });
  if (first >= 0) return { row: Math.floor(first / cols), col: first % cols };

  var candidates = [];
  constrained.forEach(function (x) { if (!safe.has(x) && !mine.has(x)) candidates.push(x); });
  candidates.sort(function (x, y) { return x - y; });
  for (var w = 0; w < unknown.length; w++) {
    var cell = unknown[w];
    if (!constrained.has(cell) && !safe.has(cell) && !mine.has(cell)) { candidates.push(cell); break; }
  }

  // THE CRUCIAL RULE: return a cell only when assuming it is a mine makes the
  // position impossible. "Not proven dangerous" is not "proven safe".
  for (var j = 0; j < candidates.length; j++) {
    var assume = new Set(mine); assume.add(candidates[j]);
    if (!consistent(safe, assume)) return { row: Math.floor(candidates[j] / cols), col: candidates[j] % cols };
    if (budget.out) return null;
  }
  return null;
}`;

