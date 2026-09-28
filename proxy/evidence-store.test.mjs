import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvidenceStore } from './evidence-store.mjs';
import { SCHEMA_VERSION } from './init-evidence-db.mjs';

const SESSION = 'rtp-' + 'f'.repeat(32);
const CONTAINER = 'c'.repeat(64);
const PROMPT = { role: 'user', type: 'message', content: 'In /workspace/demo-hook, run npm test.' };
const ENV = { role: 'user', type: 'message', content: '<environment_context>cwd=/workspace</environment_context>' };
const TOOLS = [{ type: 'function', name: 'exec_command', schema: 'x'.repeat(400) }];
const CALL = { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"cd /workspace/demo-hook && npm test"}' };
const RESULT = (output) => ({ type: 'function_call_output', call_id: 'call_1', output });
const HEADER = (code, seconds) => `Wall time: ${seconds} seconds\nProcess exited with code ${code}\nOutput:\n1 passing`;

let clock = 0;
const exchange = (id, input, output, { at = (clock += 1000), session = SESSION, status = 200 } = {}) => ({
  event_type: 'model.exchange', span_id: id, trace_id: 'header-trace', session_id: session, session_started_at: new Date(0).toISOString(),
  provider: 'openrouter', route: '/v1/responses', method: 'POST',
  timestamp: new Date(1_790_000_000_000 + at).toISOString(), completed_at: new Date(1_790_000_000_000 + at + 400).toISOString(),
  metrics: { cost: 0.001 },
  request: { headers: { 'content-type': 'application/json' }, bytes: 10, sha256: 'req', payload: { model: 'qwen', stream: true, tools: TOOLS, input } },
  response: { status, headers: {}, bytes: 20, sha256: 'res', payload: { output } },
});

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-evidence-store-'));
  const store = openEvidenceStore(join(dir, 'evidence.db'));
  try { await run(store, dir); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}
const all = (store, sql, ...args) => store.db.prepare(sql).all(...args);
const one = (store, sql, ...args) => store.db.prepare(sql).get(...args);

/** The demo: the user asks, the model proposes npm test, the agent sends the
 * result back and answers. Plus Codex's background title job in between. */
function captureDemo(store, { reported = HEADER(0, 0.3) } = {}) {
  store.recordExchange(exchange('e1', [ENV, PROMPT], [CALL]));
  store.recordExchange(exchange('bg', [{ role: 'user', type: 'message', content: 'Generate a concise, single-line task title for this. User prompt: run tests' }],
    [{ type: 'message', content: [{ type: 'output_text', text: 'Run tests' }] }]));
  store.recordExchange(exchange('e2', [ENV, PROMPT, CALL, RESULT(reported)], [{ type: 'message', content: [{ type: 'output_text', text: 'The tests pass.' }] }]));
}

const exec = (event_id, pid, ppid, argv, startNs, ms) => ({ event_id, kind: 'exec_succeeded', pid, ppid, argv, container_id: CONTAINER,
  process_start_ns: startNs, timestamp_ns: String(BigInt(ms) * 1_000_000n) });
const exit = (event_id, pid, startNs, exit_code, ms) => ({ event_id, kind: 'process_exit', pid, container_id: CONTAINER,
  process_start_ns: startNs, exit_code, timestamp_ns: String(BigInt(ms) * 1_000_000n) });

test('a fresh store is a current-version evidence database', () => withStore((store) => {
  assert.equal(one(store, 'PRAGMA user_version').user_version, SCHEMA_VERSION);
  assert.equal(one(store, "SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").n, 26);
}));

test('tool call contexts and Jev assessments round-trip through the store', () => withStore((store) => {
  captureDemo(store);
  const contexts = store.toolCallContexts(['call_1', 'missing', null]);
  assert.deepEqual([...contexts.keys()], ['call_1']);
  const context = contexts.get('call_1');
  assert.equal(context.tool_name, 'exec_command');
  assert.match(JSON.stringify(context.args), /npm test/);
  assert.match(JSON.stringify(context.result), /Process exited with code 0/);
  assert.equal(store.getCallAssessment('k'), null);
  store.putCallAssessment('k', 'call_1', 'jev-1.13.0', { severities: [{ level: 1 }], labels: null });
  assert.deepEqual(store.getCallAssessment('k'), { severities: [{ level: 1 }], labels: null });
  assert.equal(one(store, "SELECT model FROM call_assessments WHERE key='k'").model, 'jev-1.13.0');
}));

