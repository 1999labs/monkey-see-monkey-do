// Why a model call produced nothing, in terms a report reader can act on.
//
// Shared by both evals. The first version lived in the DO runner alone, and SEE
// collapsed every failure to "timeout or provider_error": a SEE report could
// not tell quota exhaustion from a broken endpoint without parsing free text,
// and the two evals used different vocabularies for the same event.
//
// The adapters set `timedOut: true`, `timeoutMs` and (on the final throw)
// `attempts` on the errors they raise precisely so this classification does
// not have to guess from message text. A timeout is a fact about OUR budget;
// everything else is a fact about the route. Neither is a fact about the model,
// which is the whole point of recording it beside a zero.
//
// An EMPTY response is deliberately absent from this taxonomy. The adapters
// RETURN an empty completion rather than throwing, so it never reaches here: it
// is a real (scored) answer of zero length, lands as a compile error and
// protocol_violation boards, and is visible in the report as such. Any
// temptation to file it as a call failure would reclassify a scored answer as
// a route problem.

/**
 * The failure taxonomy:
 *   timeout            our budget ran out; describes the route, not the model
 *   non_json_response  the endpoint answered with something unparsable
 *   auth_failed        401/403
 *   rate_limited       429
 *   http_<status>      any other HTTP status
 *   network_error      could not connect at all
 *   provider_error     the endpoint refused in a way nothing above matches
 */
export const classifyCallFailure = (err) => {
  const message = String(err?.message ?? err ?? "");
  const status = err?.status;
  // The flag, the name and the code ONLY — never the message text. The first
  // version grepped for "abort" in the message, so a provider error whose body
  // happened to contain "aborted" classified as OUR timeout. Real aborts carry
  // the AbortError name (fetch) or the timedOut flag (the adapters), so the
  // message is never needed and never trusted.
  if (err?.timedOut || err?.name === "AbortError" || err?.code === "ABORT_ERR") {
    return "timeout";
  }
  if (/non-JSON/i.test(message)) return "non_json_response";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (typeof status === "number") return `http_${status}`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message)) return "network_error";
  return "provider_error";
};

/**
 * The full callFailure record both runners write.
 *
 * @param {Error} err what the adapter threw
 * @param {object} opts
 * @param {number} opts.startedAt  Date.now() when the call was made
 * @param {number|null} [opts.timeoutMs] the config budget, used only when the
 *   error does not carry its own (an error thrown before any timer was set,
 *   e.g. a missing key)
 */
export const describeCallFailure = (err, { startedAt = Date.now(), timeoutMs = null } = {}) => ({
  reason: classifyCallFailure(err),
  message: String(err?.message ?? err),
  elapsedMs: Date.now() - startedAt,
  // The budget that was actually in force: the error's own first, so a
  // per-model override is never misreported as the suite default.
  timeoutMs: err?.timeoutMs ?? timeoutMs ?? null,
  // Timeouts are never retried, so one wait is the cost of finding out.
  // Everything else carries the attempt count the adapter recorded on its
  // final throw, so three refused attempts are distinguishable from one.
  attempts: err?.timedOut ? 1 : (err?.attempts ?? null),
});
