/**
 * Minimal client for TypeSafe's System One endpoint (the Jev models).
 *
 * Jev is a decision model, not a text model: it takes `state` plus named,
 * typed questions (score / choice / noul) and returns calibrated
 * probabilities. It never writes prose, so nothing here expects any.
 *
 * Plain fetch rather than @typesafe-ai/sdk, matching how the proxy reaches
 * every other provider (invokeReplay), and because the SDK does not install
 * cleanly next to this repo's React peer ranges.
 * API: https://docs.typesafe.ai/api
 */

const DEFAULT_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
// 429 = rate limited, 529 = overloaded: the two statuses the API documents as
// safe to retry with backoff. Everything else is a real error.
const RETRYABLE = new Set([429, 529]);

export function typesafeConfig(env = process.env) {
  const apiKey = env.TYPESAFE_API_KEY?.trim() || null;
  return {
    enabled: Boolean(apiKey),
    apiKey,
    model: env.RAYTACE_TYPESAFE_MODEL?.trim() || DEFAULT_MODEL,
    url: (env.RAYTACE_TYPESAFE_URL || DEFAULT_URL).replace(/\/$/, ''),
  };
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * One System One request. Resolves to `{ model, answers, usage }` exactly as
 * the API returns it; `model` is the concrete version that answered (e.g.
 * jev-1.13.0), which callers should record rather than the alias they sent.
 */
export async function systemOne(config, { state, questions }, { signal, fetchImpl = fetch } = {}) {
  if (!config?.enabled) throw new Error('Set TYPESAFE_API_KEY to enable Jev.');
  const body = JSON.stringify({ model: config.model, state, questions });
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(`${config.url}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) return response.json();
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    lastError = new Error(`TypeSafe ${response.status}${detail ? `: ${detail}` : ''}`);
    lastError.status = response.status;
    if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS) break;
    const retryAfter = Number(response.headers.get('retry-after'));
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1), signal);
  }
  throw lastError;
}
