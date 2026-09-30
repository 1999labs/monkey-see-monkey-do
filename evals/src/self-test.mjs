// Self-test for MONKEY SEE and MONKEY DO.
//
// Validates the eval itself before any model is scored. A failing self-test
// blocks scoring — there is no override. Every runner calls runSelfTest() before
// contacting a model (see cli.mjs selfTestGate), and `npm run self-test` prints
// the full report. See guide.md 8.3.
//
// `full: true` adds the slow check: regenerating the entire published pool and
// comparing it byte for byte (success criterion 4). It takes a few minutes, so
// it is `npm run self-test -- --full`, not part of the gate.

import { readFileSync } from "node:fs";

import { tasks } from "./see/tasks.mjs";
import { buildPrompt, promptDigest, allPromptDigests, PREAMBLE } from "./see/prompt.mjs";
import { scoreTask, scoreSeen, monkeyIndex, heldOutCases, robustnessBonus, ROBUSTNESS_POINTS, unusableResult } from "./see/score.mjs";
import { compileCandidate, runCandidate } from "./sandbox.mjs";
import { RECORDED_DIGESTS } from "./prompt-digests.mjs";

import { makeRng, newBoard, openBoard, reveal, isWon, neighbours, neighbourCount, adjacentMines, layoutDigest, TIERS } from "./do/minesweeper/board.mjs";
import { analyse, provablySafe, verifyMove } from "./do/minesweeper/oracle.mjs";
import {
  classifyBoard, replayBoard, callsFor, capForTier, CELLS_PER_CALL, POOL_SEED, ENDGAME_HIDDEN_FRACTION,
  POOL_A_TIERS, POOL_B_TIERS, PUBLISHED_PER_TIER, POOL_FILE, buildPublishedPool, serializePool,
} from "./do/minesweeper/pool.mjs";
import { scoreDo, randomBaseline } from "./do/score.mjs";
import { playBoard, loadPool } from "./do/run.mjs";
import { REFERENCE_SOLVER_SOURCE } from "./do/reference-solver.mjs";
import { PREAMBLE as DO_PREAMBLE, promptDigest as doPromptDigest } from "./do/prompt.mjs";

const BAND_MIN = 20;
const BAND_MAX = 45;

/**
 * Run every check.
 *
 * @param {object} opts
 * @param {(line: string) => void} opts.log  where to print; a no-op for the gate
 * @param {boolean} opts.full  also regenerate the whole pool (slow)
 * @returns {Promise<{ ok: boolean, passed: number, failures: string[] }>}
 */
