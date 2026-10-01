// Short, stable fingerprint of model output.
//
// Purpose: make reproducibility visible. If two runs of the same prompt
// produce the same fingerprint, the endpoint is deterministic and the scores
// are comparable. If they differ, the model invented a different function and
// no score from it can be compared to anything else — including itself.
//
// This is NOT a cryptographic hash. It is a cheap 32-bit rolling hash, sized
// for "did this change?" and nothing more. SHA-256 lives in prompt.mjs.
//
// THE EMPTY RESPONSE IS A TRAP, and it is closed here rather than at every
// caller. fingerprint("") is the constant "00000000", so a run whose call
// failed records the same fingerprint as every other failed run, whatever the
// failure was. Counting those as evidence certified two timeouts as
// "identical code every run" and printed temperatureHonoured: true for a
// model that never answered. So callers mark entries `failed`, a failed entry
// is never fingerprinted, and a task with fewer than TWO answered runs gets no
// verdict at all: unknown is not stable, and it is not unstable either.

export const fingerprint = (text) => {
  let h = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/**
 * Summarise reproducibility across runs.
 *
 * @param {Array<{taskId: string, response: string, failed?: boolean}>} entries
 *   `failed: true` marks a run whose call never returned. Its (empty) response
 *   is not fingerprinted and is not evidence of anything.
 * @returns {{
 *   reproducible: boolean,
 *   verdict: "REPRODUCIBLE"|"NOT_REPRODUCIBLE"|null,
 *   perTask: Record<string, {distinct: number, runs: number, failedRuns: number, prints: string[]}>
 * }}
 *   verdict null means "no answered pair to compare": the honest answer when
 *   every run of a task failed, and one a report must show as UNKNOWN, not as
 *   reproducible or unstable.
 */
export const reproducibility = (entries) => {
  const byTask = {};
  for (const { taskId, response, failed = false } of entries) {
    (byTask[taskId] ??= []).push({ failed, print: failed ? null : fingerprint(response) });
  }
  const perTask = {};
  let anyPair = false;
  let allSame = true;
  for (const [taskId, list] of Object.entries(byTask)) {
    const answered = list.filter((e) => !e.failed);
    const distinct = new Set(answered.map((e) => e.print));
    const hasPair = answered.length >= 2;
    if (hasPair) {
      anyPair = true;
      if (distinct.size !== 1) allSame = false;
    }
    perTask[taskId] = {
      distinct: distinct.size,
      runs: answered.length,
      failedRuns: list.length - answered.length,
      prints: answered.map((e) => e.print),
    };
  }
  const verdict = anyPair ? (allSame ? "REPRODUCIBLE" : "NOT_REPRODUCIBLE") : null;
  return { reproducible: verdict === "REPRODUCIBLE", verdict, perTask };
};

/**
 * Verdict over a bare list of response fingerprints: DO's single-call case.
 *
 * The caller passes prints from ANSWERED runs only (a failed run's print is the
 * empty constant and would poison the verdict); fewer than two is no verdict.
 *
 * @param {string[]} prints
 * @returns {"REPRODUCIBLE"|"NOT_REPRODUCIBLE"|null}
 */
export const printVerdict = (prints) => {
  if (!Array.isArray(prints) || prints.length < 2) return null;
  return new Set(prints).size === 1 ? "REPRODUCIBLE" : "NOT_REPRODUCIBLE";
};
