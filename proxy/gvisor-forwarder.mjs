/**
 * Turns gVisor process evidence from a sandbox into RayTrace execution rows,
 * so a sandboxed Codex session gets a real per-tool-call verdict instead of
 * every call defaulting to `not_executed`.
 *
 * Why this exists: in sandbox mode (`npm run sandbox:*`, see
 * worker/gvisor/README.md) neither of the existing execution witnesses can
 * run. The rollout tailer (proxy/execution-tailer.mjs) needs Codex's rollout
 * log, which lives in a memory-backed CODEX_HOME inside the sandbox that the
 * Mac cannot read; and the bpftrace sidecar (proxy/container-tracer.mjs)
 * only knows how to *confirm* rows the tailer already wrote. What the
 * sandbox does have is gVisor's SecCheck stream: every successful exec and
 * every process exit, reported by the layer that actually mediated the
 * syscall, collected outside the workload into a SQLite file and served on
 * the evidence viewer (:8798). This module tails that viewer and makes gVisor
 * the *primary* witness for sandbox sessions -- rows are written with
 * `source: 'gvisor'` and `kernel_confirmed = 1` at insert time.
 *
 * Correctness stance is the same as execution-correlation.mjs: a missed
 * match only leaves a call `not_executed`; a wrong match mislabels real
 * data. Three things keep this conservative:
 *   1. Candidates are scoped to the sandbox's own session id (the rtp- id
 *      the broker stamps on every exchange), never the whole database.
 *   2. Only *top-level* execs are matched. Codex runs each tool call as
 *      `/bin/bash -lc <cmd>`; that bash then forks `git`, `ls`, `node`...
 *      Children of an already-matched command are skipped, and so is a
 *      re-exec in the same pid (bash exec()ing its last command in place),
 *      so a child's argv can never claim a *different* pending call.
 *   3. Events are processed one at a time, in event-id order, so a parent
 *      always claims its candidate before its children are even considered.
 *
 * Outcome is recorded in two steps because gVisor reports them in two
 * events: `exec_succeeded` writes the row with status 'running', and the
 * matching `process_exit` closes it out with the real exit code. Until the
 * exit arrives the UI keeps showing its text heuristic for that call rather
 * than asserting success or failure it doesn't have yet.
 */

export const SANDBOX_ID = /^rtp-[a-f0-9]{32}$/;
export const CONTAINER_ID = /^[a-f0-9]{64}$/;

