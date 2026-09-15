import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, evidenceFor, makeVariant, matchesTarget, outcome, replayEligibility, runExperiment, summarize, validateTarget, wilson } from './experiment-engine.mjs';

const response = (name = 'read_file', args = '{"path":"auth.ts"}') => ({ status: 'completed', output: [{ type: 'function_call', name, arguments: args }] });
const entry = () => ({ provider: 'openai', route: '/v1/responses', payload: { model: 'fixture-model', stream: true, reasoning: { effort: 'medium' }, tools: [{ type: 'function', name: 'read_file' }], input: [
  { type: 'message', role: 'user', content: 'Search found auth.ts' },
  { type: 'function_call', name: 'read_file', call_id: 'call-1', arguments: '{"path":"auth.ts"}' },
  { type: 'function_call_output', call_id: 'call-1', output: 'session validator' },
  { type: 'message', role: 'user', content: 'Fix the login bug.' },
] }, response: response() });
const config = (overrides = {}) => ({ exchange_id: 'capture', evidence_id: 'capture:0', repetitions: 5, target: { type: 'original_action' }, ...overrides });

test('withholding output preserves call/result pairing and original request', () => {
  const source = entry(); const before = structuredClone(source.payload);
  const evidence = evidenceFor(source.payload, 'capture').find((item) => item.index === 2);
  const changed = makeVariant(source.payload, evidence);
  assert.equal(changed.input[2].output, ''); assert.equal(changed.input[2].call_id, 'call-1');
  assert.equal(changed.input.length, 4); assert.equal(evidence.source_call.name, 'read_file');
  assert.deepEqual(source.payload, before);
  assert.equal(makeVariant(source.payload, evidenceFor(source.payload, 'capture')[0]).input.length, 3);
});

test('Wilson intervals are bounded and remain uncertain at zero/all successes', () => {
  assert.equal(wilson(0,0), null);
  assert.ok(wilson(0,20)[1] > .16 && wilson(0,20)[1] < .162);
  assert.ok(wilson(20,20)[0] > .838 && wilson(20,20)[0] < .84);
  assert.ok(wilson(16,20)[0] < .59 && wilson(16,20)[1] > .91);
});

test('16/20 vs 5/20 yields 55 percentage points and a positive difference interval', () => {
  const trials = ['baseline','intervention'].flatMap((arm) => Array.from({length:20}, (_, i) => ({ arm, status:'succeeded', matches: i < (arm === 'baseline' ? 16 : 5), outcome: {key:'call',label:'read_file'} })));
  trials.push({ arm:'baseline', status:'failed' });
  const summary = summarize(trials);
  assert.equal(summary.baseline.rate, .8); assert.equal(summary.intervention.rate, .25);
  assert.equal(summary.baseline.failed, 1); assert.equal(summary.baseline.successful, 20);
  assert.ok(Math.abs(summary.effect.difference - .55) < 1e-10);
  assert.ok(summary.effect.interval[0] > 0);
  assert.equal(summarize([]).effect, null);
});

test('same tool with different file arguments differs; canonical JSON key order does not', () => {
  const recorded = outcome(response('read_file', '{"path":"auth.ts","start":1}'));
  const target = validateTarget({type:'original_action'}, recorded);
  assert.equal(matchesTarget(outcome(response('read_file','{"start":1,"path":"auth.ts"}')), target), true);
  assert.equal(matchesTarget(outcome(response('read_file','{"path":"billing.ts"}')), target), false);
  assert.equal(matchesTarget(outcome(response()), {type:'tool_contains',name:'read_file',contains:'auth.ts'}), true);
  const answer = outcome({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'The session is valid'}]}]});
  assert.equal(matchesTarget(answer, {type:'answer_contains',contains:'SESSION'}), true);
  assert.throws(() => outcome({status:'incomplete',output:[]}), /incomplete/);
  assert.throws(() => outcome({status:'completed',output:[]}), /No observable/);
});

test('reject unsupported/stateful/hosted tool snapshots and invalid trial budgets', () => {
  const source = entry();
  assert.equal(replayEligibility(source), null);
  assert.match(replayEligibility({...source, provider:'anthropic'}), /Responses/);
  source.payload.previous_response_id = 'resp_old'; assert.match(replayEligibility(source), /server-side/); delete source.payload.previous_response_id;
  source.payload.tools.push({type:'web_search'}); assert.match(replayEligibility(source), /server-executed/);
  assert.throws(() => createExperiment(entry(), config({repetitions:21})), /2–20/);
  assert.throws(() => createExperiment(entry(), config({evidence_id:'wrong:0'})), /exact request/);
});

test('repeated trials invoke both arms and never use the recorded response as a trial', async () => {
  const source = entry(); const original = structuredClone(source.payload); const job = createExperiment(source, config());
  let count = 0;
  await runExperiment(job, source, { random: () => .2, invoke: async (payload) => {
    count++; assert.equal(payload.stream,true); assert.deepEqual(payload.reasoning,{effort:'medium'});
    return payload.input.some((item)=>item.content === 'Search found auth.ts') ? response() : response('search', '{}');
  }});
  assert.equal(count,10); assert.equal(job.status,'completed'); assert.equal(job.summary.baseline.hits,5);
  assert.equal(job.summary.intervention.hits,0); assert.deepEqual(source.payload,original);
  assert.notEqual(job.snapshot_hash,job.variant_hash);
});

test('cancellation and provider errors stop future paid requests and preserve partial counts', async () => {
  const source = entry(); const job = createExperiment(source, config()); const controller = new AbortController();
  await runExperiment(job,source,{signal:controller.signal,invoke:async()=>response(),onUpdate:async()=>{if(job.trials.length===1)controller.abort();}});
  assert.equal(job.status,'cancelled'); assert.equal(job.trials.length,1);
  const failed = createExperiment(source,config());
  await runExperiment(failed,source,{random:()=>0,invoke:async()=>{throw new Error('provider failed');}});
  assert.equal(failed.status,'failed'); assert.equal(failed.trials.length,1);
  assert.equal(failed.summary.baseline.failed,1); assert.equal(failed.summary.baseline.rate,null);
});