test('capture fills session, turn, exchanges, context items and proposed calls', () => withStore((store) => {
  captureDemo(store);
  const [session] = all(store, 'SELECT * FROM agent_sessions');
  assert.equal(session.external_session_id, SESSION);

  const turns = all(store, 'SELECT * FROM agent_turns');
  assert.equal(turns.length, 1, 'the continuation joins the turn; the title job opens none');
  assert.equal(turns[0].sequence_number, 0);
  assert.equal(turns[0].status, 'completed');
  assert.equal(JSON.parse(one(store, 'SELECT content FROM agent_payloads WHERE sha = ?', turns[0].user_prompt_sha).content), PROMPT.content);
  assert.ok(turns[0].final_response_sha);

  const exchanges = all(store, 'SELECT id, turn_id, route, method, input_key FROM agent_exchanges ORDER BY started_at_ms');
  assert.deepEqual(exchanges.map((e) => [e.id, e.turn_id === turns[0].id, e.turn_id === null]), [['e1', true, false], ['bg', false, true], ['e2', true, false]]);
  assert.equal(exchanges[0].route, '/v1/responses');
  assert.equal(exchanges[0].input_key, 'input');

  const [call] = all(store, 'SELECT * FROM agent_tool_calls');
  assert.equal(call.exchange_id, 'e1');
  assert.equal(call.external_call_id, 'call_1');
  assert.equal(call.tool_name, 'exec_command');
  assert.ok(call.reported_result_sha, 'the result sent back is recorded on the call as its report');
  assert.equal(one(store, "SELECT count(*) n FROM agent_context_items WHERE exchange_id = 'e2'").n, 4);
}));

test('a new user message in the same session opens the next turn', () => withStore((store) => {
  captureDemo(store);
  const next = { role: 'user', type: 'message', content: 'now delete notes.md' };
  store.recordExchange(exchange('e3', [ENV, PROMPT, CALL, RESULT('ok'), { type: 'message', role: 'assistant', content: 'The tests pass.' }, next], []));
  assert.deepEqual(all(store, 'SELECT sequence_number FROM agent_turns ORDER BY sequence_number').map((t) => t.sequence_number), [0, 1]);
}));

test('repeated history and tool lists are stored once, and exchanges hydrate back losslessly', () => withStore((store) => {
  captureDemo(store);
  assert.equal(one(store, 'SELECT count(*) n FROM agent_payloads WHERE content LIKE ?', `%${'x'.repeat(400)}%`).n, 1, 'one tools payload');
  const rows = store.exchangeRows({});
  assert.deepEqual(rows.map((r) => r.span_id), ['e1', 'e2'], 'background jobs are not part of any trace');
  assert.equal(rows[0].trace_id, rows[1].trace_id, 'a trace is a turn');
  assert.equal(rows[0].promptTitle, PROMPT.content);
  assert.deepEqual(rows[1].request.payload, exchange('e2', [ENV, PROMPT, CALL, RESULT(HEADER(0, 0.3))], []).request.payload);
  assert.equal(rows[0].request.headers['content-type'], 'application/json');
  assert.deepEqual(store.findExchange('e1').response, { output: [CALL] });
  assert.equal(store.findExchange('bg').route, '/v1/responses', 'background exchanges stay findable for the lab');
}));

test('causal candidates window each call from its proposal to the request that carried its result', () => withStore((store) => {
  captureDemo(store);
  const [candidate] = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION });
  const [e1, e2] = all(store, "SELECT started_at_ms FROM agent_exchanges WHERE id IN ('e1','e2') ORDER BY started_at_ms");
  assert.equal(candidate.external_call_id, 'call_1');
  assert.equal(candidate.window_start, e1.started_at_ms);
  assert.equal(candidate.window_end, e2.started_at_ms);
  assert.deepEqual(candidate.args, CALL.arguments);
  assert.deepEqual(store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: 'rtp-other' }), []);
}));

/** The sandbox side of the demo: npm test (pid 108), its pretest hook and
 * the rm it runs, and the test itself. */
