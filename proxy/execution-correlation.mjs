/**
 * Correlates a command the sandbox actually ran (a gVisor exec) to the
 * model's proposed tool call it fulfilled (an agent_tool_calls row captured
 * from the response payload).
 *
 * Why this is needed at all: the process carries no call id -- the model's
 * `call_id` never reaches the program Codex spawns -- so there is no shared
 * key to join on. This module bridges them by content (does the executed
 * command text match what the model proposed?) inside each call's causal
 * window and, for ties, by chronological order.
 *
 * Correctness stance: a wrong "not correlated" is harmless (falls back to
 * today's `not_executed` default). A wrong *positive* match — attributing a
 * real execution to the wrong proposed call — is the failure mode to avoid,
 * so matching only commits above a real similarity bar; ambiguous or weak
 * cases return no match rather than guessing.
 */

/** Recursively flatten any JSON value's string content into one lowercase
 * string, so matching survives whatever shape a tool's arguments happen to
 * be in ({command: "..."} vs {cmd: "..."} vs a bare string, etc). */
export function flattenText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.toLowerCase();
  if (Array.isArray(value)) return value.map(flattenText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(flattenText).join(' ');
  return String(value).toLowerCase();
}

/** Longest common substring length between two strings — cheap, and unlike
 * a token-set/Jaccard measure it rewards exact shared command text (which is
 * the common case: Codex runs precisely what the model proposed) over
 * coincidental word overlap. */
function longestCommonSubstringLength(a, b) {
  if (!a || !b) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let best = 0;
  // Cap work on pathological inputs (huge stdout dumps embedded in args)
  // rather than letting one bad row hang the batch.
  const shortCapped = short.slice(0, 4000);
  const longCapped = long.slice(0, 20000);
  for (let i = 0; i < shortCapped.length; i++) {
    for (let j = i + 1; j <= shortCapped.length; j++) {
      const piece = shortCapped.slice(i, j);
      if (piece.length <= best) continue;
      if (longCapped.includes(piece)) best = piece.length;
      else break; // longer pieces starting at i won't match either
    }
  }
  return best;
}

// Codex wraps every command in its own shell invocation before running it
// (e.g. "/bin/zsh -lc <what the model actually asked for>") — that wrapper
// text never appears in the model's proposed arguments, so it must be
// stripped before comparing, or it dilutes even an exact match's score.
const SHELL_WRAPPER_PREFIX = /^\/bin\/(?:zsh|bash|sh)\s+-[a-z]+\s+/i;

/** Similarity in [0, 1], normalized against the EXECUTED command's own
 * length (after stripping Codex's shell wrapper) rather than whichever side
 * happens to be shorter. This is intentionally asymmetric: the model's
 * proposed arguments may legitimately carry extra fields (a working
 * directory, a timeout, a justification string) that have nothing to do
 * with the command text itself and should not be allowed to drag the score
 * down just because they make the candidate's flattened text longer. 1.0
 * means the full executed command text appears verbatim inside whatever the
 * model proposed. */
export function similarity(executedCommand, candidateArgs) {
  const command = String(executedCommand ?? '').toLowerCase().replace(SHELL_WRAPPER_PREFIX, '');
  const candidateText = flattenText(candidateArgs);
  if (!command || !candidateText) return 0;
  return longestCommonSubstringLength(command, candidateText) / command.length;
}

const MATCH_THRESHOLD = 0.6; // below this, treat as "no confident match"
const DEFAULT_WINDOW_MS = 30_000; // how far a candidate's timestamp may drift from the execution's
// A causal window with no result yet stays open this long. Past that, a call
// that never ran must stop competing for every later look-alike command.
export const OPEN_WINDOW_CAP_MS = 10 * 60_000;
const DEFAULT_MARGIN_MS = 2_000; // clock uncertainty when the caller has not measured it

/** Whether an execution could have fulfilled this candidate, by time alone.
 *
 * A candidate that carries `window_start` has a *causal* window: the call
 * cannot have run before the request that proposed it started, and it must
 * have started before the agent sent its result back (`window_end`, null
 * while no result has arrived). Those bounds come from the agent's own
 * traffic, so a slow command still matches however late it runs, and a
 * retried proposal cannot claim a run that happened before it existed.
 * `margin` absorbs the uncertainty between the proxy's clock and the
 * clock the execution was timestamped with.
 *
 * A candidate without one keeps a symmetric window around its timestamp. */
function inTimeWindow(candidate, exec, { windowMs, margin }) {
  if (!Number.isFinite(candidate.window_start)) return Math.abs(candidate.timestamp - exec.timestamp) <= windowMs;
  const end = Number.isFinite(candidate.window_end) ? candidate.window_end : candidate.window_start + OPEN_WINDOW_CAP_MS;
  return exec.timestamp >= candidate.window_start - margin && exec.timestamp <= end + margin;
}

