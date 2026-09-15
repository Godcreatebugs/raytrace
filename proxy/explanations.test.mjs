import test from 'node:test';
import assert from 'node:assert/strict';
import { explanationRequest, parseExplanations } from './explanations.mjs';
const sources = [{ evidence_id: 'a', text: 'transaction.js defines returnPayment()' }];
const hypothesis = { evidence_id: 'a', title: 'The search identified the payment implementation', explanation: 'This earlier search result identifies a file relevant to the task.', excerpt: 'transaction.js defines returnPayment()' };
const response = (hypotheses) => ({ status: 'completed', output: [{ type: 'message', content: [{ text: JSON.stringify({ hypotheses }) }] }] });
test('explanations require valid source IDs and exact quotes and remove duplicate titles', () => {
  const result = parseExplanations(response([hypothesis, hypothesis, { ...hypothesis, title: 'Invented', excerpt: 'not in source' }, { ...hypothesis, title: 'Wrong source', evidence_id: 'b' }]), sources);
  assert.equal(result.hypotheses.length, 1);
  assert.equal(result.reported_cost, null);
  assert.deepEqual(parseExplanations(response([]), sources).hypotheses, []);
  assert.throws(() => parseExplanations({ status: 'incomplete' }, sources), /incomplete/);
});
test('request is bounded and cache key changes with configured model', () => {
  const step = { decision: { label: 'read transaction.js' }, hypotheses: [], evidence: Array.from({length: 30}, (_, i) => ({ id: String(i), kind: 'user', content: 'x'.repeat(10000) })) };
  const a = explanationRequest(step, 'a/model'); const b = explanationRequest(step, 'b/model');
  assert.notEqual(a.key, b.key);
  assert.ok(a.sources.reduce((sum, item) => sum + item.text.length, 0) <= 16000);
  assert.equal(a.payload.model, 'a/model'); assert.equal(a.payload.tools, undefined);
});
