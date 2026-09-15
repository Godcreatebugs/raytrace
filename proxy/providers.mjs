// Edit this shortlist to change the models available through OpenRouter.
export const openrouterModels = Object.freeze({
  coder: 'qwen/qwen3-coder',
  deepseek: 'deepseek/deepseek-v3.2',
  oss: 'openai/gpt-oss-120b',
  flash: 'google/gemini-2.5-flash-lite',
});

function configuredModels(value) {
  if (!value) return openrouterModels;
  let models;
  try { models = JSON.parse(value); } catch { throw new Error('RAYTACE_OPENROUTER_MODELS must be a JSON object mapping aliases to model IDs.'); }
  if (!models || typeof models !== 'object' || Array.isArray(models) || !Object.keys(models).length ||
      Object.entries(models).some(([alias, id]) => !/^[a-zA-Z0-9_-]+$/.test(alias) ||
        typeof id !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(id))) {
    throw new Error('RAYTACE_OPENROUTER_MODELS requires at least one alias mapped to a provider/model ID.');
  }
  return Object.freeze(models);
}

export function selectModel(config, requested, { allowNativeDefault = false } = {}) {
  if (Object.hasOwn(config.models, requested)) return config.models[requested];
  if (Object.values(config.models).includes(requested)) return requested;
  if (allowNativeDefault && (requested == null || typeof requested === 'string' && !requested.includes('/'))) return config.defaultModel;
  throw new Error('OpenRouter model is not in the configured model list. Use an alias or full ID from RAYTACE_OPENROUTER_MODELS (or proxy/providers.mjs).');
}

export function providerConfig(env = process.env) {
  const mode = env.RAYTACE_PROVIDER || 'native';
  if (!['native', 'openrouter'].includes(mode)) throw new Error('RAYTACE_PROVIDER must be native or openrouter.');
  const models = mode === 'openrouter' ? configuredModels(env.RAYTACE_OPENROUTER_MODELS) : openrouterModels;
  const model = env.RAYTACE_OPENROUTER_MODEL || Object.keys(models)[0];
  const defaultModel = Object.hasOwn(models, model) ? models[model] : model;
  if (mode === 'openrouter' && !env.OPENROUTER_API_KEY?.trim()) throw new Error('Set OPENROUTER_API_KEY in .env before enabling OpenRouter.');
  if (mode === 'openrouter' && !Object.values(models).includes(defaultModel)) throw new Error('RAYTACE_OPENROUTER_MODEL must be a configured alias or model ID.');
  return { mode, models, defaultModel, apiKey: env.OPENROUTER_API_KEY, upstreams: {
    openai: env.RAYTACE_OPENAI_UPSTREAM || 'https://api.openai.com',
    anthropic: env.RAYTACE_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
    openrouter: (env.RAYTACE_OPENROUTER_UPSTREAM || 'https://openrouter.ai/api').replace(/\/$/, ''),
  } };
}

export function routeRequest(config, req, body) {
  const anthropic = req.headers['anthropic-version'] || req.url?.startsWith('/v1/messages');
  const provider = anthropic ? 'anthropic' : config.mode === 'openrouter' ? 'openrouter' : 'openai';
  let payload = null;
  try { payload = JSON.parse(body); } catch { /* Native non-JSON requests pass through. */ }
  let headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'content-length', 'connection'].includes(key)));
  if (provider === 'openrouter') {
    if (req.method !== 'POST' || !['/v1/responses', '/v1/chat/completions'].includes(req.url)) {
      throw new Error('OpenRouter routing supports POST /v1/responses and /v1/chat/completions only.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OpenRouter requests require a JSON object.');
    if (req.url === '/v1/responses' && (payload.store === true || payload.previous_response_id || payload.conversation)) {
      throw new Error('OpenRouter requires full conversation history with store:false and no previous_response_id or conversation. Start a fresh session.');
    }
    // Native model names use the configured default; explicit aliases/IDs select a model.
    const model = selectModel(config, payload.model, { allowNativeDefault: true });
    payload = { ...payload, model };
    body = Buffer.from(JSON.stringify(payload));
    // Never send the client's OpenAI/ChatGPT credentials or account headers to OpenRouter.
    headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
  }
  return { provider, payload, body, headers, url: `${config.upstreams[provider]}${req.url}` };
}