/**
 * @param {{command: string, timestamp: number}} execEvent - parsed CommandExecution
 * @param {Array<{call_id: string, timestamp: number, args: unknown}>} candidates
 *   - tool_calls rows in the surrounding time window, each already excluding
 *     call_ids matched earlier in this same batch (caller's responsibility —
 *     see matchBatch below, which handles that for a whole batch at once).
 * @param {{windowMs?: number}} [options]
 * @returns {{call_id: string, score: number, basis: 'id'|'text'|'order'} | null}
 */
export function matchExecutionToCall(execEvent, candidates, { windowMs = DEFAULT_WINDOW_MS } = {}) {
  const margin = Number.isFinite(execEvent.margin) ? execEvent.margin : DEFAULT_MARGIN_MS;
  // Newer Codex builds run shell commands through a "unified_exec" path that
  // skips minting its own exec-<uuid> and just reuses the model's own
  // call_id as the CommandExecution's id directly. When that's the case
  // there's no ambiguity to resolve at all — call_id is the tool_calls
  // primary key, so a hit is correct no matter how much time passed between
  // the call being proposed and actually running (a queued or long-delayed
  // command shouldn't lose an otherwise-certain match just because it fell
  // outside the window sized for disambiguating *fuzzy* text matches).
  // Check the full candidate pool, unfiltered by the time window, first.
  const exact = candidates.find((c) => c.call_id === execEvent.id);
  if (exact) return { call_id: exact.call_id, score: 1, basis: 'id' };

  // No exact id available (older Codex exec-<uuid> path) — fall back to
  // content similarity, which DOES need a time window to stay safe: two
  // near-identical commands run close together could otherwise be
  // ambiguous, so this fallback only considers candidates that could have
  // produced this execution. Text is still required inside a causal window:
  // the agent runs its own helpers (git status, ...) while a call is pending.
  const inWindow = candidates.filter((c) => inTimeWindow(c, execEvent, { windowMs, margin }));
  if (!inWindow.length) return null;

  // Ties: the causal window that opened most recently, then the closest
  // timestamp. With causal windows a tie means two pending look-alike calls
  // whose windows both cover this run; the newer one is the one the agent
  // was acting on when it ran.
  // Candidates without one keep closest-timestamp alone.
  const newerWindow = (x, y) => Number.isFinite(x.window_start) && Number.isFinite(y.window_start) ? y.window_start - x.window_start : 0;
  const scored = inWindow
    .map((c) => ({ c, score: similarity(execEvent.command, c.args) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((x, y) => y.score - x.score
      || newerWindow(x.c, y.c)
      || Math.abs(x.c.timestamp - execEvent.timestamp) - Math.abs(y.c.timestamp - execEvent.timestamp));

  if (scored.length) {
    const best = scored[0];
    if (!Number.isFinite(best.c.window_start)) return { call_id: best.c.call_id, score: best.score, basis: 'text' };
    // The bounds that justified the match travel with it, so the row can
    // later show why this process was tied to this call.
    return { call_id: best.c.call_id, score: best.score, basis: 'window',
      window_start: best.c.window_start, window_end: Number.isFinite(best.c.window_end) ? best.c.window_end : null };
  }

  // No candidate's argument text matches well enough — this is deliberately
  // conservative. We do NOT fall back to "closest timestamp, any content" for
  // a single execution in isolation; that risks confidently mislabeling an
  // unrelated call. Pure order-based fallback is only safe *within* a batch
  // of genuinely tied (near-identical) candidates — see matchBatch.
  return null;
}

/**
 * Correlates a whole batch of parsed executions (chronological) against a
 * shared candidate pool, so identical/duplicate commands in the same window
 * pair up in the order they occurred rather than all claiming the same
 * "best" candidate. Each candidate is consumed at most once.
 *
 * @param {Array<{id: string, command: string, timestamp: number}>} execEvents - chronological
 * @param {Array<{call_id: string, timestamp: number, args: unknown}>} candidates
 * @returns {Map<string, {call_id: string, score: number, basis: string}>} exec id -> match
 */
export function matchBatch(execEvents, candidates, options = {}) {
  const remaining = [...candidates];
  const results = new Map();
  const sortedExecs = [...execEvents].sort((a, b) => a.timestamp - b.timestamp);

  for (const exec of sortedExecs) {
    const match = matchExecutionToCall(exec, remaining, options);
    if (!match) continue;
    results.set(exec.id, match);
    const claimedIndex = remaining.findIndex((c) => c.call_id === match.call_id);
    if (claimedIndex !== -1) remaining.splice(claimedIndex, 1);
  }
  return results;
}
