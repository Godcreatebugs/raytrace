import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripBoilerplate, excerpt, compactExchange, summaryRequest, parseSummary } from './summaries.mjs';

test('stripBoilerplate removes timestamps, pid/hostname lines and ANSI codes', () => {
  const raw = 'pid: 4821\nhostname: worker-3\n2026-09-10T12:00:00.123Z started\n\x1b[32mok\x1b[0m\nreal output line';
  const stripped = stripBoilerplate(raw);
  assert.ok(!stripped.includes('pid:'));
  assert.ok(!stripped.includes('hostname:'));
  assert.ok(!stripped.includes('2026-09-10T12:00:00'));
  assert.ok(!stripped.includes('\x1b['));
  assert.ok(stripped.includes('real output line'));
});

test('excerpt keeps content under budget and prioritizes error lines', () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i} did something fine`).join('\n');
  const withError = `${long}\nTraceback: something broke here\n${long}`;
  const bounded = excerpt(withError, 200);
  assert.ok(bounded.length <= 220); // a little slack for the error-only path
  assert.ok(bounded.includes('Traceback'));
});

test('excerpt falls back to head+tail when there is no error', () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const bounded = excerpt(long, 100);
  assert.ok(bounded.length <= 110);
  assert.ok(bounded.startsWith('line 0'));
  assert.ok(bounded.includes('line 199') || bounded.includes('…'));
});

test('compactExchange pulls the decision label and the latest tool result only', () => {
  const entry = {
    payload: { model: 'gpt', input: [
      { role: 'user', type: 'message', content: 'do the thing' },
      { type: 'function_call_output', call_id: 'c1', output: 'pid: 100\nold result' },
      { type: 'function_call_output', call_id: 'c2', output: 'pid: 200\nfresh result: build succeeded' },
    ] },
    response: { status: 'completed', output: [{ type: 'message', content: 'Done.' }] },
  };
  const compacted = compactExchange(entry, 'ex1');
  assert.equal(compacted.decision.label, 'Text answer');
  assert.ok(compacted.latest_result.excerpt.includes('fresh result'));
  assert.ok(!compacted.latest_result.excerpt.includes('pid:'));
  assert.ok(!compacted.latest_result.excerpt.includes('old result'));
});

test('summaryRequest stays within the combined token budget and produces a stable cache key', () => {
  const hugeOutput = 'x'.repeat(20000);
  const entry = {
    payload: { model: 'gpt', input: [
      { type: 'function_call_output', call_id: 'c1', output: hugeOutput },
    ] },
    response: { status: 'completed', output: [{ type: 'message', content: 'ok' }] },
  };
  const { key, payload } = summaryRequest(entry, 'ex1', 'openai/gpt-oss-120b');
  assert.ok(payload.input.length <= 1400 + 50); // MAX_INPUT_CHARS with small slack
  assert.equal(payload.max_output_tokens, 300);
  assert.deepEqual(payload.reasoning, { effort: 'low' });
  const again = summaryRequest(entry, 'ex1', 'openai/gpt-oss-120b');
  assert.equal(key, again.key); // deterministic for identical compacted input+model
});

test('parseSummary requires a completed response with text', () => {
  assert.throws(() => parseSummary({ status: 'incomplete' }), /incomplete/);
  assert.throws(() => parseSummary({ status: 'completed', output: [] }), /no text/);
  const result = parseSummary({ status: 'completed', output: [{ type: 'message', content: 'It ran the build and it passed.' }], usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(result.text, 'It ran the build and it passed.');
  assert.equal(result.generated, true);
});
