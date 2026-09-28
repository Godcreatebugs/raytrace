import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toExecutionEvent, toFailedExec, exitOutcome, msFromNs, processEvents, SandboxTracker, startGvisorForwarder, clockFromSamples, UNMEASURED_CLOCK } from './gvisor-forwarder.mjs';

// Event shapes below mirror what worker/gvisor/collector.py writes and
// viewer.py serves (see `decode()` there): timestamp_ns / process_start_ns
// are strings because they don't fit a JS number losslessly.
const CONTAINER = 'c'.repeat(64);
const SESSION = 'rtp-' + 'a'.repeat(32);
const NS = (ms) => String(BigInt(ms) * 1_000_000n);
const exec = (event_id, pid, ppid, argv, ms = 1_700_000_000_000 + event_id) => ({ event_id, kind: 'exec_succeeded', pid, ppid, argv, container_id: CONTAINER, timestamp_ns: NS(ms), cwd: '/workspace' });
const exit = (event_id, pid, exit_code, signal = null, ms = 1_700_000_000_000 + event_id) => ({ event_id, kind: 'process_exit', pid, exit_code, signal, container_id: CONTAINER, timestamp_ns: NS(ms) });

test('msFromNs converts the collector\'s ns strings and rejects garbage', () => {
  assert.equal(msFromNs('1700000000000000000'), 1_700_000_000_000);
  assert.equal(msFromNs(''), null);
  assert.equal(msFromNs(null), null);
  assert.equal(msFromNs('not-a-number'), null);
  assert.equal(msFromNs('0'), null);
});

test('toExecutionEvent maps exec_succeeded into the matcher shape with a collision-proof id', () => {
  const raw = exec(42, 10, 1, ['/bin/bash', '-lc', 'git status']);
  assert.deepEqual(toExecutionEvent(raw), {
    id: `gvisor-${'c'.repeat(12)}-42`, pid: 10, ppid: 1, command: '/bin/bash -lc git status',
    argv: ['/bin/bash', '-lc', 'git status'], cwd: '/workspace', timestamp: 1_700_000_000_042,
    start_time_ns: null, call_marker: null, margin: 2000,
    // The observation itself travels with it, for the evidence store.
    container_id: CONTAINER, raw,
  });
});

test('toExecutionEvent carries RAYTRACE_CALL_ID through, and ignores other markers', () => {
  const marked = { ...exec(7, 10, 1, ['ls']), markers: { RAYTRACE_CALL_ID: 'call_abc', RAYTRACE_SESSION: 'rtp-x' } };
  assert.equal(toExecutionEvent(marked).call_marker, 'call_abc');
  // A session marker alone is not a per-call join; it must not become one.
  assert.equal(toExecutionEvent({ ...exec(8, 10, 1, ['ls']), markers: { RAYTRACE_SESSION: 'rtp-x' } }).call_marker, null);
  assert.equal(toExecutionEvent({ ...exec(9, 10, 1, ['ls']), markers: { RAYTRACE_CALL_ID: '' } }).call_marker, null);
});

test('toExecutionEvent rejects anything that is not a usable exec', () => {
  assert.equal(toExecutionEvent(exit(1, 10, 0)), null);
  assert.equal(toExecutionEvent(exec(2, 10, 1, [])), null);
  assert.equal(toExecutionEvent({ ...exec(3, 10, 1, ['ls']), timestamp_ns: 'nope' }), null);
  assert.equal(toExecutionEvent({ ...exec(4, 10, 1, ['ls']), pid: 'x' }), null);
  assert.equal(toExecutionEvent(null), null);
});

test('exitOutcome never upgrades an unreadable exit to success', () => {
  assert.deepEqual(exitOutcome({ exit_code: 0, signal: null }), { status: 'completed', error: null, exit_code: 0 });
  assert.deepEqual(exitOutcome({ exit_code: 2, signal: null }), { status: 'failed', error: 'exit 2', exit_code: 2 });
  assert.deepEqual(exitOutcome({ exit_code: null, signal: 9 }), { status: 'failed', error: 'killed by signal 9', exit_code: null });
  assert.deepEqual(exitOutcome({ exit_code: null, signal: null }), { status: 'unknown', error: null, exit_code: null });
  assert.deepEqual(exitOutcome(undefined), { status: 'unknown', error: null, exit_code: null });
});

/** ingest() fake: matches when the command text contains one of the given
 * substrings; records every call so tests can assert on what was sent. */
