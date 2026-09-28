import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typesafeConfig, systemOne } from './typesafe.mjs';

const reply = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('disabled without a key; defaults to jev-latest', () => {
  assert.equal(typesafeConfig({}).enabled, false);
  const config = typesafeConfig({ TYPESAFE_API_KEY: ' k ', RAYTACE_TYPESAFE_URL: 'http://x/' });
  assert.deepEqual(config, { enabled: true, apiKey: 'k', model: 'jev-latest', url: 'http://x' });
});

test('sends the documented request shape with a bearer key', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 10 } }); };
  const config = typesafeConfig({ TYPESAFE_API_KEY: 'k' });
  const result = await systemOne(config, { state: { a: 1 }, questions: { q: { type: 'noul', instructions: 'x?' } } }, { fetchImpl });
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'jev-latest', state: { a: 1 }, questions: { q: { type: 'noul', instructions: 'x?' } } });
  assert.equal(result.model, 'jev-1.13.0');
});

test('retries 429 and 529, but not other errors', async () => {
  const config = typesafeConfig({ TYPESAFE_API_KEY: 'k' });
  let calls = 0;
  const flaky = async () => (++calls < 3 ? reply(calls === 1 ? 429 : 529, {}, { 'retry-after': '0.01' }) : reply(200, { answers: {} }));
  await systemOne(config, { state: '', questions: {} }, { fetchImpl: flaky });
  assert.equal(calls, 3);

  calls = 0;
  const invalid = async () => { calls += 1; return reply(422, { detail: 'bad question' }); };
  await assert.rejects(systemOne(config, { state: '', questions: {} }, { fetchImpl: invalid }), (error) => error.status === 422 && /bad question/.test(error.message));
  assert.equal(calls, 1);
});

test('refuses to call without a key', async () => {
  await assert.rejects(systemOne(typesafeConfig({}), { state: '', questions: {} }), /TYPESAFE_API_KEY/);
});
