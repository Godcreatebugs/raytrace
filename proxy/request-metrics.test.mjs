import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMetrics } from './request-metrics.mjs';
const row = usage => ({ provider: 'openrouter', timestamp: '2026-09-10T00:00:00Z', completed_at: '2026-09-10T00:00:02Z', response: { payload: { usage } } });
test('normalizes provider usage, preserving free responses', () => {
  assert.deepEqual(requestMetrics(row({ input_tokens: 100, output_tokens: 20, cost: 0 })), { input: 100, output: 20, cost: 0, durationMs: 2000 });
  assert.equal(requestMetrics(row({ prompt_tokens: 50, completion_tokens: 10, cost: .01 })).input, 50);
});
test('unknown and previously redacted values never become zero', () => {
  assert.deepEqual(requestMetrics({}), { input: null, output: null, cost: null, durationMs: null });
  assert.equal(requestMetrics(row({ input_tokens: '[REDACTED]' })).input, null);
  assert.equal(requestMetrics({ ...row({ cost: 5 }), provider: 'openai' }).cost, null);
});
test('uses terminal streaming usage rather than summing cumulative frames', () => {
  const data = row({}); data.response.payload = { events: [{ usage: { prompt_tokens: 1 } }, { usage: { prompt_tokens: 10, cost: .2 } }] };
  assert.equal(requestMetrics(data).input, 10);
  data.response.payload = { events: [{ response: { usage: { input_tokens: 15 } } }] };
  assert.equal(requestMetrics(data).input, 15);
});