function fakeIngest(matchIf) {
  const calls = [];
  const ingest = async (events, opts) => {
    calls.push({ events, opts });
    const out = new Map();
    for (const e of events) if (matchIf.some((needle) => e.command.includes(needle))) out.set(e.id, { call_id: `call-for-${e.id}`, score: 1, basis: 'text' });
    return out;
  };
  return { ingest, calls };
}

test('a top-level bash -lc exec is forwarded and scoped to the sandbox session; its children are recorded, not matched', async () => {
  const { ingest, calls } = fakeIngest(['git status']);
  const finished = [];
  const descended = [];
  const tracker = new SandboxTracker();
  const counts = await processEvents([
    exec(1, 100, 1, ['/bin/bash', '-lc', 'git status']),
    exec(2, 101, 100, ['git', 'status']),        // child of the matched bash: never offered to the matcher
    exit(3, 101, 0),                              // child exit: closes the CHILD's own row
    exit(4, 100, 0),                              // the command itself finishing
  ], { sessionId: SESSION, tracker, ingest, finish: async (row) => { finished.push(row); return true; },
       descend: async (row) => { descended.push(row); } });

  assert.deepEqual(counts, { forwarded: 1, matched: 1, finished: 2, descendants: 1, unattributed: 0, failedExecs: 0, lost: 0 });
  assert.equal(calls.length, 1, 'only the top-level exec reached the matcher');
  assert.equal(calls[0].opts.sessionId, SESSION);
  assert.equal(calls[0].events[0].command, '/bin/bash -lc git status');

  // The child is stored against the call its parent resolved to.
  assert.equal(descended.length, 1);
  assert.equal(descended[0].parent_call_id, `call-for-gvisor-${'c'.repeat(12)}-1`);
  assert.equal(descended[0].tier, 'corroborated');
  assert.equal(descended[0].exec.pid, 101);

  // Each pid closes its OWN row -- a child's exit must never finish its parent.
  assert.deepEqual(finished.map((r) => r.id), [`gvisor-${'c'.repeat(12)}-2`, `gvisor-${'c'.repeat(12)}-1`]);
  assert.equal(tracker.cursor, 4);
  assert.equal(tracker.live.size, 0, 'exits released both pids');
});

test('a grandchild inherits attribution: the one-level check never reached it', async () => {
  // npm test -> sh -c node -e "...unlinkSync" -> node. The deletion is two
  // levels down; before this it fell past the parent check into the matcher,
  // scored too low against every candidate, and was discarded.
  const { ingest } = fakeIngest(['npm test']);
  const descended = [];
  const tracker = new SandboxTracker();
  const counts = await processEvents([
    exec(1, 265, 156, ['/bin/bash', '-lc', 'npm test']),
    exec(2, 277, 265, ['sh', '-c', 'node -e "require(\'fs\').unlinkSync(\'keep.txt\')"']),
    exec(3, 278, 277, ['node', '-e', "require('fs').unlinkSync('keep.txt')"]),
  ], { sessionId: SESSION, tracker, ingest, finish: async () => true, descend: async (row) => { descended.push(row); } });

  assert.equal(counts.descendants, 2);
  const call = `call-for-gvisor-${'c'.repeat(12)}-1`;
  assert.deepEqual(descended.map((r) => [r.exec.pid, r.parent_call_id]), [[277, call], [278, call]]);
});

test('an exec that matches nothing is recorded as unattributed rather than discarded', async () => {
  const { ingest } = fakeIngest([]);   // nothing matches
  const descended = [];
  const tracker = new SandboxTracker();
  const counts = await processEvents([
    exec(1, 900, 1, ['curl', 'https://example.com']),
  ], { sessionId: SESSION, tracker, ingest, finish: async () => true, descend: async (row) => { descended.push(row); } });

  assert.deepEqual(counts, { forwarded: 1, matched: 0, finished: 0, descendants: 0, unattributed: 1, failedExecs: 0, lost: 0 });
  assert.equal(descended.length, 1);
  assert.equal(descended[0].parent_call_id, null, 'belongs to no proposed call');
  assert.equal(descended[0].tier, 'unverified');
});

test('a same-pid re-exec (bash exec()ing its last command) is not offered as a separate candidate', async () => {
  const { ingest, calls } = fakeIngest(['ls']);
  const tracker = new SandboxTracker();
  await processEvents([
    exec(1, 100, 1, ['/bin/bash', '-lc', 'ls -la']),
    exec(2, 100, 1, ['ls', '-la']),               // same pid 100, ppid still 1
  ], { sessionId: SESSION, tracker, ingest, finish: async () => true });
  assert.equal(calls.length, 1, 'only the wrapper exec was ingested');
});

