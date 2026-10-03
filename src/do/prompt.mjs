// MONKEY DO — prompt construction.
//
// INTEGRITY, mirroring prompt.mjs in see/: this module builds what the model
// SEES and must never import the oracle or the pool internals. The model is told
// the rules of Minesweeper; it is never shown which boards it will be scored on,
// nor any hint about which answers are provable.
//
// Unlike SEE there are no worked examples, and that is deliberate. A prompt with
// examples would measure pattern-matching on top of deduction, blurring exactly
// the line MONKEY DO exists to draw. The rules are stated in full instead.
//
// The digest is recorded in every report for the same reason as in SEE: two
// scores are only comparable if every model saw byte-identical text.

import { createHash } from "node:crypto";

/**
 * The fixed preamble, byte-identical for every run and every model.
 * Line breaks here are load-bearing: changing one changes the digest.
 *
 * Changes from the first version, all closing a gap between what the model
 * was told and what it was scored against:
 *
 *   - The model now receives the TOTAL MINE COUNT as a second argument. The
 *     oracle that certifies Pool A has always used it (Rule 5),
 *     so without it 5 of 60 Pool A boards could not be won from the model's
 *     side, and "premature surrender" was judged with information the model
 *     never had. Real Minesweeper displays the count; so does this prompt.
 *   - Indexing is stated: board[row][col], zero-based. The old prompt never said,
 *     so a model returning 1-based coordinates was scored as a broken solver.
 *   - (Suite 0.3.0) The verdict protocol: a second function, verdict, is asked
 *     for alongside solve. It is scored on Pool B boards, where no safe move
 *     is provable and the honest answers are assertions with proof, or an
 *     explicit CANNOT_TELL. A missing verdict is NOT fatal — a submission
 *     that defines only solve is scored on everything else — but a verdict
 *     that asserts without proof scores like a detonation on that board.
 */
export const PREAMBLE = [
  "You are a Minesweeper solver. You will be given the current visible board and",
  "the total number of mines on it.",
  "",
  "Rules:",
  "- board[row][col] is zero-based. Each cell is a number 0-8 (revealed), null",
  "  (unrevealed), or 'F' (flagged). Flags are annotations only and prove nothing.",
  "- A revealed number N means exactly N of its unrevealed neighbours are mines.",
  "- Neighbours are the up to 8 surrounding cells.",
  "- mines is the total number of mines on the board. Every mine is unrevealed.",
  "- Fractions are not possible. If no unrevealed cells remain, return null.",
  "",
  "Write TWO JavaScript functions:",
  "",
  "  solve(board, mines) -> { row, col } | null",
  "",
  "It must return a cell that is LOGICALLY CERTAIN to be safe, derived from the",
  "numbers and the mine count. If no cell can be proven safe, return null.",
  "Do not guess.",
  "",
  "  verdict(position, claims, mines)",
  "    -> { [claimId]: \"PROVEN_TRUE\" | \"PROVEN_FALSE\" | \"CANNOT_TELL\" }",
  "",
  "position is the visible board in the same shape as solve's board argument",
  "(it may arrive as either the bare grid or an object { grid, rows, cols });",
  "claims is an array of { id, row, col }; mines is the total mine count.",
  "For each claim, decide what the position PROVES about that cell:",
  "",
  "- PROVEN_TRUE      the cell provably holds a mine: a mine in every completion",
  "                   consistent with the visible numbers and the mine count.",
  "- PROVEN_FALSE     the cell is provably safe: a mine in no such completion.",
  "- CANNOT_TELL      the position does not decide it: both completions exist.",
  "",
  "Never assert PROVEN_TRUE or PROVEN_FALSE without the position actually",
  "proving it: an assertion the position does not support is scored like a",
  "clicked mine. CANNOT_TELL is always sound to answer; you are also scored on",
  "asserting every claim the position does decide, so abstain only when the",
  "claim is genuinely undecidable.",
  "",
  "Output only the code, no explanation.",
].join("\n");

/** SHA-256 of the exact prompt text, hex encoded. */
export const hashPrompt = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The prompt, and its digest. Identical on every call — the model is called once. */
export const buildPrompt = () => PREAMBLE;
export const promptDigest = () => hashPrompt(PREAMBLE);
export const allPromptDigests = () => [{ taskId: "DO", digest: promptDigest(), prompt: PREAMBLE }];
