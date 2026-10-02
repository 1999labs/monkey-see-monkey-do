// Sandbox for executing model-written JavaScript.
//
// SCOPE OF THE THREAT MODEL — read this before reusing this elsewhere.
// `node:vm` is NOT a security boundary. It isolates the *global object*, not
// the process. In a self-hosted evaluation, where the only person running the
// code is the person who chose to run it, that is sufficient and the timeout
// is the part that actually matters. If you ever serve this to strangers on
// shared infrastructure, `node:vm` is not enough and you need real container
// isolation (gVisor, Firecracker, nsjail). The requirements are listed below.
//
// What this DOES guarantee:
//   - an infinite loop is interrupted (per-call timeout)
//   - a thrown error is a failed case, never a harness crash
//   - the model gets a fresh global with no require/process/fetch
//   - no state leaks between candidates, ever; and none between calls in the
//     mode the caller asks for. `isolateCalls: true` (SEE) re-runs the defining
//     script in a FRESH realm for every call, so a submission that mutates
//     globals or keeps a closure counter starts from zero on every case. The
//     default shares one context per compile, which DO bounds by recompiling
//     per board: state can never cross a board, and a solver's statefulness
//     WITHIN one board is its own to own.
//
//     Why isolation is opt-in and not universal: a fresh realm per call at DO
//     scale (~60,000 calls per run) was measured to balloon the heap past
//     1 GB per 7,600 calls and stretch the worst call from 48ms to 440ms, until
//     a major GC pause landed inside one call's 1000ms budget and scored a
//     sound solver as a protocol violation. SEE pays ~500 realms per run and
//     is unaffected; DO is not given the choice.
//
// What this does NOT guarantee:
//   - memory bounds (a huge allocation will exhaust the host; vm has no cap)
//   - cross-task isolation (same process, same event loop)

import vm from "node:vm";

export const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Strip markdown code fences. Models wrap answers in ```javascript ... ```
 * with near-total reliability, and with varying indentation.
 */
export const stripFences = (raw) => {
  let code = String(raw).trim();
  // A well-formed fenced block, optionally indented.
  const closed = code.match(/^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  if (closed) return closed[1].trim();
  // An UNTERMINATED fence is common when a model hits a length limit. Keep
  // the body: dropping it would turn a usable answer into an empty one.
  if (/^```[a-zA-Z]*[ \t]*\r?\n/.test(code)) {
    return code.replace(/^```[a-zA-Z]*[ \t]*\r?\n/, "").trim();
  }
  return code;
};

/**
 * Pull the code out of a whole response.
 *
 * The prompt says "output only the code", but models routinely wrap the block
 * in a sentence ("Here is the function:") or a trailing explanation, and
 * reasoning models prepend a <think> block. stripFences alone handles only a
 * response that IS a fenced block, so those answers compiled as prose and
 * scored zero — measuring formatting, not reasoning.
 *
 * Rules, in order: drop <think>...</think>; if there are complete fenced
 * blocks, take the first one that mentions the entry name (else the first);
 * otherwise fall back to stripFences, which handles an unterminated fence and
 * bare code.
 */
export const extractCode = (raw, entry = "f") => {
  const text = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const blocks = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (blocks.length) {
    const named = new RegExp(`\\b${entry}\\b`);
    return blocks.find((b) => named.test(b)) ?? blocks[0];
  }
  return stripFences(text);
};

/**
 * Remove module syntax the model emitted but the sandbox cannot provide.
 * Returns { code, removed } so callers can report what was stripped.
 */
