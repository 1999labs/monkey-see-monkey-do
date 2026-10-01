// Short, stable fingerprint of model output.
//
// Purpose: make reproducibility visible. If two runs of the same prompt
// produce the same fingerprint, the endpoint is deterministic and the scores
// are comparable. If they differ, the model invented a different function and
// no score from it can be compared to anything else — including itself.
//
// This is NOT a cryptographic hash. It is a cheap 32-bit rolling hash, sized
// for "did this change?" and nothing more. SHA-256 lives in prompt.mjs.

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
 * @param {Array<{taskId: string, response: string}>} entries
 * @returns {{ reproducible: boolean, perTask: object }}
 */
export const reproducibility = (entries) => {
  const byTask = {};
  for (const { taskId, response } of entries) {
    (byTask[taskId] ??= []).push(fingerprint(response));
  }
  const perTask = {};
  for (const [taskId, prints] of Object.entries(byTask)) {
    const distinct = new Set(prints);
    perTask[taskId] = { distinct: distinct.size, runs: prints.length, prints };
  }
  return {
    reproducible: Object.values(perTask).every((t) => t.distinct === 1),
    perTask,
  };
};