/** ns-since-epoch (as the collector's string) -> ms, or null if unparseable. */
export function msFromNs(ns) {
  if (ns == null || ns === '') return null;
  try {
    const value = Number(BigInt(String(ns)) / 1_000_000n);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

/** One collector `exec_succeeded` event -> the shape matchBatch() consumes,
 * or null if it isn't one (other kinds, empty argv, no usable timestamp).
 * The id is the collector's own autoincrement event id, prefixed so it can
 * never collide with Codex's exec-<uuid> / call_id-reused ids and so
 * re-ingesting the same event twice stays a no-op (recordExecution is
 * INSERT OR REPLACE on id). */
export function toExecutionEvent(event) {
  if (!event || event.kind !== 'exec_succeeded') return null;
  const argv = Array.isArray(event.argv) ? event.argv.filter((part) => typeof part === 'string') : [];
  const command = argv.join(' ').trim();
  const timestamp = msFromNs(event.timestamp_ns);
  const pid = Number(event.pid);
  const eventId = Number(event.event_id);
  if (!command || timestamp == null || !Number.isFinite(pid) || !Number.isFinite(eventId)) return null;
  const container = typeof event.container_id === 'string' ? event.container_id.slice(0, 12) : 'unknown';
  return {
    id: `gvisor-${container}-${eventId}`,
    pid,
    ppid: Number.isFinite(Number(event.ppid)) ? Number(event.ppid) : null,
    command,
    cwd: typeof event.cwd === 'string' ? event.cwd : null,
    timestamp,
  };
}

/** One collector `process_exit` event -> the status/error to close the row
 * with. Never guesses: an exit we can't read is 'unknown', not 'completed'. */
export function exitOutcome(event) {
  if (typeof event?.signal === 'number' && event.signal > 0) return { status: 'failed', error: `killed by signal ${event.signal}` };
  if (typeof event?.exit_code === 'number') {
    return event.exit_code === 0 ? { status: 'completed', error: null } : { status: 'failed', error: `exit ${event.exit_code}` };
  }
  return { status: 'unknown', error: null };
}

/** Per-sandbox tailing state: how far into the collector's event ids we've
 * read, and which pids currently belong to a matched, still-running command
 * (so their children and same-pid re-execs are skipped, and their exit can
 * be routed back to the right row). */
export class SandboxTracker {
  constructor() { this.cursor = 0; this.live = new Map(); }
}

/**
 * Feeds a page of collector events (any order) through the matcher. Pure
 * apart from the injected `ingest`/`finish`, so it's unit-testable without
 * a proxy, a viewer, or a database.
 *
 * @param {Array<object>} events - raw viewer events for ONE container
 * @param {object} deps
 * @param {string} deps.sessionId - the sandbox's rtp- id, used to scope candidates
 * @param {SandboxTracker} deps.tracker
 * @param {(events: Array, opts: {sessionId: string}) => Promise<Map<string, object>>|Map<string, object>} deps.ingest
 *   - resolves executions to call_ids and records them; returns exec id -> match for the ones that matched
 * @param {(row: {id: string, ended_at: string|null, status: string, error: string|null}) => Promise<boolean>|boolean} deps.finish
 * @returns {Promise<{forwarded: number, matched: number, finished: number}>}
 */
export async function processEvents(events, { sessionId, tracker, ingest, finish }) {
  const counts = { forwarded: 0, matched: 0, finished: 0 };
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isFinite(Number(event?.event_id)) && Number(event.event_id) > tracker.cursor)
    .sort((a, b) => Number(a.event_id) - Number(b.event_id));

  for (const event of ordered) {
    tracker.cursor = Number(event.event_id);
    if (event.kind === 'exec_succeeded') {
      const exec = toExecutionEvent(event);
      if (!exec) continue;
      // Same pid already carrying a matched command (bash exec()ing its last
      // command in place) or a child of one: belongs to that command, never
      // a candidate for a different call.
      if (tracker.live.has(exec.pid) || (exec.ppid != null && tracker.live.has(exec.ppid))) continue;
      counts.forwarded += 1;
      const matches = await ingest([exec], { sessionId });
      if (matches && matches.get && matches.get(exec.id)) {
        counts.matched += 1;
        tracker.live.set(exec.pid, exec.id);
      }
    } else if (event.kind === 'process_exit') {
      const pid = Number(event.pid);
      const id = tracker.live.get(pid);
      if (!id) continue;
      tracker.live.delete(pid);
      const endedMs = msFromNs(event.timestamp_ns);
      const { status, error } = exitOutcome(event);
      await finish({ id, ended_at: endedMs == null ? null : new Date(endedMs).toISOString(), status, error });
      counts.finished += 1;
    }
  }
  return counts;
}

/**
 * Discovers sandboxes from the Mac-side manager (:8799, `/api/projects`
 * maps each rtp- id to its container id), tails each container's events
 * from the evidence viewer (:8798), and runs them through processEvents().
 * Best-effort throughout: the manager or viewer being down just means no
 * gVisor evidence for now -- logged once per outage, never fatal to the
 * proxy, never a wrong row.
 */
export function startGvisorForwarder({
  managerBase = 'http://127.0.0.1:8799',
  viewerBase = 'http://127.0.0.1:8798',
  ingest,
  finish,
  log = (message) => console.error(message),
  fetchImpl = globalThis.fetch,
  pollMs = 1500,
  discoverMs = 10_000,
  // First discovery is deferred a little so a proxy that starts with no
  // manager running prints its "listening" line before, not interleaved
  // with, the one-time "sandbox manager not reachable" notice.
  initialDelayMs = 2000,
} = {}) {
  if (typeof ingest !== 'function' || typeof finish !== 'function') throw new TypeError('startGvisorForwarder needs ingest() and finish()');
  const sandboxes = new Map(); // container_id -> { sessionId, tracker }
  let managerDown = false;
  let viewerDown = false;
  let discovering = null; // in-flight promise, so a concurrent call awaits it instead of racing
  let polling = null;
  let stopped = false;

  const getJson = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return res.json();
  };

  const discover = () => {
    if (stopped) return Promise.resolve();
    if (discovering) return discovering;
    discovering = discoverOnce().finally(() => { discovering = null; });
    return discovering;
  };
  const discoverOnce = async () => {
    try {
      const projects = await getJson(`${managerBase}/api/projects`);
      for (const project of Array.isArray(projects) ? projects : []) {
        const sessionId = project?.id;
        const containerId = project?.container_id;
        if (!SANDBOX_ID.test(sessionId || '') || !CONTAINER_ID.test(containerId || '')) continue;
        if (!sandboxes.has(containerId)) {
          sandboxes.set(containerId, { sessionId, tracker: new SandboxTracker() });
          log(`[raytace][gvisor] forwarding evidence for sandbox ${sessionId} (container ${containerId.slice(0, 12)})`);
        }
      }
      if (managerDown) { managerDown = false; log('[raytace][gvisor] sandbox manager reachable again'); }
    } catch (error) {
      if (!managerDown) {
        managerDown = true;
        log(`[raytace][gvisor] sandbox manager not reachable at ${managerBase} (${error.message}) -- gVisor evidence forwarding idle until it is. Start it with: npm run sandbox:manager`);
      }
    }
  };

  const poll = () => {
    if (stopped || !sandboxes.size) return Promise.resolve();
    if (polling) return polling;
    polling = pollOnce().finally(() => { polling = null; });
    return polling;
  };
  const pollOnce = async () => {
    for (const [containerId, { sessionId, tracker }] of sandboxes) {
      const url = `${viewerBase}/events?container=${containerId}&after=${tracker.cursor}&limit=500&processes=1`;
      let page;
      try { page = await getJson(url); } catch (error) {
        if (!viewerDown) { viewerDown = true; log(`[raytace][gvisor] evidence viewer not reachable at ${viewerBase} (${error.message}) -- is the raytace-gvisor VM running?`); }
        continue;
      }
      if (viewerDown) { viewerDown = false; log('[raytace][gvisor] evidence viewer reachable again'); }
      // An ingest/finish failure (e.g. a DB error) must not stall the loop
      // or leave the cursor wedged; log it and move on to the next poll.
      try {
        const counts = await processEvents(page?.events, { sessionId, tracker, ingest, finish });
        if (counts.matched || counts.finished) log(`[raytace][gvisor] ${sessionId.slice(0, 12)}: ${counts.matched} exec(s) matched to proposed calls, ${counts.finished} closed out, ${counts.forwarded} top-level exec(s) considered`);
      } catch (error) {
        log(`[raytace][gvisor] ${sessionId.slice(0, 12)}: failed to record evidence: ${error.message}`);
      }
    }
  };

  const firstDiscover = setTimeout(discover, initialDelayMs);
  const discoverTimer = setInterval(discover, discoverMs);
  const pollTimer = setInterval(poll, pollMs);
  firstDiscover.unref?.(); discoverTimer.unref?.(); pollTimer.unref?.();

  return {
    stop() { stopped = true; clearTimeout(firstDiscover); clearInterval(discoverTimer); clearInterval(pollTimer); },
    /** Test/inspection hook: the sandboxes currently being tailed. */
    sandboxes,
    discover,
    poll,
  };
}