export const stripModuleSyntax = (code) => {
  const removed = [];
  const stripped = code
    .split("\n")
    .map((line) => {
      const t = line.trim();
      // Drop whole lines that are only module plumbing.
      if (/^import\b/.test(t) || /^(const|let|var)\s+\w+\s*=\s*require\s*\(/.test(t)) {
        removed.push(t);
        return "";
      }
      return line;
    })
    .join("\n")
    // Strip the `export`/`export default` KEYWORD only, preserving the
    // declaration that follows it. Deleting the whole line would throw away
    // the function we came for.
    .replace(/^(\s*)export\s+default\s+/gm, "$1")
    .replace(/^(\s*)export\s+/gm, "$1");
  return { code: stripped, removed };
};

// Names a model is likely to give the function. The eval's own name (`f` for
// SEE, `solve` for DO) is always probed FIRST — see compileCandidate.
const CANDIDATE_NAMES = ["f", "solve", "fn", "solution", "answer", "transform"];

// Each name is probed inside its own try: a `const` whose initialiser never ran
// (because earlier top-level code threw) is in its temporal dead zone, and even
// `typeof` on it throws.
const buildProbe = (names) => `
__fn = null;
${names.map((n) => `if (__fn === null) { try { if (typeof ${n} === "function") __fn = ${n}; } catch (e) {} }`).join("\n")}
if (__fn === null) { try { if (typeof module !== "undefined" && module && typeof module.exports === "function") __fn = module.exports; } catch (e) {} }
`;

// A console that swallows everything, built INSIDE the context so its methods
// belong to the sandbox realm. A host-realm object would hand candidate code a
// host Function constructor via console.log.constructor.
//
// Why not strip console.log lines? Because a no-op is
// strictly more robust: it also covers calls inside the function and calls
// split across lines, which a line-based strip misses. Before this, `console`
// was undefined, so a correct answer followed by `console.log(f(11))` — a very
// common model habit — was scored UNUSABLE, and a log inside the function made
// every single call throw.
const SILENT_CONSOLE = `globalThis.console = (function () {
  var noop = function () {};
  var c = {};
  ["log", "info", "warn", "error", "debug", "trace", "dir", "table", "group", "groupEnd", "time", "timeEnd", "assert"]
    .forEach(function (k) { c[k] = noop; });
  return c;
})();`;

// Precompiled once: it runs before every candidate call (fresh context per
// call), so it is a Script, not a string, at that point.
const SILENT_CONSOLE_SCRIPT = new vm.Script(SILENT_CONSOLE, { filename: "silent-console.js" });

/**
 * Compile model output into a callable, or report why it could not be.
 * Returns { ok: true, call } or { ok: false, error }.
 *
 * `entry` is the name the prompt asked for, and it is probed first. The order
 * matters: a DO answer that defines a top-level helper called `f` alongside
 * `solve` used to have the HELPER called, because `f` was always probed first.
 *
 * `isolateCalls` (SEE only): every call gets a fresh realm, so no state can
 * cross between the cases one compiled candidate answers. See the header for
 * why DO must not use it.
 *
 * Top-level code that throws or times out after the function is defined (demo
 * calls such as `console.log(f())`) does not void the answer: the probe runs as
 * a separate script, so hoisted and already-initialised functions are still
 * found. The throw is reported in `topLevelError`, never scored.
 */
export const compileCandidate = (rawCode, { timeoutMs = DEFAULT_TIMEOUT_MS, entry = "f", isolateCalls = false } = {}) => {
  const withoutFences = extractCode(rawCode, entry);
  if (!withoutFences) return { ok: false, error: "empty response" };

  const { code, removed } = stripModuleSyntax(withoutFences);
  const names = [entry, ...CANDIDATE_NAMES.filter((n) => n !== entry)];

  // A bare expression, e.g. `(n) => n * n` with no assignment. Tried second.
  const attempts = [
    { label: "named function", body: code, probe: buildProbe(names) },
    { label: "bare expression", body: `__fn = (${code}\n);`, probe: null },
  ];

  const firstErrors = [];
  for (const attempt of attempts) {
    const sandbox = {};
    const context = vm.createContext(sandbox, { name: "monkey-see-candidate" });
    SILENT_CONSOLE_SCRIPT.runInContext(context);
    let script;
    try {
      script = new vm.Script(attempt.body, { filename: "candidate.js" });
    } catch (err) {
      firstErrors.push(`${attempt.label}: ${err.message}`);
      continue;
    }
    let topLevelError = null;
    try {
      script.runInContext(context, { timeout: timeoutMs });
    } catch (err) {
      topLevelError = String(err && err.message);
      if (!attempt.probe) {
        firstErrors.push(`${attempt.label}: ${topLevelError}`);
        continue;
      }
    }
    if (attempt.probe) {
      try {
        vm.runInContext(attempt.probe, context, { timeout: timeoutMs });
      } catch (err) {
        firstErrors.push(`${attempt.label}: ${String(err && err.message)}`);
        continue;
      }
    }
    if (typeof sandbox.__fn === "function") {
      return {
        ok: true,
        // In the isolated mode the CALLER gets the SCRIPT objects, not a live
        // context: every call rebuilds the candidate in a fresh realm. In the
        // shared mode it gets the compiled context, bounded by DO's per-board
        // recompile.
        call: isolateCalls
          ? makeIsolatedCaller({ script, probe: attempt.probe }, timeoutMs)
          : makeSharedCaller(sandbox, context, timeoutMs),
        removed,
        label: attempt.label,
        topLevelError,
      };
    }
    firstErrors.push(`${attempt.label}: ${topLevelError ?? "no callable found"}`);
  }

  return { ok: false, error: firstErrors.join(" | ") || "could not compile", removed };
};

// vm surfaces a timeout as a generic Error with this exact message.
const isVmTimeout = (err) => Boolean(err && /Script execution timed out/i.test(err.message));

/**
 * One context shared by every call of this compile (the default). Cheap, and
 * correct wherever the CALLER bounds the lifetime: DO recompiles per board, so
 * nothing can cross a board. The arguments are inlined as JSON in a fresh
 * script so the timeout applies to the call itself, and so a candidate that
 * mutates its arguments cannot corrupt the host's task data.
 */
const makeSharedCaller = (sandbox, context, timeoutMs) => {
  return (...args) => {
    const literals = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(", ");
    const script = new vm.Script(`__out = __fn(${literals});`, { filename: "call.js" });
    sandbox.__out = undefined;
    try {
      script.runInContext(context, { timeout: timeoutMs });
    } catch (err) {
      if (isVmTimeout(err)) return { ok: false, timedOut: true, error: `timed out after ${timeoutMs}ms` };
      return { ok: false, timedOut: false, error: String(err && err.message) };
    }
    return { ok: true, value: sandbox.__out };
  };
};

/**
 * A FRESH REALM PER CALL: SEE's mode, where one compiled candidate answers
 * ~174 independent cases and the sandbox's own header used to promise no state
 * between calls while one context quietly leaked globals and closure counters
 * from case to case.
 *
 * The defining script is re-run in a brand-new realm first, so a submission
 * that mutates globals, keeps a closure counter, or caches on the function
 * object starts from zero on every case. A top-level throw is handled exactly
 * as at compile time: recorded, not scored, and the probe still runs — a
 * function defined before the throw remains callable.
 */
const makeIsolatedCaller = ({ script, probe }, timeoutMs) => {
  const probeScript = probe ? new vm.Script(probe, { filename: "probe.js" }) : null;
  return (...args) => {
    const literals = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(", ");
    const callScript = new vm.Script(`__out = __fn(${literals});`, { filename: "call.js" });

    const sandbox = {};
    const context = vm.createContext(sandbox, { name: "monkey-see-candidate" });
    SILENT_CONSOLE_SCRIPT.runInContext(context);

    let topLevelError = null;
    try {
      script.runInContext(context, { timeout: timeoutMs });
    } catch (err) {
      topLevelError = String(err && err.message);
      // A bare-expression body assigns __fn directly; if even that threw, there
      // is nothing to fall back to. At compile time such an attempt was
      // rejected, so reaching here means the body throws only sometimes — a
      // failed case, not a harness error.
      if (!probeScript) return { ok: false, timedOut: isVmTimeout(err), error: topLevelError };
    }
    if (probeScript) {
      try {
        probeScript.runInContext(context, { timeout: timeoutMs });
      } catch (err) {
        return { ok: false, timedOut: isVmTimeout(err), error: String(err && err.message) };
      }
    }
    if (typeof sandbox.__fn !== "function") {
      return { ok: false, timedOut: false, error: topLevelError ?? "no callable found" };
    }

    sandbox.__out = undefined;
    try {
      callScript.runInContext(context, { timeout: timeoutMs });
    } catch (err) {
      if (isVmTimeout(err)) return { ok: false, timedOut: true, error: `timed out after ${timeoutMs}ms` };
      return { ok: false, timedOut: false, error: String(err && err.message) };
    }
    return { ok: true, value: sandbox.__out };
  };
};

/**
 * Run one candidate. Never throws — a failure is data.
 * Extra arguments are passed through, so DO can call solve(board, mines).
 */
export const runCandidate = (compiled, ...args) => {
  if (!compiled.ok) return { ok: false, timedOut: false, error: compiled.error };
  return compiled.call(...args);
};
