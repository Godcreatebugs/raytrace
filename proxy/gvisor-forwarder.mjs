/**
 * Turns gVisor process evidence from a sandbox into RayTrace evidence rows
 * (runtime_processes, runtime_events, runtime_attributions; see
 * proxy/evidence-store.mjs), so a sandboxed Codex session gets a real
 * per-tool-call verdict instead of every call defaulting to `not_executed`.
 *
 * gVisor is the only execution witness: its SecCheck stream reports every
 * exec and every process exit from the layer that actually mediated the
 * syscall, collected outside the workload into a SQLite file in the VM and
 * served on the evidence viewer (:8798). This module tails that viewer.
 *
 * Correctness stance is the same as execution-correlation.mjs: a missed
 * match only leaves a call `not_executed`; a wrong match mislabels real
 * data. Three things keep this conservative:
 *   1. Candidates are scoped to the sandbox's own session id (the rtp- id
 *      the broker stamps on every exchange), never the whole database.
 *   2. Only *top-level* execs are matched. Codex runs each tool call as
 *      `/bin/bash -lc <cmd>`; that bash then forks `git`, `ls`, `node`...
 *      Children of an already-matched command inherit its call instead of
 *      being matched, and so does a re-exec in the same pid (bash exec()ing
 *      its last command in place), so a child's argv can never claim a
 *      *different* pending call.
 *   3. Events are processed one at a time, in event-id order, so a parent
 *      always claims its candidate before its children are even considered.
 *
 * Outcome arrives in two steps because gVisor reports it in two events:
 * `exec_succeeded` records the process, and its `process_exit` closes it
 * with the real exit code. Until the exit arrives the UI keeps showing its
 * text heuristic for that call rather than asserting an outcome it lacks.
 */

export const SANDBOX_ID = /^rtp-[a-f0-9]{32}$/;
export const CONTAINER_ID = /^[a-f0-9]{64}$/;

/** Mapping from the sandbox VM's clock to the proxy's. gVisor stamps events
 * with the VM's realtime clock; exchanges are stamped by the proxy on the
 * Mac. The two drift (notably after the Mac sleeps), so exec times are
 * shifted by a measured offset before they are compared with exchange
 * times, and `marginMs` is how uncertain that shift is. Unmeasured, the
 * offset is assumed zero with a margin wide enough for ordinary drift. */
export const UNMEASURED_CLOCK = Object.freeze({ offsetMs: 0, marginMs: 2000, measured: false });

/** Picks the clock mapping from recent `/time` samples, NTP style: the
 * sample with the shortest round trip has the least room for error. */
export function clockFromSamples(samples) {
  const usable = (samples ?? []).filter((s) => Number.isFinite(s?.offsetMs) && Number.isFinite(s?.rttMs) && s.rttMs >= 0);
  if (!usable.length) return UNMEASURED_CLOCK;
  const best = usable.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
  return { offsetMs: best.offsetMs, marginMs: best.rttMs / 2 + 250, measured: true };
}

/** `gvisor-<container12>-`: the id prefix every row from one sandbox shares,
 * which is how a pid (reused across sandboxes) is scoped back to its own. */
export const rowPrefix = (containerId) => `gvisor-${typeof containerId === 'string' && containerId ? containerId.slice(0, 12) : 'unknown'}-`;