function observeDemo(store, { exitCode = 0 } = {}) {
  const [candidate] = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION });
  const t = candidate.window_start + 100;
  const top = store.recordProcessStart({ containerId: CONTAINER, projectId: SESSION, raw: exec(1, 108, 10, ['/bin/bash', '-c', 'cd /workspace/demo-hook && npm test'], '1000', t), startedMs: t });
  store.attribute({ toolCallId: candidate.call_id, eventId: top.eventId, method: 'window', score: 1, windowStartMs: candidate.window_start, windowEndMs: candidate.window_end });
  for (const [id, pid, ppid, argv, start] of [[2, 119, 108, ['sh', '-c', 'node scripts/prepare.js'], '1100'], [3, 120, 119, ['node', 'scripts/prepare.js'], '1200'], [4, 127, 120, ['rm', '-f', 'notes/todo.md'], '1300']]) {
    const child = store.recordProcessStart({ containerId: CONTAINER, raw: exec(id, pid, ppid, argv, start, t + id * 10), startedMs: t + id * 10 });
    store.attribute({ toolCallId: candidate.call_id, eventId: child.eventId, method: 'inherited' });
  }
  store.recordProcessExit({ containerId: CONTAINER, raw: exit(5, 127, '1300', 0, t + 60), endedMs: t + 60, exit_code: 0 });
  store.recordProcessExit({ containerId: CONTAINER, raw: exit(6, 108, '1000', exitCode, t + 300), endedMs: t + 300, exit_code: exitCode });
  return candidate;
}

test('sandbox processes, their tree and their attributions land in the runtime tables', () => withStore((store) => {
  captureDemo(store);
  observeDemo(store);
  const [sandbox] = all(store, 'SELECT * FROM runtime_sandboxes');
  assert.equal(sandbox.project_id, SESSION, 'the sandbox joins its agent session by the rtp id');
  const processes = all(store, 'SELECT pid, parent_process_id, exit_code, exited_at_ns FROM runtime_processes ORDER BY pid');
  assert.deepEqual(processes.map((p) => p.pid), [108, 119, 120, 127]);
  assert.equal(processes.find((p) => p.pid === 127).parent_process_id, `${CONTAINER}:120:1200`);
  assert.equal(processes.find((p) => p.pid === 108).exit_code, 0);
  assert.equal(processes.find((p) => p.pid === 119).exited_at_ns, null, 'no exit observed yet');
  assert.deepEqual(all(store, 'SELECT method, count(*) n FROM runtime_attributions GROUP BY method ORDER BY method').map((r) => [r.method, r.n]), [['inherited', 3], ['window', 1]]);
  assert.equal(one(store, 'SELECT count(*) n FROM runtime_events').n, 6);
  // No longer a candidate once a process is tied to it.
  assert.deepEqual(store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION }), []);
}));

test('divergence() and descendants() give the dashboard its proposed-vs-observed rows', () => withStore((store) => {
  captureDemo(store);
  const candidate = observeDemo(store);
  const [row] = store.divergence(['e1']);
  assert.equal(row.call_id, 'call_1');
  assert.equal(row.outcome, 'as_proposed');
  assert.equal(row.status, 'completed');
  assert.equal(row.exit_code, 0);
  assert.equal(row.pid, 108);
  assert.equal(row.match_basis, 'window');
  assert.equal(row.tier, 'corroborated');
  assert.equal(row.window_start_ms, candidate.window_start);
  assert.deepEqual(row.argv, ['/bin/bash', '-c', 'cd /workspace/demo-hook && npm test']);
  assert.equal(row.descendant_count, 3);
  assert.equal(row.reported_check, 'agrees', 'the agent reported exit 0 in 0.3 s; the sandbox saw exit 0 in 0.3 s');

  const children = store.descendants(['e1']);
  assert.deepEqual(children.map((c) => c.argv.join(' ')), ['sh -c node scripts/prepare.js', 'node scripts/prepare.js', 'rm -f notes/todo.md']);
  assert.deepEqual(children.map((c) => c.status), ['running', 'running', 'completed']);
  assert.ok(children.every((c) => c.parent_call_id === 'call_1'));
}));

test('an unobserved call reads as not executed, never as failed', () => withStore((store) => {
  captureDemo(store);
  const [row] = store.divergence(['e1']);
  assert.equal(row.outcome, 'not_executed');
  assert.equal(row.status, null);
  assert.equal(row.pid, null);
}));

test('reported_check records disagreement whichever side arrives first', () => withStore((store) => {
  // The agent claims exit 0; the sandbox saw exit 1.
  captureDemo(store, { reported: HEADER(0, 0.3) });
  observeDemo(store, { exitCode: 1 });
  const [row] = store.divergence(['e1']);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'exit 1');
  assert.equal(row.reported_check, 'exit_code_differs');
}));

