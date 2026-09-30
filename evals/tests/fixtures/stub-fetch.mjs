// A stand-in for the network, loaded with `node --import` by the CLI tests.
//
// Every request is answered with a CORRECT solution for whichever prompt was
// sent, in whichever wire format the endpoint expects (OpenAI-compatible or
// Ollama). A harness that is wired correctly must therefore score 100/100.
//
// Each request body is appended to $STUB_FETCH_LOG (if set), so a test can
// check what was actually sent — temperature, seed, messages.

import { appendFileSync } from "node:fs";

import { REFERENCE_SOLVER_SOURCE } from "../../src/do/reference-solver.mjs";

const ANSWERS = {
  "f(n)": "```javascript\nfunction f(n) { return n <= 10 ? n * n : n * n - 100; }\n```",
  "f(s)": `function f(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  if ("aeiou".includes(s[0].toLowerCase())) return s;
  return s[0].toUpperCase() + s.slice(1);
}`,
  "f(arr)": `Here you go:

\`\`\`js
function f(arr) {
  const d = [...new Set(arr)];
  if (d.length < 2) return null;
  d.sort((a, b) => b - a);
  return d[1];
}
console.log(f([1, 2, 3]));
\`\`\``,
};

// A model whose id contains "weak" answers like a mimic: naive SEE rules and a
// DO solver that clicks the first hidden cell. Used by the acceptance-gate test.
const WEAK = {
  "f(n)": "function f(n) { return n * n; }",
  "f(s)": "function f(s) { return s.charAt(0).toUpperCase() + s.slice(1); }",
  "f(arr)": "function f(arr) { return arr.slice().sort((a, b) => b - a)[arr.length - 2]; }",
  DO: "function solve(board) { for (let r = 0; r < board.length; r++) for (let c = 0; c < board[r].length; c++) if (board[r][c] === null) return { row: r, col: c }; return null; }",
};

const answerFor = (prompt, model = "") => {
  const weak = /weak/.test(model);
  if (prompt.includes("Minesweeper")) return weak ? WEAK.DO : REFERENCE_SOLVER_SOURCE;
  if (weak) {
    for (const hint of Object.keys(ANSWERS)) {
      if (prompt.includes(`argument: ${hint}`) || prompt.includes(`integers: ${hint}`)) return WEAK[hint];
    }
  }
  for (const [hint, answer] of Object.entries(ANSWERS)) {
    if (prompt.includes(`argument: ${hint}`) || prompt.includes(`integers: ${hint}`)) return answer;
  }
  return "I do not know.";
};

globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body ?? "{}");
  if (process.env.STUB_FETCH_LOG) appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ url, body }) + "\n");
  const text = answerFor(body.messages?.[0]?.content ?? "", body.model);
  const payload = String(url).includes("/api/chat")
    ? { model: body.model, message: { role: "assistant", content: text }, done: true, done_reason: "stop" }
    : { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
};
