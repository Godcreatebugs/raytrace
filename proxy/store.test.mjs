import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';

const exchange = (spanId, items, output = []) => ({
  event_type: 'model.exchange', span_id: spanId, trace_id: 't1',
  session_id: 'sess', session_started_at: '2026-01-01T00:00:00.000Z',
  provider: 'openrouter', route: '/v1/responses', method: 'POST',
  timestamp: `2026-01-01T00:00:0${spanId.slice(-1)}.000Z`, completed_at: '2026-01-01T00:00:09.000Z',
  request: { headers: { 'content-type': 'application/json' }, bytes: 1, sha256: 'a',
    payload: { model: 'qwen', stream: true, tools: [{ name: 'read_file', schema: 'x'.repeat(500) }], input: items } },
  response: { status: 200, headers: {}, bytes: 2, sha256: 'b', payload: { output } },
});

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-store-'));
  const store = openStore(join(dir, 'test.db'));
  try { await run(store); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

test('exchange rows survive a lossless round trip', () => withStore((store) => {
  const row = exchange('s1', [{ role: 'user', type: 'message', content: 'fix auth' }]);
  store.recordExchange(row);
  const [back] = store.exchangeRows({});
  assert.deepEqual(back.request.payload, row.request.payload);
  assert.deepEqual(back.response.payload, row.response.payload);
  assert.equal(back.provider, 'openrouter');
  assert.equal(back.completed_at, row.completed_at);
}));

test('repeated context and tool schemas are stored once', () => withStore((store) => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', type: 'message', content: `turn ${i}` }));
  // Three turns that resend the same history, as a real agent loop does.
  store.recordExchange(exchange('s1', history));
  store.recordExchange(exchange('s2', [...history, { role: 'user', type: 'message', content: 'new' }]));
  store.recordExchange(exchange('s3', [...history, { role: 'user', type: 'message', content: 'new' }, { role: 'user', type: 'message', content: 'newer' }]));
  const stats = store.stats();
  assert.equal(stats.contextItems, 63);                 // 20 + 21 + 22 stored positions
  const distinct = store.db.prepare('SELECT COUNT(DISTINCT blob_sha) AS n FROM context_items').get().n;
  assert.equal(distinct, 22, '63 stored positions reference only 22 distinct texts');
  const contextBytes = store.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM blobs WHERE sha IN (SELECT blob_sha FROM context_items)').get().n;
  assert.ok(contextBytes < stats.logicalBytes / 2, 'deduplication should at least halve stored context bytes');
  // The large tool schema repeats on every turn and must collapse to one row.
  assert.equal(store.db.prepare('SELECT COUNT(DISTINCT tools_sha) AS n FROM exchanges').get().n, 1);
}));

test('a proposed call with no execution reports as not_executed', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{}' }]));
  const [call] = store.divergence(['s1']);
  assert.equal(call.name, 'read_file');
  assert.equal(call.outcome, 'not_executed');
}));

test('recordExecution fills in what divergence() reports, and candidatesInWindow excludes already-resolved calls', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  const before = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER);
  assert.equal(before.length, 1);
  assert.equal(before[0].call_id, 'c1');
  assert.deepEqual(before[0].args, { command: 'ls -la' });

  store.recordExecution({ id: 'exec-abc', call_id: 'c1', started_at: '2026-01-01T00:00:01.000Z', ended_at: '2026-01-01T00:00:02.000Z', status: 'completed' });

  const [call] = store.divergence(['s1']);
  assert.equal(call.outcome, 'as_proposed');
  assert.equal(call.status, 'completed');

  // Once resolved, it drops out of the candidate pool — a later batch won't re-match it.
  const after = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER);
  assert.equal(after.length, 0);
}));

test('kernel candidate pool includes rollout-resolved calls until kernel confirmation', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  store.recordExecution({ id: 'exec-abc', call_id: 'c1', status: 'completed' });

  const pending = store.kernelCandidatesInWindow(0, Number.MAX_SAFE_INTEGER);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].call_id, 'c1');
  assert.deepEqual(pending[0].args, { command: 'ls -la' });

  assert.equal(store.confirmKernelExecution({ call_id: 'c1', match_score: 1, pid: 123 }), true);
  assert.equal(store.kernelCandidatesInWindow(0, Number.MAX_SAFE_INTEGER).length, 0);
}));