test('attributionsForProcesses marks own, inherited and unattributed processes by pid + start time', () => withStore((store) => {
  captureDemo(store);
  observeDemo(store);
  store.recordProcessStart({ containerId: CONTAINER, raw: exec(9, 230, 1, ['git', 'status'], '5000', Date.now()), startedMs: Date.now() });
  const byPid = Object.fromEntries(store.attributionsForProcesses({ containerId: CONTAINER, pids: [108, 127, 230, 999] }).map((r) => [r.pid, r]));
  assert.equal(byPid[108].call_id, 'call_1');
  assert.equal(byPid[108].match_basis, 'window');
  assert.equal(byPid[127].parent_call_id, 'call_1');
  assert.deepEqual([byPid[230].call_id, byPid[230].parent_call_id, byPid[230].tier], [null, null, 'unverified']);
  assert.equal(byPid[999], undefined);
}));

test('replayed events are no-ops, and a reused pid is a different process', () => withStore((store) => {
  const raw = exec(1, 50, 1, ['ls'], '100', 1000);
  const first = store.recordProcessStart({ containerId: CONTAINER, raw, startedMs: 1000 });
  const again = store.recordProcessStart({ containerId: CONTAINER, raw, startedMs: 1000 });
  assert.deepEqual(first, again);
  store.recordProcessStart({ containerId: CONTAINER, raw: exec(2, 50, 1, ['pwd'], '900', 2000), startedMs: 2000 });
  assert.equal(one(store, 'SELECT count(*) n FROM runtime_processes WHERE pid = 50').n, 2);
  assert.equal(one(store, 'SELECT count(*) n FROM runtime_events').n, 2);
  // An exit for a process that never exec'd leaves no row.
  assert.equal(store.recordProcessExit({ containerId: CONTAINER, raw: exit(3, 77, '1', 0, 3000), exit_code: 0 }), false);
}));

test('lost evidence marks open processes unknown, and a later real exit still closes them', () => withStore((store) => {
  store.recordProcessStart({ containerId: CONTAINER, raw: exec(1, 50, 1, ['sleep', '300'], '100', 1000), startedMs: 1000 });
  store.recordProcessStart({ containerId: CONTAINER, raw: exec(2, 51, 1, ['true'], '110', 1000), startedMs: 1000 });
  store.recordProcessExit({ containerId: CONTAINER, raw: exit(3, 51, '110', 0, 1100), exit_code: 0 });
  assert.equal(store.loseOpenProcesses({ containerId: CONTAINER, reason: 'collector disconnected', raw: { event_id: 4, kind: 'collector_disconnected', container_id: CONTAINER } }), 1);
  assert.equal(one(store, 'SELECT evidence_lost FROM runtime_processes WHERE pid = 50').evidence_lost, 'collector disconnected');
  assert.equal(one(store, 'SELECT evidence_lost FROM runtime_processes WHERE pid = 51').evidence_lost, null);
  assert.equal(store.recordProcessExit({ containerId: CONTAINER, raw: exit(5, 50, '100', 0, 9000), exit_code: 0 }), true);
  assert.equal(one(store, 'SELECT evidence_lost FROM runtime_processes WHERE pid = 50').evidence_lost, null);
}));

test('a failed execve reads as exec failed on its process', () => withStore((store) => {
  const raw = { event_id: 1, kind: 'exec_failed', pid: 60, ppid: 1, argv: ['./script.sh'], errno: 13, container_id: CONTAINER, process_start_ns: '10', timestamp_ns: '20' };
  store.recordProcessStart({ containerId: CONTAINER, raw, startedMs: 1 });
  const [row] = store.db.prepare(`SELECT p.id FROM runtime_processes p`).all();
  assert.ok(row);
  // Surfaced through the descendant reader when attributed.
  captureDemo(store);
  const [candidate] = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION });
  store.attribute({ toolCallId: candidate.call_id, eventId: `gvisor:${CONTAINER}:1`, method: 'inherited' });
  const [child] = store.descendants(['e1']);
  assert.deepEqual([child.status, child.error], ['failed', 'exec failed: errno 13']);
}));