test('unmatched execs never occupy a pid, so their children remain eligible', async () => {
  // e.g. the container entrypoint (`codex` itself) is a top-level exec that
  // matches nothing -- its children (the real tool calls) must still flow.
  const { ingest, calls } = fakeIngest(['npm test']);
  const tracker = new SandboxTracker();
  const counts = await processEvents([
    exec(1, 1, 0, ['codex']),
    exec(2, 50, 1, ['/bin/bash', '-lc', 'npm test']),
  ], { sessionId: SESSION, tracker, ingest, finish: async () => true });
  assert.deepEqual(counts, { forwarded: 2, matched: 1, finished: 0, descendants: 0, unattributed: 1, failedExecs: 0, lost: 0 });
  assert.equal(calls.length, 2);
  assert.equal(tracker.live.get(50).execId, `gvisor-${'c'.repeat(12)}-2`);
  assert.equal(tracker.live.has(1), false);
});

test('a failing command closes out as failed with the exit code, a signal as killed', async () => {
  const { ingest } = fakeIngest(['make', 'sleep']);
  const finished = [];
  const tracker = new SandboxTracker();
  await processEvents([
    exec(1, 7, 1, ['/bin/bash', '-lc', 'make']), exit(2, 7, 2),
    exec(3, 8, 1, ['/bin/bash', '-lc', 'sleep 100']), exit(4, 8, null, 9),
  ], { sessionId: SESSION, tracker, ingest, finish: async (row) => { finished.push(row); return true; } });
  assert.deepEqual(finished.map((r) => [r.status, r.error]), [['failed', 'exit 2'], ['failed', 'killed by signal 9']]);
});

test('events are processed in id order regardless of page order, and only past the cursor', async () => {
  const { ingest, calls } = fakeIngest(['one', 'two']);
  const tracker = new SandboxTracker();
  tracker.cursor = 10;
  // Old viewers ignore `after` and return newest-first; the page also
  // contains events at/below the cursor which must be ignored.
  await processEvents([
    exec(12, 20, 1, ['/bin/bash', '-lc', 'two']),
    exec(11, 19, 1, ['/bin/bash', '-lc', 'one']),
    exec(10, 18, 1, ['/bin/bash', '-lc', 'already seen']),
    exec(9, 17, 1, ['/bin/bash', '-lc', 'older']),
  ], { sessionId: SESSION, tracker, ingest, finish: async () => true });
  assert.deepEqual(calls.map((c) => c.events[0].command), ['/bin/bash -lc one', '/bin/bash -lc two']);
  assert.equal(tracker.cursor, 12);
});

test('malformed pages and events never throw', async () => {
  const tracker = new SandboxTracker();
  const deps = { sessionId: SESSION, tracker, ingest: async () => new Map(), finish: async () => true };
  const none = { forwarded: 0, matched: 0, finished: 0, descendants: 0, unattributed: 0, failedExecs: 0, lost: 0 };
  assert.deepEqual(await processEvents(undefined, deps), none);
  assert.deepEqual(await processEvents([null, {}, { kind: 'exec_succeeded' }, { event_id: 'x', kind: 'process_exit' }], deps), none);
});

test('startGvisorForwarder discovers sandboxes from the manager and tails each container from the viewer', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('/api/projects')) {
      return { ok: true, json: async () => [
        { id: SESSION, container_id: CONTAINER, status: 'running' },
        { id: 'rtp-short', container_id: CONTAINER },            // invalid ids are ignored
        { id: 'rtp-' + 'b'.repeat(32), container_id: null },     // no container yet: ignored
      ] };
    }
    // limit=1 is the cursor seed probe; this container has no history yet.
    if (url.includes('limit=1')) return { ok: true, json: async () => ({ events: [], next_before: null }) };
    if (url.includes('/events?')) return { ok: true, json: async () => ({ events: [exec(1, 5, 1, ['/bin/bash', '-lc', 'pwd']), exit(2, 5, 0)], next_before: null }) };
    throw new Error('unexpected ' + url);
  };
  const { ingest } = fakeIngest(['pwd']);
  const finished = [];
  const logs = [];
  const forwarder = startGvisorForwarder({ ingest, finish: async (row) => { finished.push(row); return true; }, fetchImpl, log: (m) => logs.push(m), pollMs: 60_000, discoverMs: 60_000 });
  try {
    await forwarder.discover();
    assert.equal(forwarder.sandboxes.size, 1);
    assert.equal(forwarder.sandboxes.get(CONTAINER).sessionId, SESSION);
    await forwarder.poll();
    const viewerUrl = requested.find((u) => u.includes('limit=500'));
    assert.match(viewerUrl, new RegExp(`container=${CONTAINER}&after=0&limit=500&processes=1`));
    assert.equal(finished.length, 1);
    assert.equal(forwarder.sandboxes.get(CONTAINER).tracker.cursor, 2);
    assert.ok(logs.some((m) => m.includes('forwarding evidence for sandbox')));
    assert.ok(logs.some((m) => m.includes('1 exec(s) matched')));
    // A second poll asks from the advanced cursor.
    await forwarder.poll();
    assert.ok(requested.some((u) => u.includes('&after=2&')));
  } finally { forwarder.stop(); }
});

