import test from 'node:test';
import assert from 'node:assert/strict';
import { promptInfo, groupPromptExchanges, latestSessionRows } from './prompt-traces.mjs';

test('only the latest launched session is shown, even when an older session finishes later', () => {
  const rows = [
    { span_id: 'legacy' },
    { session_id: 'old', session_started_at: '2026-09-09T10:00:00Z' },
    { session_id: 'new', session_started_at: '2026-09-09T11:00:00Z' },
    { session_id: 'old', session_started_at: '2026-09-09T10:00:00Z' },
    { session_id: 'new', session_started_at: '2026-09-09T11:00:00Z' },
  ];
  assert.deepEqual(latestSessionRows(rows), [rows[2], rows[4]]);
  assert.equal(rows.length, 5);
  assert.deepEqual(latestSessionRows([rows[0]]), []);
});

const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const context = user('<environment_context>local</environment_context>');
test('labels use actual user text and omit background title jobs and context-only requests', () => {
  assert.equal(promptInfo({ input: [context, user('Whatever I actually typed')] }).title, 'Whatever I actually typed');
  assert.equal(promptInfo({ input: [context] }), null);
  assert.equal(promptInfo({ input: [user('Generate a concise, single-line task title of at most 36 characters\n\nUser prompt:\nhello')] }), null);
  assert.equal(promptInfo({ input: [user('<in-app-browser-context source="ambient">metadata</in-app-browser-context>\n## My request:\nFix this')] }).title, 'Fix this');
});

test('five user turns remain five entries while tool continuations share their turn', () => {
  const rows = []; const history = [context];
  for (let i = 0; i < 5; i++) {
    history.push(user('same prompt'));
    rows.push({ span_id: `turn-${i}`, timestamp: `${i}a`, request: { payload: { input: structuredClone(history) } } });
    history.push({ type: 'function_call', call_id: `${i}`, name: 'read_file' });
    history.push({ type: 'function_call_output', call_id: `${i}`, output: 'file' });
    rows.push({ span_id: `tool-${i}`, timestamp: `${i}b`, request: { payload: { input: structuredClone(history) } } });
  }
  const grouped = groupPromptExchanges(rows.reverse());
  assert.equal(new Set(grouped.map((row) => row.trace_id)).size, 5);
  for (let i = 0; i < 5; i++) assert.equal(grouped[i * 2].trace_id, grouped[i * 2 + 1].trace_id);
});

test('catch-up requests are excluded before selecting the latest visible session', () => {
  const recap = 'Write a brief catch-up for a user returning to this Codex task. In at most 40 words explain the objective. Recent conversation: User: Read package.json';
  assert.equal(promptInfo({ input: [context, user(recap)] }), null);
  assert.equal(promptInfo({ input: recap }), null);
  assert.equal(promptInfo({ input: [user('Explain how catch-up summaries work')] }).title, 'Explain how catch-up summaries work');
  const rows = [
    { span_id: 'actual', session_id: 'a', session_started_at: '2026-09-09T10:00:00Z', timestamp: '2026-09-09T10:01:00Z', request: { payload: { input: [user('Read package.json')] } } },
    { span_id: 'recap', session_id: 'b', session_started_at: '2026-09-09T11:00:00Z', timestamp: '2026-09-09T11:01:00Z', request: { payload: { input: [user(recap)] } } },
  ];
  const visible = latestSessionRows(groupPromptExchanges(rows));
  assert.deepEqual(visible.map(row => row.promptTitle), ['Read package.json']);
});