export const runSelfTest = async ({ log = console.log, full = false } = {}) => {
  let passed = 0;
  const failures = [];
  const check = (label, condition, detail = "") => {
    const ok = Boolean(condition);
    if (ok) passed++;
    else failures.push(detail ? `${label} — ${detail}` : label);
    const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log(`  ${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  log("\n\x1b[1mMONKEY SEE · self-test\x1b[0m\n");

  // --- 1. Ground truth correctness ----------------------------------------
  log("1. Ground truth correctness");
  for (const task of tasks) {
    const cases = heldOutCases(task);
    check(`Task ${task.id} derives an expected value for all ${cases.length} cases`, cases.length === 50);
    const shownOk = task.shown.every(({ input, output }) => {
      try {
        return JSON.stringify(task.reference(input)) === JSON.stringify(output);
      } catch {
        return false;
      }
    });
    check(`Task ${task.id} reference reproduces its 8 documented shown outputs`, shownOk);
  }

  // --- 2. Naive baseline band ---------------------------------------------
  log("\n2. Naive baseline band (each task must land 20-45%)");
  for (const task of tasks) {
    const r = scoreTask(task, task.naive);
    const pct = (r.rate * 100).toFixed(1);
    check(
      `Task ${task.id} naive scores ${pct}%`,
      r.rate * 100 >= BAND_MIN && r.rate * 100 <= BAND_MAX,
      `${r.correct}/${r.total}`
    );
    const buckets = Object.entries(r.perBucket)
      .map(([k, v]) => `${k} ${v.correct}/${v.total}`)
      .join("  ");
    log(`        ${buckets}`);
  }

  // --- 3. Naive < perfect --------------------------------------------------
  log("\n3. Reference is perfect on every held-out case");
  for (const task of tasks) {
    const r = scoreTask(task, task.reference);
    check(`Task ${task.id} reference scores ${r.correct}/${r.total}`, r.correct === r.total);
  }

  // --- 4. Shown examples expose the rule ----------------------------------
  log("\n4. Shown examples expose the rule (naive must FAIL them)");
  // Exact counts, not just "less than 8". A drifting count means the shown
  // examples were edited, and the Monkey Index would shift with them.
  const EXPECTED_NAIVE_SEEN = { A: 5, B: 5, C: 4 };
  for (const task of tasks) {
    // Only this task's naive is supplied; the other two ids resolve to
    // undefined and would score 0/8 spuriously. Select this task's own row.
    const seen = scoreSeen({ [task.id]: task.naive });
    const row = seen.perTask.find((p) => p.taskId === task.id);
    const expected = EXPECTED_NAIVE_SEEN[task.id];
    check(
      `Task ${task.id} naive passes only ${row.correct}/${row.total} shown examples`,
      row.correct === expected && row.correct < row.total,
      `expected ${expected}/${row.total}`
    );
  }

  // --- 5. Held-out sets are the right size --------------------------------
  log("\n5. Held-out set shape");
  for (const task of tasks) {
    const cases = heldOutCases(task);
    const sizes = ["core", "boundary", "adversarial"].map((b) => task.heldOut[b].length);
    check(
      `Task ${task.id} has 20/15/15 across three buckets`,
      sizes[0] === 20 && sizes[1] === 15 && sizes[2] === 15,
      `got ${sizes.join("/")}, total ${cases.length}`
    );
    check(`Task ${task.id} totals 50 held-out cases`, cases.length === 50);
  }

  // --- 6. A surface-fit strategy produces a high Monkey Index ---------------
  log("\n6. A surface-fit strategy is detected (naive as stand-in)");
  const mimicResults = tasks.map((t) => scoreTask(t, t.naive));
  const mimicSeen = scoreSeen(Object.fromEntries(tasks.map((t) => [t.id, t.naive])));
  const mimic = monkeyIndex(mimicSeen, mimicResults);
  log(`        SEEN ${(mimic.seen * 100).toFixed(0)}%  HELD-OUT ${(mimic.heldOut * 100).toFixed(0)}%  INDEX ${(mimic.index * 100).toFixed(0)}`);
  check(
    "Surface-fit index is meaningfully above zero",
    mimic.index > 0.05,
    `index ${(mimic.index * 100).toFixed(0)}`
  );

  // --- 7. A perfect solver produces a zero index --------------------------
  log("\n7. A perfect solver is not penalised");
  const perfectResults = tasks.map((t) => scoreTask(t, t.reference));
  const perfectSeen = scoreSeen(Object.fromEntries(tasks.map((t) => [t.id, t.reference])));
  const perfect = monkeyIndex(perfectSeen, perfectResults);
  check(
    "Perfect solver scores 100% held-out",
    perfect.heldOut === 1,
    `${(perfect.heldOut * 100).toFixed(0)}%`
  );
  check("Perfect solver index is 0", perfect.index === 0, `index ${perfect.index}`);

  // --- 8. Data/ground-truth separation -----------------------------------
  // The integrity property the file split exists to provide. If prompt
  // construction ever imports reference.mjs, the true rule can leak into a
  // prompt. Assert the split rather than trusting the comment.
  log("\n8. Ground truth is isolated from task data");
  const refSrc = readFileSync(new URL("../src/see/reference.mjs", import.meta.url), "utf8");
  check(
    "reference.mjs contains no case data (no 'shown' or 'heldOut' keys)",
    !/"shown"|"heldOut"|\bshown:|\bheldOut:/.test(refSrc)
  );
  for (const task of tasks) {
    // A held-out entry must be a bare input, never an answer pair. An array
    // input (Task C) is still a bare input, so test for the pair shape
    // specifically: a plain object with input/expected keys.
    const isAnswerPair = (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v) && ("input" in v || "expected" in v);
    const offenders = ["core", "boundary", "adversarial"]
      .flatMap((b) => task.heldOut[b])
      .filter(isAnswerPair);
    check(
      `Task ${task.id} held-out entries are bare inputs, not answer pairs`,
      offenders.length === 0,
      offenders.length ? `e.g. ${JSON.stringify(offenders[0])}` : `${task.heldOut.core.length} core inputs checked`
    );
  }
  check(
    "expected values are derived, not read from the JSON",
    typeof tasks[0].reference === "function" && tasks[0].reference(11) === 21,
    "reference(11) must be computed at runtime"
  );

  // --- 9. Prompt construction and digests ---------------------------------
  // Check 7 in the design doc. Two scores are only comparable if every model
  // was shown byte-identical text, so the digests are recorded in every report
  // and verified here.
  log("\n9. Prompt construction and digests");
  check(
    "preamble matches the design doc byte for byte",
    PREAMBLE ===
      "Below are input->output examples of a single function f. The rule is\n" +
        "consistent across all examples. Write the function f in JavaScript.\n" +
        "Output only the code, no explanation."
  );
  const digests = new Set();
  for (const task of tasks) {
    const p = buildPrompt(task);
    const exampleLines = p.split("\n").slice(6);
    check(
      `Task ${task.id} prompt has preamble + hint + 8 examples`,
      p.startsWith(PREAMBLE) && exampleLines.length === 8 && !p.endsWith("\n"),
      `${exampleLines.length} example lines`
    );
    const d = promptDigest(task);
    check(`Task ${task.id} digest is 64-char hex and unique`, /^[0-9a-f]{64}$/.test(d) && !digests.has(d), d.slice(0, 12) + "...");
    digests.add(d);
    // No held-out input may appear in anything the model sees.
    // Match on the rendered ARGUMENT, not a bare substring: "1" is a substring
    // of "f(11) -> 21", and "2" of "f(2) -> 4", so includes() alone produces
    // false positives. Require the argument to be delimited on both sides.
    const shownJson = new Set(task.shown.map((s) => JSON.stringify(s.input)));
    const renderArg = (input) => (Array.isArray(input) ? `[${input.join(", ")}]` : JSON.stringify(input));
    const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const leaked = ["core", "boundary", "adversarial"]
      .flatMap((b) => task.heldOut[b])
      .filter((input) => !shownJson.has(JSON.stringify(input)))
      .filter((input) => {
        const arg = escaped(renderArg(input));
        return new RegExp(`f\\(${arg}\\)`).test(p);
      });
    check(
      `Task ${task.id} prompt leaks no held-out argument`,
      leaked.length === 0,
      leaked.length ? `leaked ${JSON.stringify(leaked[0])}` : `${task.heldOut.core.length + 30} held-out inputs checked`
    );
  }
  check("prompt construction is deterministic", allPromptDigests().length === 3 && new Set(allPromptDigests().map((p) => p.digest)).size === 3);
  // Check 7 proper: the digests must equal the RECORDED values, so a mismatch
  // means the prompt changed rather than that a reconstruction drifted.
  for (const { taskId, digest } of allPromptDigests()) {
    check(`Task ${taskId} prompt matches its recorded digest`, digest === RECORDED_DIGESTS[taskId], `${digest.slice(0, 12)}... vs recorded ${RECORDED_DIGESTS[taskId].slice(0, 12)}...`);
  }
  check("DO prompt matches its recorded digest", doPromptDigest() === RECORDED_DIGESTS.DO, `${doPromptDigest().slice(0, 12)}... vs recorded ${RECORDED_DIGESTS.DO.slice(0, 12)}...`);

  // --- 10. Robustness bonus calibration ------------------------------------
  // The bonus is proportional to non-throwing held-out cases. These checks pin
  // the calibration, because a drifting bonus silently rescales every score:
  // the naive baseline must keep its full 5 (it never throws), and the perfect
  // solver must reach exactly 50/50.
  log("\n10. Robustness bonus calibration");
  const naiveResults = tasks.map((t) => scoreTask(t, t.naive));
  const naiveBonus = robustnessBonus(naiveResults);
  check(
    "naive baseline never throws, so it keeps the full bonus",
    naiveBonus.threw === 0 && naiveBonus.points === ROBUSTNESS_POINTS,
    `threw ${naiveBonus.threw}/${naiveBonus.total}, +${naiveBonus.points}`
  );
  const refResults = tasks.map((t) => scoreTask(t, t.reference));
  const refBonus = robustnessBonus(refResults);
  check(
    "reference never throws, earning the full bonus",
    refBonus.threw === 0 && refBonus.points === ROBUSTNESS_POINTS,
    `+${refBonus.points}`
  );

  // A model that learned a task perfectly but omitted one guard must not be
  // punished as though it had learned nothing. This is the exact regression the
  // proportional rule replaced.
  const oneThrow = robustnessBonus([{ threw: 0, total: 50 }, { threw: 1, total: 50 }, { threw: 0, total: 50 }]);
  check(
    "one throw in 150 costs a sliver, not the whole bonus",
    oneThrow.points > 4.9 && oneThrow.crashed === true,
    `+${oneThrow.points.toFixed(3)} of 5, crashed=${oneThrow.crashed}`
  );
  check(
    "a single input can no longer be worth 10% of the score",
    ROBUSTNESS_POINTS - oneThrow.points < 0.1,
    `worst case for one input: ${(ROBUSTNESS_POINTS - oneThrow.points).toFixed(3)} points`
  );
  check(
    "throwing on everything still scores zero",
    robustnessBonus([{ threw: 50, total: 50 }, { threw: 50, total: 50 }, { threw: 50, total: 50 }]).points === 0
  );

  // Headline calibration, recomputed under the new rule.
  const naiveTotal = naiveResults.reduce((s, r) => s + r.rate * 15, 0) + naiveBonus.points;
  const refTotal = refResults.reduce((s, r) => s + r.rate * 15, 0) + refBonus.points;
  log(`        naive baseline total ${naiveTotal.toFixed(1)}/50   reference total ${refTotal.toFixed(1)}/50`);
  check("naive baseline total lands in the 20/50 documented band", naiveTotal >= 18 && naiveTotal <= 24, naiveTotal.toFixed(1));
  check("reference reaches a full 50/50", refTotal === 50, refTotal.toFixed(1));

  {
    // An unusable response is 50 failed, thrown cases — in the held-out arm AND
    // the robustness bonus. Leaving it out reported a Monkey Index of -33 and a
    // full bonus for a model that answered one task in prose.
    const results = [unusableResult(tasks[0]), scoreTask(tasks[1], tasks[1].reference), scoreTask(tasks[2], tasks[2].reference)];
    const seen = scoreSeen({ B: tasks[1].reference, C: tasks[2].reference });
    const idx = monkeyIndex(seen, results);
    const rb = robustnessBonus(results);
    check("an unusable task counts against the held-out arm, so the index is not negative",
      Math.round(idx.index * 100) === 0 && results[0].total === 50, `index ${Math.round(idx.index * 100)}, held-out ${(idx.heldOut * 100).toFixed(0)}%`);
    check("an unusable task costs its share of the robustness bonus", Math.abs(rb.points - 5 * 100 / 150) < 1e-9, `+${rb.points.toFixed(2)} of 5`);
  }

  // --- Sandbox containment (guide.md 8.3, check 6) -------------------------
  log("\nSandbox containment");
  {
    const loop = compileCandidate("function f(n) { while (true) {} }");
    const t0 = Date.now();
    const r = runCandidate(loop, 1);
    const ms = Date.now() - t0;
    check("an infinite loop is interrupted in under 1.2s", loop.ok && r.timedOut === true && ms < 1200, `${ms}ms`);

    const req = compileCandidate("function f(n) { return require('fs').readFileSync('/etc/passwd', 'utf8'); }");
    const rr = runCandidate(req, 1);
    check("code calling require is rejected", req.ok && rr.ok === false, rr.error ?? "returned a value");

    const globals = compileCandidate("function f() { return [typeof require, typeof process, typeof fetch].join('/'); }");
    check("the sandbox has no require, process or fetch", runCandidate(globals, 0).value === "undefined/undefined/undefined");

    const chatty = compileCandidate("```js\nfunction f(n) { console.log(n); return n <= 10 ? n*n : n*n-100; }\nconsole.log(f(11));\n```");
    check("console.log does not void a correct answer", chatty.ok && runCandidate(chatty, 11).value === 21, chatty.ok ? "" : chatty.error);

    const prose = compileCandidate("Here is the function:\n\n```javascript\nfunction f(n) { return n * 2; }\n```\n\nIt doubles n.");
    check("a code block wrapped in prose is still extracted", prose.ok && runCandidate(prose, 4).value === 8, prose.ok ? "" : prose.error);

    const helper = compileCandidate("function f(x) { return x; }\nfunction solve(board, mines) { return { row: 0, col: mines }; }", { entry: "solve" });
    const hr = runCandidate(helper, [[null]], 3);
    check("DO calls solve, not a helper named f", hr.ok && hr.value?.col === 3, JSON.stringify(hr.value));
  }

  // ===================================================================
  // MONKEY DO
  //
  // The same discipline as SEE: validate the eval before scoring a model.
  // Most of these checks exist because something in this build was WRONG and
  // looked fine. The cap was wrong twice and the opening was wrong once, and
  // each time the failure was invisible in the output. These are the assertions
  // that would have caught them.
  // ===================================================================

  // --- 11. Board mechanics ------------------------------------------------
  log("\n\x1b[1mMONKEY DO · self-test\x1b[0m\n");
  log("11. Board mechanics");

  {
    // Hand-built, so the answer is stated rather than computed by the code under
    // test. 3 neighbours at a corner, 5 on an edge, 8 inside.
    const b = { rows: 5, cols: 5 };
    check("a corner has 3 neighbours, an edge 5, an interior 8",
      neighbourCount(b, 0, 0) === 3 && neighbourCount(b, 0, 2) === 5 && neighbourCount(b, 2, 2) === 8);
    check("neighbours are clipped, never negative-indexed",
      neighbours(b, 0, 0).every(([r, c]) => r >= 0 && c >= 0),
      `${neighbours(b, 0, 0).length} neighbours at (0,0)`);
  }

  {
    // Flood-fill: a blank cascades, a number does not propagate. A number is a
    // wall to a flood, not a bridge. This is the rule most often got wrong.
    const mk = (rows, cols, mineCoords) => ({
      rows, cols,
      mines: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => mineCoords.some(([a, b]) => a === r && b === c))),
      visible: Array.from({ length: rows }, () => Array(cols).fill(null)),
      revealed: Array.from({ length: rows }, () => Array(cols).fill(false)),
    });
    // 5x5, single centre mine: a corner click cascades over everything else.
    const open = mk(5, 5, [[2, 2]]);
    const flooded = reveal(open, 0, 0).length;
    check("a blank cell floods its region", flooded === 24, `${flooded} of 24 non-mine cells`);

    // 5x5 with a wall in column 2. The numbers left of it reveal as a border,
    // but nothing beyond them may be reached.
    const walled = mk(5, 5, [[1, 2], [2, 2], [3, 2]]);
    reveal(walled, 0, 0);
    const leaked = [];
    for (let r = 0; r < 5; r++) for (let c = 3; c < 5; c++) if (walled.revealed[r][c]) leaked.push([r, c]);
    check("flood reveals bordering numbers but does not propagate through them",
      leaked.length === 0, `${leaked.length} cells leaked past the numbers`);
  }

  {
    // A corner mine is visible to exactly 3 cells, not 8. This off-by-one would
    // corrupt every constraint the oracle derives, and the symptom would be a
    // board that looks fine and scores nonsense.
    const mineAt = (r, c, rows = 5, cols = 5) => {
      const b = { rows, cols, mines: Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === r && j === c))) };
      let seen = 0;
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if (!b.mines[i][j] && adjacentMines(b, i, j) > 0) seen++;
      return seen;
    };
    check("a corner mine is seen by exactly 3 cells", mineAt(0, 0) === 3, `saw ${mineAt(0, 0)}`);
    check("an edge mine is seen by exactly 5 cells", mineAt(0, 2) === 5, `saw ${mineAt(0, 2)}`);
    check("an interior mine is seen by exactly 8 cells", mineAt(2, 2) === 8, `saw ${mineAt(2, 2)}`);
  }

  {
    const board = newBoard("beginner", makeRng(1));
    check("boards place exactly the tier's mine count",
      board.mines.flat().filter(Boolean).length === TIERS.beginner.mines, `${TIERS.beginner.mines} expected`);
    const again = newBoard("beginner", makeRng(1));
    check("board generation is seeded, not random", layoutDigest(board) === layoutDigest(again));
  }


  // --- 12. The oracle -----------------------------------------------------
  log("\n12. The oracle");

  {
    // The absolute guarantee: the oracle never names a mine. Checked across real
    // generated positions, because a hand-made puzzle misses the constraint
    // patterns that break code like this.
    let positions = 0;
    let named = 0;
    for (const [tier, mines] of [["poolA-small", 18], ["beginner", 10]]) {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const board = replayBoard(tier, attempt, POOL_SEED);
        for (let step = 0; step < 25; step++) {
          if (isWon(board)) break;
          const move = provablySafe(board.visible, board.rows, board.cols, board.totalMines);
          positions++;
          if (!move) break;
          if (board.mines[move.row][move.col]) named++;
          else reveal(board, move.row, move.col);
        }
      }
    }
    check("the oracle never names a mine", named === 0, `${positions} real positions checked`);
  }

  {
    // Flags carry no authority, so they must be invisible to the solver.
    const plain = [[1, null], [null, null]];
    const flagged = [[1, "F"], [null, null]];
    check("a flag is treated exactly as unrevealed",
      JSON.stringify(provablySafe(plain, 2, 2, 1)) === JSON.stringify(provablySafe(flagged, 2, 2, 1)));
  }

  {
    // An impossible position must be refused, not reasoned about. A -1 means a
    // mine was clicked, which ends the round, so the harness must never ask.
    const v = analyse([[1, -1, null], [null, null, null]], 2, 3, 1);
    check("an impossible position is refused, not answered", !v.conclusive && v.move === null);
  }

  {
    // The three outcomes must stay distinct. Collapsing "ambiguous" into
    // "inconclusive" would let a small search budget quietly manufacture Pool B.
    //
    // The ambiguous fixture is hand-built rather than borrowed from the unit
    // tests, because an earlier version of this check used a 2x3 position and got
    // it wrong: the corner 1 constrains two open cells, and the global count says
    // one mine among three, so subset elimination proves the far cell safe. The
    // position was deducible, not ambiguous.
    //
    // This one is genuinely ambiguous: ONE clue, constraining a set larger than
    // the number of mines that can sit in it, and no global pressure to resolve it.
    //   . 1 .
    // . . .        the 1 has 3 open neighbours but only 1 mine among all 5
    const ambiguous = analyse(
      [[null, 1, null], [null, null, null]],
      2, 3, 1
    );
    const deducible = analyse([[1, null, null], [1, 1, 1], [1, 1, 1]], 3, 3, 1);
    check("deducible, ambiguous and inconclusive are three distinct outcomes",
      deducible.deducible === true && ambiguous.ambiguous === true && ambiguous.conclusive === true,
      `deducible=${deducible.deducible} ambiguous=${ambiguous.ambiguous} conclusive=${ambiguous.conclusive}`);
  }

  {
    // Two disjoint clues, each needing one mine, and two mines on the board: the
    // frontier uses every mine, so the interior cell (0,3) is safe. Pairwise
    // subset elimination cannot see this; only the unconstrained representative
    // does. The first oracle called this position ambiguous.
    const v = analyse([[null, 1, null, null, null, 1, null]], 1, 7, 2);
    check("the global count proves an interior cell safe", v.deducible && v.move?.row === 0 && v.move?.col === 3,
      JSON.stringify(v.move));
  }

  {
    // A search that runs out of budget proves nothing. Across real stuck
    // positions and tiny budgets, "ambiguous" may only ever be reported when the
    // unbounded search agrees; anything short of that must be inconclusive.
    let wrong = 0;
    let probed = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const board = replayBoard("poolA-small", attempt, POOL_SEED);
      for (let step = 0; step < 60 && !isWon(board); step++) {
        const full = analyse(board.visible, board.rows, board.cols, board.totalMines);
        for (const budget of [0, 1, 2, 3, 5, 8]) {
          const small = analyse(board.visible, board.rows, board.cols, board.totalMines, { budget });
          probed++;
          if (small.ambiguous && !full.ambiguous) wrong++;
          if (small.deducible && board.mines[small.move.row][small.move.col]) wrong++;
        }
        if (!full.deducible) break;
        reveal(board, full.move.row, full.move.col);
      }
    }
    check("an exhausted search is never reported as ambiguous", wrong === 0, `${probed} budget-limited analyses checked`);

    // The exact case the old oracle got wrong, found by search. With a full
    // budget (2,3) is provably safe; at budget 9 the search runs out during the
    // LAST candidate, and the old code reported "ambiguous, conclusive".
    const grid = [[null, 2, null, 2], [2, null, null, null], [null, null, 3, null]];
    const fullAnswer = analyse(grid, 3, 4, 4);
    const starved = analyse(grid, 3, 4, 4, { budget: 9 });
    check("running out of budget on the last candidate is inconclusive, not ambiguous",
      fullAnswer.deducible && !starved.ambiguous && !starved.conclusive,
      `full: ${JSON.stringify(fullAnswer.move)}; budget 9: ambiguous=${starved.ambiguous} conclusive=${starved.conclusive}`);
  }

  {
    // The opening must reveal real information. Revealing one random cell left
    // 48 of 100 boards ambiguous at step 0, which is a position no model could
    // possibly deduce anything from.
    let informative = 0;
    const N = 20;
    for (let attempt = 1; attempt <= N; attempt++) {
      const board = replayBoard("poolA-small", attempt, POOL_SEED);
      if (analyse(board.visible, board.rows, board.cols, board.totalMines).deducible) informative++;
    }
    check("the opening leaves a deducible position", informative / N > 0.8, `${informative}/${N} deducible at step 0`);
  }

  // --- 13. The effort cap -------------------------------------------------
  log("\n13. The effort cap");

  {
    // The cap was wrong twice, each time invisibly: a hardcoded 24, then a value
    // fitted to one tier that quietly broke the other two. These are the measured
    // maxima the current constant has to clear.
    const observedMax = { "poolA-small": 52, "poolA-medium": 96, "poolA-large": 135 };
    const allClear = Object.entries(observedMax).every(([tier, max]) => capForTier(tier) >= max);
    check("every tier's cap exceeds the measured maximum call count", allClear,
      Object.entries(observedMax).map(([t, m]) => `${t}: cap ${capForTier(t)} vs max ${m}`).join(", "));
    check("CELLS_PER_CALL is the measured, conservative value", CELLS_PER_CALL === 2, `= ${CELLS_PER_CALL}`);
    check("capForTier agrees with callsFor, so the harness cannot drift from the pool",
      Object.keys(TIERS).every((t) => capForTier(t) === callsFor(TIERS[t].rows, TIERS[t].cols, TIERS[t].mines)));
  }

  // --- 14. The board pool -------------------------------------------------
  log("\n14. The board pool");

  {
    // Reproducibility is the pool's entire purpose: a score that cannot be
    // re-derived is not a benchmark result.
    check("the same seed rebuilds a byte-identical board",
      layoutDigest(replayBoard("poolA-small", 3, POOL_SEED)) === layoutDigest(replayBoard("poolA-small", 3, POOL_SEED)));
    check("a different seed gives a different board",
      layoutDigest(replayBoard("poolA-small", 3, POOL_SEED)) !== layoutDigest(replayBoard("poolA-small", 3, POOL_SEED + 1)));
  }

  {
    // THE ceiling. If the oracle cannot win a Pool A board, the 40 points are
    // unearnable and the pool is lying about what it contains.
    let won = 0;
    const N = 10;
    for (let attempt = 1; attempt <= N; attempt++) {
      if (classifyBoard(replayBoard("poolA-small", attempt, POOL_SEED)).won) won++;
    }
    check("the oracle wins its own Pool A boards", won / N > 0.7, `${won}/${N} won`);
  }

  {
    // The published pool: it must load (which verifies the generator
    // fingerprint, every board's replayed layout, and the list digest), hold the
    // documented counts, and a sample must still classify as recorded.
    let pool = null;
    let loadError = null;
    try {
      pool = loadPool();
    } catch (err) {
      loadError = err.message;
    }
    check("the published pool loads and every board replays to its recorded layout", pool !== null, loadError ?? `${pool?.boards.length} boards, sha256 ${pool?.sha256.slice(0, 12)}...`);
    if (pool) {
      const count = (p) => pool.boards.filter((b) => b.pool === p).length;
      check("the pool holds the documented number of boards",
        count("A") === PUBLISHED_PER_TIER.A * POOL_A_TIERS.length && count("B") === PUBLISHED_PER_TIER.B * POOL_B_TIERS.length,
        `${count("A")} in A, ${count("B")} in B`);
      const sample = loadPool({ perTier: 1 }).boards;
      const badA = sample.filter((b) => b.pool === "A").filter((b) => {
        const r = classifyBoard(replayBoard(b.tier, b.attempt, pool.seed));
        return !(r.pool === "A" && r.won && r.calls === b.calls);
      });
      const badB = sample.filter((b) => b.pool === "B").filter((b) => {
        const r = classifyBoard(replayBoard(b.tier, b.attempt, pool.seed));
        return !(r.pool === "B" && r.isEndgame && r.calls === b.calls);
      });
      check("sampled Pool A boards are still won by the oracle without guessing", badA.length === 0, `${sample.filter((b) => b.pool === "A").length} re-classified`);
      check("sampled Pool B boards are still genuine endgames", badB.length === 0, `${sample.filter((b) => b.pool === "B").length} re-classified`);
      if (full) {
        const regenerated = serializePool(buildPublishedPool({ seed: pool.seed, perTier: PUBLISHED_PER_TIER }));
        check("FULL: the whole pool regenerates byte-identically from its seed", regenerated === readFileSync(POOL_FILE, "utf8"));
      }
    }
    check("the endgame threshold is a documented fraction", ENDGAME_HIDDEN_FRACTION > 0 && ENDGAME_HIDDEN_FRACTION < 1, `= ${ENDGAME_HIDDEN_FRACTION}`);
  }

  {
    // Both pools use the same shapes. They are distinguished by their CONDITION,
    // not their dimensions, and Pool B on the classic tiers never converged.
    check("both pools draw from the same tiers",
      POOL_A_TIERS.length === POOL_B_TIERS.length &&
        POOL_A_TIERS.every((t) => POOL_B_TIERS.includes(t)),
      POOL_B_TIERS.join(", "));
  }

  // --- 15. Random baseline ------------------------------------------------
  log("\n15. Random baseline");

  {
    // The DO equivalent of SEE's naive baseline, and the reference point for the
    // DO Index. A baseline that drifts would silently rescale every index.
    //
    // Measured survival is 0% on every tier: random play dies after 1-4 calls,
    // because it clicks hidden cells with no regard for the numbers it can see.
    // That is a real result, not a broken baseline — guide.md 5.7's "~11% / 4% /
    // 1%" figures assumed a first click WITHOUT the cascade opening this harness
    // uses, which gave random play a far smaller board to stumble through.
    const boards = loadPool({ perTier: 2 }).boards;
    const b1 = randomBaseline({ boards, runs: 8 });
    const b2 = randomBaseline({ boards, runs: 8 });
    check("the random baseline covers Pool A only", Object.keys(b1).length === POOL_A_TIERS.length);
    check("the random baseline is deterministic", JSON.stringify(b1) === JSON.stringify(b2));
    const values = Object.values(b1);
    check("random play barely survives on any tier", values.every((v) => v >= 0 && v < 0.2),
      Object.entries(b1).map(([t, v]) => `${t} ${(v * 100).toFixed(0)}%`).join(", "));
    // And it is never BETTER than the small tier, which is the only ordering
    // claim that holds at a 0% floor.
    check("random play is no better on the larger tiers",
      b1["poolA-large"] <= b1["poolA-small"] && b1["poolA-medium"] <= b1["poolA-small"],
      `small ${(b1["poolA-small"] * 100).toFixed(0)}% medium ${(b1["poolA-medium"] * 100).toFixed(0)}% large ${(b1["poolA-large"] * 100).toFixed(0)}%`);
  }

  // --- 16. DO scoring -----------------------------------------------------
  log("\n16. DO scoring");

  {
    const mk = (outcome, n, pool = "A", tier = "poolA-small") =>
      Array.from({ length: n }, (_, i) => ({ pool, tier, attempt: i + 1, outcome, calls: 5 }));

    // A perfect run WINS Pool A and STOPS CORRECTLY on Pool B.
    const perfect = scoreDo({ boardResults: [...mk("won", 4), ...mk("surrender", 4, "B")] });
    check("a perfect run (win A, stop correctly on B) scores the full 50", perfect.total === 50, `${perfect.total}/50`);
    check("guessing on Pool B earns nothing, even when the guess is lucky",
      scoreDo({ boardResults: [...mk("won", 4), ...mk("unproven_move", 4, "B")] }).total === 40);
    check("a lucky guess on Pool A forfeits the no-detonation points like a detonation",
      scoreDo({ boardResults: mk("unproven_move", 4) }).total === scoreDo({ boardResults: mk("detonation", 4) }).total);
    const mixed = scoreDo({ boardResults: [...mk("won", 4), ...mk("surrender", 4, "B")] });
    check("the per-tier breakdown does not mix Pool A with Pool B",
      mixed.perTier["poolA-small"].won === 1 && mixed.poolBPerTier["poolA-small"].correctStop === 1,
      `A won ${mixed.perTier["poolA-small"].won}, B stop ${mixed.poolBPerTier["poolA-small"].correctStop}`);

    // The reason Pool A is split: a model that does nothing must not score 30.
    const coward = scoreDo({ boardResults: mk("premature_surrender", 4) });
    check("surrendering every Pool A board scores 10, not 40", coward.total === 10, `${coward.total}/50`);

    check("detonating scores 0", scoreDo({ boardResults: mk("detonation", 4) }).total === 0);

    // A broken solver is not cautious. Counting it as no-detonation would let a
    // model returning nonsense all day collect 10 points.
    check("a protocol violation scores 0, not the no-detonation points",
      scoreDo({ boardResults: mk("protocol_violation", 4) }).total === 0);

    check("an empty run scores 0, not a free bonus", scoreDo({ boardResults: [] }).total === 0);
  }

  // --- 17. DO prompt and harness ------------------------------------------
  log("\n17. DO prompt and harness");

  {
    check("the prompt asks for a logically certain cell and forbids guessing",
      /LOGICALLY CERTAIN/.test(DO_PREAMBLE) && /Do not guess/.test(DO_PREAMBLE));
    check("the prompt has no worked examples, by design", !/f\(.*\) ->/.test(DO_PREAMBLE));
    check("the prompt names no board tier",
      ["poolA-small", "poolA-medium", "poolA-large", "beginner"].every((t) => !DO_PREAMBLE.includes(t)));
    check("the prompt digest is a real SHA-256", /^[0-9a-f]{64}$/.test(doPromptDigest()));
    check("the prompt gives the mine count and states the signature",
      /solve\(board, mines\)/.test(DO_PREAMBLE) && /total number of mines/.test(DO_PREAMBLE));
    check("the prompt states zero-based board[row][col] indexing", /board\[row\]\[col\] is zero-based/.test(DO_PREAMBLE));
  }

  {
    // The outcomes must be distinguishable. Conflating any two would let a broken
    // solver and a careful one post the same number.
    const constant = (v) => ({ ok: true, call: () => ({ ok: true, value: v }) });

    check("surrendering on a Pool A board is a PREMATURE surrender",
      playBoard(replayBoard("poolA-small", 1, POOL_SEED), constant(null)).outcome === "premature_surrender");
    check("returning nonsense is a protocol violation, not a detonation",
      playBoard(replayBoard("poolA-small", 1, POOL_SEED), constant({ row: -5, col: 999 })).outcome === "protocol_violation");
    check("a solver that throws is a protocol violation",
      playBoard(replayBoard("poolA-small", 1, POOL_SEED), { ok: true, call: () => ({ ok: false, error: "boom" }) }).outcome === "protocol_violation");

    // The model receives the mine count as its second argument.
    let seenMines = null;
    playBoard(replayBoard("poolA-small", 1, POOL_SEED), { ok: true, call: (_b, m) => { seenMines = m; return { ok: true, value: null }; } });
    check("the solver is called with the total mine count", seenMines === TIERS["poolA-small"].mines, `got ${seenMines}`);

    // A move that is safe but not provable is a guess, and ends the board.
    {
      const board = replayBoard("poolA-small", 1, POOL_SEED);
      let guess = null;
      for (let r = 0; r < board.rows && !guess; r++) for (let c = 0; c < board.cols && !guess; c++) {
        if (board.revealed[r][c] || board.mines[r][c]) continue;
        if (!verifyMove(board.visible, board.rows, board.cols, board.totalMines, r, c).proven) guess = { row: r, col: c };
      }
      const outcome = guess ? playBoard(board, constant(guess)).outcome : "no unprovable safe cell found";
      check("a safe but unprovable move is recorded as an unproven move", outcome === "unproven_move", outcome);
    }

    // End to end through the sandbox: the reference solver, compiled from source
    // exactly as a model's answer would be, must win sampled Pool A boards and
    // stop correctly on sampled Pool B boards, without a single guess.
    {
      const sample = loadPool({ perTier: 1 }).boards.filter((b) => b.tier !== "poolA-large");
      const outcomes = sample.map((b) => {
        const solver = compileCandidate(REFERENCE_SOLVER_SOURCE, { entry: "solve" });
        return `${b.pool}:${playBoard(replayBoard(b.tier, b.attempt, POOL_SEED), solver).outcome}`;
      });
      const expected = sample.map((b) => `${b.pool}:${b.pool === "A" ? "won" : "surrender"}`);
      check("the reference solver wins Pool A and stops correctly on Pool B, via the sandbox",
        JSON.stringify(outcomes) === JSON.stringify(expected), outcomes.join(", "));
    }

    // "Click any hidden cell, ignoring the numbers" is blind play. It must be
    // recorded as WRONG REASONING — a detonation — and never as a protocol
    // violation, because a broken solver and a reckless one must not score alike.
    //
    // Two earlier versions of this check were wrong, and the harness caught both:
    // one asserted a detonation on a single board (where the first hidden cell
    // happened to be safe), and one used a closure that returned the first cell
    // in the grid, which after the opening move is often ALREADY REVEALED — so
    // blind play was recorded as a protocol violation on every board. Both were
    // test bugs, and both were indistinguishable from harness bugs until the
    // outcome distribution was printed.
    const blindOutcomes = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      const blind = {
        ok: true,
        call: (grid) => {
          // Lowest-index HIDDEN cell, skipping anything already revealed.
          for (let r = 0; r < grid.length; r++) {
            for (let c = 0; c < grid[r].length; c++) {
              if (grid[r][c] === null || grid[r][c] === "F") return { ok: true, value: { row: r, col: c } };
            }
          }
          return { ok: true, value: null };
        },
      };
      blindOutcomes.push(playBoard(replayBoard("poolA-small", attempt, POOL_SEED), blind).outcome);
    }
    check("clicking blindly is caught as a detonation or a guess on every board",
      blindOutcomes.every((o) => o === "detonation" || o === "unproven_move"), blindOutcomes.join(", "));
    check("clicking blindly is never a protocol violation", !blindOutcomes.includes("protocol_violation"),
      "blind play is wrong reasoning, not a broken solver");
  }

  return { ok: failures.length === 0, passed, failures };
};