test('a newly discovered sandbox starts at the newest event, not at zero', async () => {
  // The collector's evidence store lives in the VM and is append-only, so it
  // outlives the proxy. Beginning at 0 re-reads every past session: none of it
  // can match (no proposed calls were captured then), so it all lands as
  // unattributed rows and pushes the live session behind days of backlog.
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('/api/projects')) return { ok: true, json: async () => [{ id: SESSION, container_id: CONTAINER }] };
    if (url.includes('limit=1')) return { ok: true, json: async () => ({ events: [exec(4096, 9, 1, ['old', 'history'])] }) };
    return { ok: true, json: async () => ({ events: [] }) };
  };
  const logs = [];
  const forwarder = startGvisorForwarder({ ingest: async () => new Map(), finish: async () => true, fetchImpl, log: (m) => logs.push(m), pollMs: 60_000, discoverMs: 60_000 });
  try {
    await forwarder.discover();
    assert.equal(forwarder.sandboxes.get(CONTAINER).tracker.cursor, 4096, 'seeded past the backlog');
    await forwarder.poll();
    assert.ok(requested.some((u) => u.includes('&after=4096&')), 'tails forward from there');
    assert.ok(logs.some((m) => m.includes('from event 4096')));
  } finally { forwarder.stop(); }
});

test('an unreachable viewer during discovery falls back to replaying rather than skipping evidence', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/projects')) return { ok: true, json: async () => [{ id: SESSION, container_id: CONTAINER }] };
    throw new Error('ECONNREFUSED');
  };
  const forwarder = startGvisorForwarder({ ingest: async () => new Map(), finish: async () => true, fetchImpl, log: () => {}, pollMs: 60_000, discoverMs: 60_000 });
  try {
    await forwarder.discover();
    // Over-inclusive is recoverable; starting blind loses evidence silently.
    assert.equal(forwarder.sandboxes.get(CONTAINER).tracker.cursor, 0);
  } finally { forwarder.stop(); }
});

test('startGvisorForwarder logs an unreachable manager once and stays idle rather than failing', async () => {
  const logs = [];
  const forwarder = startGvisorForwarder({ ingest: async () => new Map(), finish: async () => true, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log: (m) => logs.push(m), pollMs: 60_000, discoverMs: 60_000 });
  try {
    await forwarder.discover();
    await forwarder.discover();
    assert.equal(logs.filter((m) => m.includes('sandbox manager not reachable')).length, 1);
    await forwarder.poll(); // nothing to poll; must not throw
    assert.equal(forwarder.sandboxes.size, 0);
  } finally { forwarder.stop(); }
});

const BASE = 1_700_000_000_000;
const PREFIX = `gvisor-${'c'.repeat(12)}-`;

test('clockFromSamples trusts the shortest round trip, and is unmeasured with no samples', () => {
  assert.deepEqual(clockFromSamples([{ offsetMs: 3100, rttMs: 40 }, { offsetMs: 2990, rttMs: 4 }, { offsetMs: 3500, rttMs: 900 }]),
    { offsetMs: 2990, marginMs: 252, measured: true });
  assert.equal(clockFromSamples([]), UNMEASURED_CLOCK);
  assert.equal(clockFromSamples([{ offsetMs: NaN, rttMs: 1 }]), UNMEASURED_CLOCK);
});

test('exec times are shifted onto the proxy clock, carrying the measured margin', () => {
  // The VM clock runs 3 s ahead: an exec it stamps at +3 s happened at +0 s for us.
  const event = toExecutionEvent(exec(1, 10, 1, ['ls'], BASE + 3000), { offsetMs: 3000, marginMs: 260 });
  assert.equal(event.timestamp, BASE);
  assert.equal(event.margin, 260);
});

