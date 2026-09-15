import { selectModel } from './providers.mjs';
import { randomUUID } from 'node:crypto';

export function codexArgs(config, args, port = '8797', host = '127.0.0.1') {
  if (config.mode !== 'openrouter') return args;
  const forwarded = [];
  let hasModel = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { forwarded.push(...args.slice(i)); break; }
    if (arg === '-m' || arg === '--model') {
      hasModel = true;
      forwarded.push(arg, selectModel(config, args[++i]));
    } else if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      hasModel = true;
      forwarded.push('--model', selectModel(config, arg.slice(arg.indexOf('=') + 1)));
    } else {
      forwarded.push(arg);
    }
  }
  return [
    '-c', 'model_provider="raytace_openrouter"',
    '-c', 'model_providers.raytace_openrouter.name="OpenRouter via RayTrace"',
    '-c', 'model_providers.raytace_openrouter.wire_api="responses"',
    '-c', 'model_providers.raytace_openrouter.requires_openai_auth=false',
    '-c', `model_providers.raytace_openrouter.http_headers={ "x-raytace-session-id" = "${randomUUID()}", "x-raytace-session-started-at" = "${new Date().toISOString()}" }`,
    '-c', `model_providers.raytace_openrouter.base_url=${JSON.stringify(`http://${host}:${port}/v1`)}`,
    ...(hasModel ? [] : ['-m', config.defaultModel]),
    ...forwarded,
  ];
}
