import test from 'node:test';
import assert from 'node:assert/strict';
import { providerConfig, routeRequest, openrouterModels } from './providers.mjs';
import { codexArgs } from './codex-config.mjs';

const config = providerConfig({ RAYTACE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'router-test' });
const request = { method: 'POST', url: '/v1/responses', headers: { authorization: 'Bearer native-secret', 'openai-organization': 'private-org', 'x-api-key': 'private-key' } };
const body = (model, extra = {}) => Buffer.from(JSON.stringify({ model, input: [], ...extra }));

test('all aliases and IDs route to the configured model with isolated credentials', () => {
  for (const [alias, id] of Object.entries(openrouterModels)) for (const model of [alias, id]) {
    const routed = routeRequest(config, request, body(model));
    assert.equal(routed.payload.model, id);
    assert.equal(routed.url, 'https://openrouter.ai/api/v1/responses');
    assert.deepEqual(routed.headers, { 'content-type': 'application/json', authorization: 'Bearer router-test' });
    assert.equal(JSON.parse(routed.body).model, id);
  }
  assert.equal(routeRequest(config, request, body('native-model')).payload.model, openrouterModels.coder);
  const chat = routeRequest(config, { ...request, url: '/v1/chat/completions' }, body('flash', { messages: [] }));
  assert.equal(chat.payload.model, openrouterModels.flash);
});

test('disabled configuration preserves native requests and Anthropic stays native', () => {
  const native = providerConfig({ OPENROUTER_API_KEY: 'unused', RAYTACE_OPENROUTER_MODEL: 'flash' });
  const input = body('native-model');
  const routed = routeRequest(native, request, input);
  assert.equal(routed.provider, 'openai');
  assert.equal(routed.body, input);
  assert.equal(routed.headers.authorization, 'Bearer native-secret');
  assert.equal(routeRequest(config, { ...request, url: '/v1/messages' }, input).provider, 'anthropic');
});

test('invalid configuration and incompatible requests fail without provider fallback', () => {
  assert.throws(() => providerConfig({ RAYTACE_PROVIDER: 'openrouter' }), /OPENROUTER_API_KEY/);
  assert.throws(() => providerConfig({ RAYTACE_PROVIDER: 'typo' }), /native or openrouter/);
  assert.throws(() => routeRequest(config, request, body('unlisted/expensive-model')), /not in/);
  assert.throws(() => routeRequest(config, request, Buffer.from('invalid')), /JSON object/);
  assert.throws(() => routeRequest(config, { ...request, url: '/v1/responses/compact' }, body('coder')), /supports POST/);
  for (const extra of [{ store: true }, { previous_response_id: 'old' }, { conversation: 'old' }]) {
    assert.throws(() => routeRequest(config, request, body('coder', extra)), /full conversation/);
  }
});

test('custom model catalogs replace defaults and support aliases and full IDs', () => {
  const custom = providerConfig({ RAYTACE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test',
    RAYTACE_OPENROUTER_MODELS: '{"x":"example/model-x","y":"example/model-y"}' });
  assert.equal(custom.defaultModel, 'example/model-x');
  for (const model of ['y', 'example/model-y']) {
    assert.equal(routeRequest(custom, request, body(model)).payload.model, 'example/model-y');
  }
  assert.throws(() => routeRequest(custom, request, body(openrouterModels.coder)), /not in/);
  for (const catalog of ['invalid', '[]', '{}', 'null', '{"x":42}', '{"x":"missing-provider"}', '{"bad alias":"a/b"}']) {
    assert.throws(() => providerConfig({ RAYTACE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test', RAYTACE_OPENROUTER_MODELS: catalog }), /RAYTACE_OPENROUTER_MODELS/);
  }
  assert.throws(() => providerConfig({ RAYTACE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test',
    RAYTACE_OPENROUTER_MODELS: '{"x":"example/model-x"}', RAYTACE_OPENROUTER_MODEL: 'coder' }), /configured alias/);
  assert.equal(providerConfig({ RAYTACE_OPENROUTER_MODELS: 'invalid' }).mode, 'native');
});

test('Codex launcher resolves model flags without injecting duplicate model flags', () => {
  for (const flags of [['--model', 'deepseek'], ['-m', 'deepseek'], ['--model=deepseek'], ['-m=deepseek']]) {
    const args = codexArgs(config, ['exec', ...flags, 'Fix login']);
    assert.equal(args.filter((arg) => arg === '-m' || arg === '--model').length, 1);
    assert.ok(args.includes(openrouterModels.deepseek));
    assert.equal(args.at(-1), 'Fix login');
  }
  assert.throws(() => codexArgs(config, ['--model', 'typo']), /not in/);
  assert.throws(() => codexArgs(config, ['--model']), /not in/);
  assert.deepEqual(codexArgs(config, ['--', '--model=literal-prompt']).slice(-2), ['--', '--model=literal-prompt']);
  const nativeArgs = ['--model', 'native-model'];
  assert.deepEqual(codexArgs(providerConfig({}), nativeArgs), nativeArgs);
});
