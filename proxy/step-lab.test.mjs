import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStep, createStepRun, runDecision, selectedActionMatches } from './step-lab.mjs';
const call = (file) => ({ type: 'function_call', name: 'read_file', arguments: JSON.stringify({ file }) });
const entry = { provider: 'openrouter', route: '/v1/responses', payload: { model: 'a/model', input: [{ role: 'user', content: 'Find returnPayment in transaction.js' }, { type: 'function_call', call_id: '1', name: 'search', arguments: '{}' }, { type: 'function_call_output', call_id: '1', output: 'transaction.js contains returnPayment()' }], tools: [] }, response: { status: 'completed', output: [call('other.js'), call('transaction.js')] } };
const config = { exchange_id: 'e', output_index: 1, evidence_id: 'e:2', context: 'No matches', mode: 'decision', repetitions: 3, max_requests: 2 };

test('selected second call has its own target and prior evidence', () => {
  const step = inspectStep(entry, 'e', 1);
  assert.match(step.decision.label, /transaction.js/);
  assert.equal(step.hypotheses[0].evidence_id, 'e:2');
  assert.match(step.hypotheses[0].title, /transaction.js/);
  assert.equal(selectedActionMatches(entry.response, step.decision), true);
  assert.equal(selectedActionMatches({ status: 'completed', output: [call('other.js')] }, step.decision), false);
  assert.throws(() => inspectStep(entry, 'e', 10), /Select/);
});
test('context editing preserves the original and call IDs; chosen model applies to both arms', async () => {
  const original = structuredClone(entry);
  const { job, baseline, variant } = createStepRun(entry, config, 'b/model');
  assert.equal(variant.input[2].output, 'No matches'); assert.equal(variant.input[2].call_id, '1');
  assert.equal(baseline.model, 'b/model'); assert.equal(variant.model, 'b/model');
  const invoked = [];
  await runDecision(job, baseline, variant, async (payload) => {
    invoked.push(payload);
    return { status: 'completed', output: payload.input[2].output === 'No matches' ? [call('other.js')] : [call('other.js'), call('transaction.js')], usage: { cost: 0.01 } };
  }, new AbortController().signal);
  assert.equal(invoked.length, 6); assert.equal(job.summary.baseline.rate, 1); assert.equal(job.summary.intervention.rate, 0);
  assert.equal(job.status, 'completed'); assert.deepEqual(entry, original);
});
test('reject invalid edits/counts and model-specific cross-model state; cancellation makes no calls', async () => {
  for (const repetitions of [0, 1, 2.5, 21]) assert.throws(() => createStepRun(entry, { ...config, repetitions }, 'a/model'));
  assert.throws(() => createStepRun(entry, { ...config, evidence_id: 'elsewhere' }, 'a/model'));
  const stateful = structuredClone(entry); stateful.payload.input.push({ type: 'reasoning', encrypted_content: 'opaque' });
  assert.throws(() => createStepRun(stateful, config, 'b/model'), /model-specific/);
  const { job, baseline, variant } = createStepRun(entry, config, 'a/model');
  await runDecision(job, baseline, variant, () => { throw new Error('Must not call'); }, AbortSignal.abort());
  assert.equal(job.status, 'cancelled'); assert.equal(job.trials.length, 0);
});