/** ns-since-epoch (as the collector's string) -> ms, or null if unparseable. */
export function msFromNs(ns) {
  if (ns == null || ns === '') return null;
  try {
    const value = Number(BigInt(String(ns)) / 1_000_000n);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

/** The call id a command's own text exports, or null. */
export function commandMarker(command) {
  return /(?:^|[\s;])export RAYTRACE_CALL_ID=([A-Za-z0-9_-]{1,128})(?=[\s;]|$)/.exec(String(command ?? ''))?.[1] ?? null;
}

/** One collector `exec_succeeded` event -> the shape matchBatch() consumes,
 * or null if it isn't one (other kinds, empty argv, no usable timestamp).
 * The id is the collector's own autoincrement event id, prefixed so it can
 * never collide with Codex's exec-<uuid> / call_id-reused ids and so
 * re-ingesting the same event twice stays a no-op (recordExecution is
 * INSERT OR REPLACE on id). */
export function toExecutionEvent(event, clock = UNMEASURED_CLOCK) {
  if (!event || event.kind !== 'exec_succeeded') return null;
  const argv = Array.isArray(event.argv) ? event.argv.filter((part) => typeof part === 'string') : [];
  const command = argv.join(' ').trim();
  const observed = msFromNs(event.timestamp_ns);
  const timestamp = observed == null ? null : observed - clock.offsetMs;
  const pid = Number(event.pid);
  const eventId = Number(event.event_id);
  if (!command || timestamp == null || !Number.isFinite(pid) || !Number.isFinite(eventId)) return null;
  // `markers` is the collector's allowlisted RAYTRACE_* env (see
  // worker/gvisor/collector.py MARKER_KEYS). When RAYTRACE_CALL_ID is present
  // it IS the answer -- the call id travelled with the process -- and the
  // text matcher is skipped entirely. Absent on every event until something
  // in the spawn path stamps it, which is why the matcher stays the default.
  // A sandboxed Claude Code stamps it in the command itself (`export
  // RAYTRACE_CALL_ID=...`, worker/gvisor/claude-hook.mjs): the shell that
  // runs the command carries it in argv, the programs it starts in env.
  const marker = (event.markers && typeof event.markers === 'object' ? event.markers.RAYTRACE_CALL_ID : null)
    ?? commandMarker(command);
  return {
    id: `${rowPrefix(event.container_id)}${eventId}`,
    pid,
    ppid: Number.isFinite(Number(event.ppid)) ? Number(event.ppid) : null,
    command,
    argv,
    cwd: typeof event.cwd === 'string' ? event.cwd : null,
    timestamp,
    start_time_ns: typeof event.process_start_ns === 'string' ? event.process_start_ns : null,
    call_marker: typeof marker === 'string' && marker ? marker : null,
    margin: clock.marginMs,
    // The collector event itself, for the evidence store: it is recorded
    // as observed, alongside the process it describes.
    container_id: typeof event.container_id === 'string' ? event.container_id : null,
    raw: event,
  };
}

/** One collector `exec_failed` event (an execve that returned an error, so
 * the program never ran and the calling process carried on) -> a row that
 * is already finished as failed, or null if unusable. */
export function toFailedExec(event, clock = UNMEASURED_CLOCK) {
  if (!event || event.kind !== 'exec_failed') return null;
  const argv = Array.isArray(event.argv) ? event.argv.filter((part) => typeof part === 'string') : [];
  if (!argv.length && typeof event.executable === 'string' && event.executable) argv.push(event.executable);
  const observed = msFromNs(event.timestamp_ns);
  const pid = Number(event.pid);
  const eventId = Number(event.event_id);
  if (!argv.length || observed == null || !Number.isFinite(pid) || !Number.isFinite(eventId)) return null;
  const at = new Date(observed - clock.offsetMs).toISOString();
  return {
    id: `${rowPrefix(event.container_id)}${eventId}`,
    pid,
    ppid: Number.isFinite(Number(event.ppid)) ? Number(event.ppid) : null,
    command: argv.join(' ').trim(),
    argv,
    timestamp: observed - clock.offsetMs,
    start_time_ns: typeof event.process_start_ns === 'string' ? event.process_start_ns : null,
    status: 'failed',
    error: `exec failed: errno ${Number.isFinite(Number(event.errno)) ? Number(event.errno) : 'unknown'}`,
    ended_at: at,
    container_id: typeof event.container_id === 'string' ? event.container_id : null,
    raw: event,
  };
}

/** One collector `process_exit` event -> the status/error to close the row
 * with. Never guesses: an exit we can't read is 'unknown', not 'completed'. */
export function exitOutcome(event) {
  if (typeof event?.signal === 'number' && event.signal > 0) return { status: 'failed', error: `killed by signal ${event.signal}`, exit_code: null };
  if (typeof event?.exit_code === 'number') {
    return event.exit_code === 0 ? { status: 'completed', error: null, exit_code: 0 } : { status: 'failed', error: `exit ${event.exit_code}`, exit_code: event.exit_code };
  }
  return { status: 'unknown', error: null, exit_code: null };
}

/** Per-sandbox tailing state: how far into the collector's event ids we've
 * read, and which pids currently belong to a matched, still-running command.
 * Each entry is `{ execId, callId }` -- `execId` is that pid's OWN row (so
 * its exit closes the right one) and `callId` is the proposed call the whole
 * subtree belongs to (so a child inherits attribution without re-matching).
 * Same-pid re-execs still collapse onto the first entry: bash exec()ing its
 * last command in place is one process doing one job, not a new one. */
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
 * @param {(row: {exec: object, parent_call_id: string|null, tier: string}) => Promise<void>|void} [deps.descend]
 *   - records a process that ran underneath a call, or underneath nothing.
 *     Defaults to a no-op so existing callers keep their behaviour.
 * @param {(row: object) => Promise<boolean>|boolean} [deps.finishByProcess]
 *   - closes a process by its identity (pid + start time) when `tracker.live`
 *     holds no link to it (after a proxy restart, or an unattributed process,
 *     never tracked). Same row shape as `finish`.
 * @param {(row: {container_id: string, session_id: string, reason: string, raw?: object, ended?: boolean}) => Promise<number>|number} [deps.lose]
 *   - marks a sandbox's open rows `unknown` once their exits can no longer arrive.
 * @param {{offsetMs: number, marginMs: number}} [deps.clock] - VM->proxy clock mapping
 * @returns {Promise<{forwarded: number, matched: number, finished: number, descendants: number, unattributed: number, failedExecs: number, lost: number}>}
 */
export async function processEvents(events, { sessionId, tracker, ingest, finish, descend = () => {}, finishByProcess = () => false, lose = () => 0, clock = UNMEASURED_CLOCK }) {
  const counts = { forwarded: 0, matched: 0, finished: 0, descendants: 0, unattributed: 0, failedExecs: 0, lost: 0 };
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isFinite(Number(event?.event_id)) && Number(event.event_id) > tracker.cursor)
    .sort((a, b) => Number(a.event_id) - Number(b.event_id));

  for (const event of ordered) {
    tracker.cursor = Number(event.event_id);
    if (event.kind === 'exec_succeeded') {
      const exec = toExecutionEvent(event, clock);
      if (!exec) continue;
      // Same pid already carrying a matched command: bash exec()ing its last
      // command in place. Still one process doing one job -- recording it
      // again would both double-count and re-point that pid's exit at the
      // wrong row, so it stays collapsed onto the first entry.
      if (tracker.live.has(exec.pid)) continue;

      // A child of a command we already attributed. Before migration 005 this
      // was `continue` -- the event was seen, recognised, and dropped, which
      // is how a file deleted by an npm pretest hook ended up in gVisor's
      // stream and nowhere in RayTrace. It now gets its own row hanging off
      // the owning call, and joins `live` so ITS children inherit too (the
      // deletion is a grandchild; a one-level check never reached it).
      const owner = exec.ppid != null ? tracker.live.get(exec.ppid) : null;
      if (owner) {
        await descend({ exec, parent_call_id: owner.callId, tier: owner.callId ? 'corroborated' : 'unverified', session_id: sessionId });
        tracker.live.set(exec.pid, { execId: exec.id, callId: owner.callId });
        counts.descendants += 1;
        continue;
      }

      counts.forwarded += 1;
      const matches = await ingest([exec], { sessionId });
      const match = matches && matches.get ? matches.get(exec.id) : null;
      if (match) {
        counts.matched += 1;
        tracker.live.set(exec.pid, { execId: exec.id, callId: match.call_id });
      } else {
        // Ran inside the agent's own sandbox, matched no proposed call. Either
        // the correlator failed or nothing proposed it; both are worth seeing
        // and neither was storable before 005. Deliberately NOT tracked in
        // `live`: leaving its children to face the matcher keeps every
        // existing match outcome identical, so this path only adds rows.
        await descend({ exec, parent_call_id: null, tier: 'unverified', session_id: sessionId });
        counts.unattributed += 1;
      }
    } else if (event.kind === 'exec_failed') {
      // The program never started, so there is no exec_succeeded and no row
      // for it -- a forked child whose execve failed used to vanish. The
      // calling process carries on (bash reports the error and exits), so
      // its own row still closes normally. Not added to `live`: nothing ran.
      const failed = toFailedExec(event, clock);
      if (!failed) continue;
      const owner = tracker.live.get(failed.pid) ?? (failed.ppid != null ? tracker.live.get(failed.ppid) : null);
      await descend({ exec: failed, parent_call_id: owner?.callId ?? null, tier: owner?.callId ? 'corroborated' : 'unverified', session_id: sessionId });
      counts.failedExecs += 1;
    } else if (event.kind === 'process_exit') {
      const pid = Number(event.pid);
      const endedMs = msFromNs(event.timestamp_ns);
      const ended_at = endedMs == null ? null : new Date(endedMs - clock.offsetMs).toISOString();
      const { status, error, exit_code } = exitOutcome(event);
      const exitRow = { ended_at, ended_ms: endedMs == null ? null : endedMs - clock.offsetMs, status, error, exit_code,
        signal: typeof event.signal === 'number' && event.signal > 0 ? event.signal : null,
        pid, start_time_ns: typeof event.process_start_ns === 'string' ? event.process_start_ns : null,
        container_id: typeof event.container_id === 'string' ? event.container_id : null, session_id: sessionId, raw: event };
      const entry = tracker.live.get(pid);
      if (entry) {
        tracker.live.delete(pid);
        await finish({ id: entry.execId, ...exitRow });
        counts.finished += 1;
      } else if (exitRow.start_time_ns) {
        // No in-memory link: the process was seen before a proxy restart, or
        // was never tracked (unattributed). Found again by pid + start time.
        const closed = await finishByProcess(exitRow);
        if (closed) counts.finished += 1;
      }
    } else if (event.kind === 'collector_disconnected' && typeof event.container_id === 'string' && event.container_id) {
      // This sandbox's evidence stream ended. Exits for processes still
      // open can no longer arrive, so they become unknown -- not failed.
      // A later exit on a new connection still closes them (see
      // finishExecutionByProcess), since real evidence beats "lost".
      counts.lost += Number(await lose({ container_id: event.container_id, session_id: sessionId, reason: 'collector disconnected', raw: event })) || 0;
      tracker.live.clear();
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
  descend,
  finishByProcess,
  lose,
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
  let clockDown = false;
  let clock = UNMEASURED_CLOCK;
  const clockSamples = []; // most recent last; bounded
  let discovering = null; // in-flight promise, so a concurrent call awaits it instead of racing
  let polling = null;
  let stopped = false;

  const getJson = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return res.json();
  };

  /** Highest event id the collector currently holds for a container, used to
   * seed a new tracker so tailing begins at "now". Falls back to 0 -- which
   * replays history -- only if the viewer cannot be reached, since starting
   * over-inclusive is recoverable and starting blind is not. */
  const latestEventId = async (containerId) => {
    try {
      const page = await getJson(`${viewerBase}/events?container=${containerId}&limit=1&processes=1`);
      const ids = (page?.events ?? []).map((e) => Number(e?.event_id)).filter(Number.isFinite);
      return ids.length ? Math.max(...ids) : 0;
    } catch { return 0; }
  };

  const discover = () => {
    if (stopped) return Promise.resolve();
    if (discovering) return discovering;
    discovering = discoverOnce().finally(() => { discovering = null; });
    return discovering;
  };
  /** One NTP-style sample of the VM clock against ours. Keeps the last few;
   * a failed sample leaves the previous mapping in place, and with none at
   * all the forwarder runs unmeasured (zero offset, wide margin). */
  const sampleClock = async () => {
    try {
      const sent = Date.now();
      const body = await getJson(`${viewerBase}/time`);
      const received = Date.now();
      const vmMs = msFromNs(body?.realtime_ns);
      if (vmMs == null) throw new Error('no realtime_ns in /time response');
      clockSamples.push({ offsetMs: vmMs - (sent + received) / 2, rttMs: received - sent });
      if (clockSamples.length > 5) clockSamples.shift();
      clock = clockFromSamples(clockSamples);
      if (clockDown) { clockDown = false; log('[raytace][gvisor] sandbox clock measurable again'); }
    } catch (error) {
      if (!clockDown) {
        clockDown = true;
        log(`[raytace][gvisor] could not read the sandbox clock at ${viewerBase}/time (${error.message}) -- matching with a ${clock.marginMs} ms margin until it can`);
      }
    }
  };

  const discoverOnce = async () => {
    try {
      const projects = await getJson(`${managerBase}/api/projects`);
      await sampleClock();
      const present = new Set();
      for (const project of Array.isArray(projects) ? projects : []) {
        const sessionId = project?.id;
        const containerId = project?.container_id;
        if (!SANDBOX_ID.test(sessionId || '') || !CONTAINER_ID.test(containerId || '')) continue;
        present.add(containerId);
        if (!sandboxes.has(containerId)) {
          const tracker = new SandboxTracker();
          // Start from the newest event, not from zero. The collector's
          // evidence store lives in the VM and is append-only, so it outlives
          // any proxy restart: a tracker that begins at 0 re-reads days of
          // history on every start. Those old execs can never match anything
          // -- the proxy was not capturing model traffic then, so no proposed
          // call exists for them -- and since they now get written as
          // unattributed rows rather than dropped, the replay floods the
          // table and pushes the live session behind a backlog.
          tracker.cursor = await latestEventId(containerId);
          sandboxes.set(containerId, { sessionId, tracker });
          log(`[raytace][gvisor] forwarding evidence for sandbox ${sessionId} (container ${containerId.slice(0, 12)}) from event ${tracker.cursor}`);
        }
      }
      // A sandbox the manager no longer lists is gone, and so is any exit
      // its open rows were waiting for. Only on a successful listing: an
      // unreachable manager proves nothing about the sandboxes.
      for (const [containerId, { sessionId }] of sandboxes) {
        if (present.has(containerId)) continue;
        sandboxes.delete(containerId);
        const lost = typeof lose === 'function' ? Number(await lose({ container_id: containerId, session_id: sessionId, reason: 'sandbox removed', ended: true })) || 0 : 0;
        log(`[raytace][gvisor] sandbox ${sessionId} is gone; stopped forwarding${lost ? `, ${lost} open execution(s) marked unknown` : ''}`);
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
        const counts = await processEvents(page?.events, { sessionId, tracker, ingest, finish, descend,
          ...(typeof finishByProcess === 'function' ? { finishByProcess } : {}),
          ...(typeof lose === 'function' ? { lose } : {}),
          clock });
        if (counts.matched || counts.finished || counts.descendants || counts.unattributed || counts.failedExecs || counts.lost) {
          log(`[raytace][gvisor] ${sessionId.slice(0, 12)}: ${counts.matched} exec(s) matched to proposed calls, `
            + `${counts.descendants} descendant(s), ${counts.unattributed} unattributed, ${counts.failedExecs} failed exec(s), `
            + `${counts.finished} closed out, ${counts.lost} marked unknown, ${counts.forwarded} top-level exec(s) considered`);
        }
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
    /** Test/inspection hook: the VM->proxy clock mapping in use. */
    clock: () => clock,
  };
}