test('kernel candidate window uses the execution\'s own timestamp, not the exchange\'s call time', () => withStore((store) => {
  // The exchange (model call) started at 2026-01-01T00:00:01.000Z, but the
  // command it proposed didn't actually run until minutes later -- a totally
  // ordinary gap (thinking time, a multi-step tool loop, user approval).
  // Regression test for a bug where kernelCandidatesInWindow() windowed
  // against the exchange's started_ms instead of the execution's own
  // started_at/ended_at, so kernel confirmations for anything but
  // near-instant commands always landed 30s+ outside the window and never
  // confirmed.
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  const execTime = new Date('2026-01-01T00:05:00.000Z');
  store.recordExecution({ id: 'exec-abc', call_id: 'c1', status: 'completed', started_at: execTime.toISOString(), ended_at: execTime.toISOString() });

  // A window centered on the real execution time (not the exchange's call
  // time, ~5 minutes earlier) should find the candidate.
  const nearExecution = store.kernelCandidatesInWindow(execTime.getTime() - 30_000, execTime.getTime() + 30_000);
  assert.equal(nearExecution.length, 1);
  assert.equal(nearExecution[0].call_id, 'c1');
  // julianday() round-trips through floating point, so allow the ~1ms
  // truncation error rather than asserting exact equality.
  assert.ok(Math.abs(nearExecution[0].timestamp - execTime.getTime()) <= 1);

  // A window centered on the exchange's call time -- what the old, buggy
  // query effectively required -- should NOT find it; the real timestamp is
  // ~5 minutes outside this window.
  const exchangeTime = new Date('2026-01-01T00:00:01.000Z').getTime();
  const nearExchangeCall = store.kernelCandidatesInWindow(exchangeTime - 30_000, exchangeTime + 30_000);
  assert.equal(nearExchangeCall.length, 0);
}));

test('candidatesInWindow can be scoped to one session (sandbox execs never match another session\'s calls)', () => withStore((store) => {
  const inSandbox = { ...exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]), session_id: 'rtp-' + 'a'.repeat(32) };
  const native = { ...exchange('s2', [], [{ type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: { command: 'ls -la' } }]), session_id: 'native-session' };
  store.recordExchange(inSandbox);
  store.recordExchange(native);
  const all = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(all.map((c) => c.call_id).sort(), ['c1', 'c2']);
  const scoped = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: inSandbox.session_id });
  assert.deepEqual(scoped.map((c) => c.call_id), ['c1']);
}));

test('finishExecution closes out a row recorded at process start, and reports a miss for unknown ids', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  store.recordExecution({ id: 'gvisor-abc-7', call_id: 'c1', started_at: '2026-01-01T00:05:00.000Z', status: 'running', source: 'gvisor' });
  assert.equal(store.finishExecution({ id: 'gvisor-abc-7', ended_at: '2026-01-01T00:05:02.000Z', status: 'failed', error: 'exit 2' }), true);
  const [call] = store.divergence(['s1']);
  assert.equal(call.status, 'failed');
  assert.equal(call.error, 'exit 2');
  assert.equal(call.source, 'gvisor');
  assert.equal(store.finishExecution({ id: 'gvisor-never-recorded', ended_at: null, status: 'completed' }), false);
}));