test('auxiliary features round trip', () => withStore((store) => {
  store.saveExperiment({ id: 'x1', created_at: new Date().toISOString(), status: 'completed', exchange_id: 'e1', model: 'm' });
  assert.equal(store.loadExperiments()[0].id, 'x1');
  store.putExplanation('k', { a: 1 }); assert.deepEqual(store.getExplanation('k'), { a: 1 });
  store.putSummary('s', 'e1', { text: 'hi' }); assert.deepEqual(store.getSummary('s'), { text: 'hi' }); assert.deepEqual(store.summaryForSpan('e1'), { text: 'hi' });
  store.putCommandDescription('ls -la', 'listed files'); assert.equal(store.getCommandDescription('ls -la'), 'listed files');
  store.recordProxyError({ trace_id: 't', timestamp: new Date().toISOString(), provider: 'p', route: '/r', error: 'boom', cause: { code: 'X' } });
  assert.equal(one(store, 'SELECT count(*) n FROM proxy_errors').n, 1);
  assert.equal(store.stats().exchanges, 0);
}));

test('reopening an existing evidence database keeps its rows; an old-format one is refused untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raytace-evidence-reopen-'));
  try {
    const file = join(dir, 'evidence.db');
    let store = openEvidenceStore(file); captureDemo(store); store.close();
    store = openEvidenceStore(file); assert.equal(store.stats().exchanges, 3); store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const oldFile = join(dir, 'old.db');
    const old = new DatabaseSync(oldFile); old.exec('CREATE TABLE exchanges (span_id TEXT); PRAGMA user_version = 8'); old.close();
    assert.throws(() => openEvidenceStore(oldFile), /schema version|Incompatible/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('five user turns stay five turns while tool continuations share their turn', () => withStore((store) => {
  const history = [ENV];
  for (let i = 0; i < 5; i++) {
    history.push({ role: 'user', content: [{ type: 'input_text', text: 'same prompt' }] });
    store.recordExchange(exchange(`turn-${i}`, structuredClone(history), [{ type: 'function_call', call_id: `c${i}`, name: 'read_file', arguments: '{}' }]));
    history.push({ type: 'function_call', call_id: `c${i}`, name: 'read_file' }, { type: 'function_call_output', call_id: `c${i}`, output: 'file' });
    store.recordExchange(exchange(`tool-${i}`, structuredClone(history), []));
  }
  const rows = store.exchangeRows({});
  assert.equal(new Set(rows.map((r) => r.trace_id)).size, 5, 'the same words asked again are a new turn');
  for (let i = 0; i < 5; i++) assert.equal(rows[i * 2].trace_id, rows[i * 2 + 1].trace_id);
  assert.deepEqual(all(store, 'SELECT sequence_number FROM agent_turns ORDER BY sequence_number').map((t) => t.sequence_number), [0, 1, 2, 3, 4]);
}));

test('catch-up jobs open no turn, so they never become the visible session', () => withStore((store) => {
  const recap = 'Write a brief catch-up for a user returning to this Codex task. In at most 40 words explain the objective. Recent conversation: User: Read package.json';
  store.recordExchange(exchange('actual', [{ role: 'user', content: 'Read package.json' }], [], { session: 'rtp-' + 'a'.repeat(32) }));
  store.recordExchange(exchange('recap', [{ role: 'user', content: recap }], [], { session: 'rtp-' + 'b'.repeat(32) }));
  assert.deepEqual(store.exchangeRows({}).map((r) => r.promptTitle), ['Read package.json']);
  assert.equal(one(store, "SELECT turn_id FROM agent_exchanges WHERE id = 'recap'").turn_id, null);
}));

test('a process that re-execs shows the command that was matched, not its setup exec', () => withStore((store) => {
  captureDemo(store);
  const [candidate] = store.candidatesInWindow(0, Number.MAX_SAFE_INTEGER, { sessionId: SESSION });
  const t = candidate.window_start + 100;
  // Codex's environment setup runs first in the same pid, then re-execs into the command.
  store.recordProcessStart({ containerId: CONTAINER, raw: exec(1, 240, 151, ['/bin/bash', '-c', '__CODEX_SNAPSHOT_OVERRIDE_SET_0=…'], '7000', t), startedMs: t });
  const matched = store.recordProcessStart({ containerId: CONTAINER, raw: exec(2, 240, 151, ['/bin/bash', '-c', 'cd /workspace/demo-hook && npm test'], '7000', t + 5), startedMs: t + 5 });
  store.attribute({ toolCallId: candidate.call_id, eventId: matched.eventId, method: 'window', score: 1 });
  assert.equal(one(store, 'SELECT count(*) n FROM runtime_processes WHERE pid = 240').n, 1, 'one process, two execs');
  assert.deepEqual(store.divergence(['e1'])[0].argv, ['/bin/bash', '-c', 'cd /workspace/demo-hook && npm test']);
}));