test('a failed execve under a matched command gets its own failed row instead of vanishing', async () => {
  const tracker = new SandboxTracker();
  tracker.live.set(100, { execId: `${PREFIX}1`, callId: 'call_x' });
  const descended = [];
  const failed = { event_id: 5, kind: 'exec_failed', pid: 101, ppid: 100, argv: ['./script.sh'], errno: 13, container_id: CONTAINER, timestamp_ns: NS(BASE + 5) };
  const counts = await processEvents([failed], { sessionId: SESSION, tracker, ingest: async () => new Map(), finish: async () => true,
    descend: async (row) => { descended.push(row); } });
  assert.equal(counts.failedExecs, 1);
  assert.equal(descended[0].parent_call_id, 'call_x');
  assert.equal(descended[0].tier, 'corroborated');
  assert.equal(descended[0].exec.status, 'failed');
  assert.equal(descended[0].exec.error, 'exec failed: errno 13');
  assert.equal(descended[0].exec.ended_at, new Date(BASE + 5).toISOString());
  assert.equal(tracker.live.has(101), false, 'nothing ran, so nothing is tracked');
  assert.equal(toFailedExec({ ...failed, argv: [], executable: '' }), null);
});

test('an exit with no in-memory link (proxy restarted) is closed by pid + start time', async () => {
  const closed = [];
  const counts = await processEvents([{ ...exit(9, 42, 3), process_start_ns: '555' }], {
    sessionId: SESSION, tracker: new SandboxTracker(), ingest: async () => new Map(), finish: async () => { throw new Error('no live entry to finish'); },
    finishByProcess: async (row) => { closed.push(row); return true; } });
  assert.equal(counts.finished, 1);
  const { raw, ...row } = closed[0];
  assert.deepEqual(row, { container_id: CONTAINER, session_id: SESSION, pid: 42, start_time_ns: '555', ended_at: new Date(BASE + 9).toISOString(),
    ended_ms: BASE + 9, status: 'failed', error: 'exit 3', exit_code: 3, signal: null });
  assert.equal(raw.event_id, 9);
});

test('a sandbox\'s collector disconnecting marks its open rows unknown and forgets its live pids', async () => {
  const tracker = new SandboxTracker();
  tracker.live.set(100, { execId: `${PREFIX}1`, callId: 'call_x' });
  const lost = [];
  const counts = await processEvents([{ event_id: 7, kind: 'collector_disconnected', container_id: CONTAINER }], {
    sessionId: SESSION, tracker, ingest: async () => new Map(), finish: async () => true,
    lose: async (row) => { lost.push(row); return 2; } });
  assert.deepEqual(lost, [{ container_id: CONTAINER, session_id: SESSION, reason: 'collector disconnected', raw: { event_id: 7, kind: 'collector_disconnected', container_id: CONTAINER } }]);
  assert.equal(counts.lost, 2);
  assert.equal(tracker.live.size, 0);
});

test('startGvisorForwarder measures the VM clock, falls back when it cannot, and closes out removed sandboxes', async () => {
  let listed = true;
  let timeUp = true;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/projects')) return { ok: true, json: async () => (listed ? [{ id: SESSION, container_id: CONTAINER }] : []) };
    if (url.endsWith('/time')) {
      if (!timeUp) throw new Error('connection refused');
      return { ok: true, json: async () => ({ realtime_ns: NS(Date.now() + 3000) }) };
    }
    if (url.includes('/events?')) return { ok: true, json: async () => ({ events: [] }) };
    throw new Error('unexpected ' + url);
  };
  const lost = [];
  const logs = [];
  const forwarder = startGvisorForwarder({ ingest: async () => new Map(), finish: async () => true, lose: async (row) => { lost.push(row); return 1; },
    fetchImpl, log: (m) => logs.push(m), pollMs: 60_000, discoverMs: 60_000 });
  try {
    await forwarder.discover();
    assert.equal(forwarder.clock().measured, true);
    assert.ok(Math.abs(forwarder.clock().offsetMs - 3000) < 100, `offset ${forwarder.clock().offsetMs}`);

    timeUp = false;
    await forwarder.discover();
    await forwarder.discover();
    assert.equal(forwarder.clock().measured, true, 'a failed sample keeps the last good mapping');
    assert.equal(logs.filter((m) => m.includes('could not read the sandbox clock')).length, 1, 'logged once per outage');

    listed = false;
    await forwarder.discover();
    assert.equal(forwarder.sandboxes.size, 0);
    assert.deepEqual(lost, [{ container_id: CONTAINER, session_id: SESSION, reason: 'sandbox removed', ended: true }]);
    assert.ok(logs.some((m) => m.includes('is gone') && m.includes('1 open execution(s) marked unknown')));
  } finally { forwarder.stop(); }
});