test('gVisor primary-witness round trip: recorded at exec as running + kernel-confirmed, closed out on exit', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'npm test' } }]));
  store.recordExecution({ id: 'gvisor-abc-1', call_id: 'c1', started_at: '2026-01-01T00:05:00.000Z', ended_at: null, status: 'running', source: 'gvisor', match_score: 1, match_basis: 'text' });
  assert.equal(store.confirmKernelExecution({ call_id: 'c1', match_score: 1, pid: 77 }), true);

  let [call] = store.divergence(['s1']);
  assert.equal(call.outcome, 'as_proposed', 'a running row already counts as executed, not not_executed');
  assert.equal(call.status, 'running');
  assert.equal(call.source, 'gvisor');
  assert.equal(call.kernel_confirmed, 1);
  // Once recorded, the call leaves the rollout candidate pool but stays out
  // of the kernel pool too (already confirmed) -- no second witness can
  // re-claim or double-confirm it.
  assert.equal(store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER).length, 0);
  assert.equal(store.kernelCandidatesInWindow(0, Number.MAX_SAFE_INTEGER).length, 0);

  assert.equal(store.finishExecution({ id: 'gvisor-abc-1', ended_at: '2026-01-01T00:05:09.000Z', status: 'completed', error: null }), true);
  [call] = store.divergence(['s1']);
  assert.equal(call.status, 'completed');
  assert.equal(call.kernel_confirmed, 1, 'finishing must not clear the kernel confirmation');
}));

test('recordExecution is idempotent for the same exec id (re-ingesting a rollout line is a no-op, not a duplicate)', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  store.recordExecution({ id: 'exec-abc', call_id: 'c1', status: 'completed' });
  store.recordExecution({ id: 'exec-abc', call_id: 'c1', status: 'completed' });
  const count = store.db.prepare('SELECT COUNT(*) AS n FROM tool_executions').get().n;
  assert.equal(count, 1);
}));

test('recordExecution persists match_score/match_basis, surfaced through divergence()', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  store.recordExecution({ id: 'c1', call_id: 'c1', status: 'completed', match_score: 1, match_basis: 'id' });
  const [call] = store.divergence(['s1']);
  assert.equal(call.match_score, 1);
  assert.equal(call.match_basis, 'id');
}));

test('recordExecution without match_score/match_basis defaults them to null (older callers keep working)', () => withStore((store) => {
  store.recordExchange(exchange('s1', [], [{ type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: { command: 'ls -la' } }]));
  store.recordExecution({ id: 'exec-abc', call_id: 'c1', status: 'completed' });
  const [call] = store.divergence(['s1']);
  assert.equal(call.match_score, null);
  assert.equal(call.match_basis, null);
}));

test('re-recording an exchange replaces it instead of duplicating', () => withStore((store) => {
  store.recordExchange(exchange('s1', [{ role: 'user', type: 'message', content: 'first' }]));
  store.recordExchange(exchange('s1', [{ role: 'user', type: 'message', content: 'first' }]));
  assert.equal(store.stats().exchanges, 1);
  assert.equal(store.exchangeRows({}).length, 1);
}));

test('experiments and explanations round trip and are bounded', () => withStore((store) => {
  store.saveExperiment({ id: 'e1', created_at: '2026-01-01T00:00:00.000Z', status: 'completed', model: 'qwen' });
  assert.equal(store.loadExperiments()[0].status, 'completed');
  assert.equal(store.getExplanation('missing'), null);
  store.putExplanation('k1', { hypotheses: [{ title: 'h' }] });
  assert.equal(store.getExplanation('k1').hypotheses[0].title, 'h');

  assert.equal(store.getSummary('sk1'), null);
  assert.equal(store.summaryForSpan('s1'), null);
  store.putSummary('sk1', 's1', { text: 'ran a script and it worked' });
  assert.equal(store.getSummary('sk1').text, 'ran a script and it worked');
  assert.equal(store.summaryForSpan('s1').text, 'ran a script and it worked');
}));

test('migrations apply once and reopening is safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-migrate-'));
  const file = join(dir, 'test.db');
  const first = openStore(file);
  first.recordExchange(exchange('s1', [{ role: 'user', type: 'message', content: 'hi' }]));
  first.close();
  const second = openStore(file);                       // must not re-run 001_init
  assert.equal(second.exchangeRows({}).length, 1);
  assert.equal(second.db.prepare('PRAGMA user_version').get().user_version, 4); // 001_init + 002_summaries + 003_execution_confidence + 004_kernel_verification
  second.close();
  await rm(dir, { recursive: true, force: true });
});
