import { createHash } from 'node:crypto';

export function latestSessionRows(rows) {
  const sessions = rows.filter((row) => row.session_id && row.session_started_at);
  const latest = sessions.reduce((best, row) => !best || row.session_started_at > best.session_started_at ? row : best, null);
  return latest ? rows.filter((row) => row.session_id === latest.session_id) : [];
}

function textOf(item) {
  const content = item?.content ?? item?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  return '';
}

function isBackgroundPrompt(text) {
  return (text.startsWith('Generate a concise, single-line task title') && text.includes('User prompt:')) ||
    (text.startsWith('Write a brief catch-up for a user returning to this Codex task.') && text.includes('Recent conversation:'));
}

export function promptInfo(payload) {
  const input = payload?.input ?? payload?.messages;
  if (typeof input === 'string') return !input.trim() || isBackgroundPrompt(input.trim()) ? null : { title: input.trim(), prefix: input, continuation: false };
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]?.role !== 'user') continue;
    const text = textOf(input[i]).trim();
    if (!text || /^<(environment_context|permissions instructions|INSTRUCTIONS)>/i.test(text) || /^# AGENTS\.md instructions/i.test(text)) continue;
    // Codex sends its background title-generation job as a user message too.
    if (isBackgroundPrompt(text)) return null;
    const title = text.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/g, '').replace(/^## My request:\s*/, '').trim();
    if (!title) continue;
    return { title, prefix: JSON.stringify(input.slice(0, i + 1)), continuation: i < input.length - 1 };
  }
  return null;
}

export function groupPromptExchanges(rows) {
  const active = new Map();
  const result = [];
  for (const row of [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const prompt = promptInfo(row.request?.payload);
    if (!prompt) continue;
    const key = createHash('sha256').update(JSON.stringify([row.session_id, row.provider, row.request?.payload?.model, prompt.prefix])).digest('hex');
    const traceId = prompt.continuation && active.has(key) ? active.get(key) : row.span_id;
    active.set(key, traceId);
    result.push({ ...row, trace_id: traceId, promptTitle: prompt.title });
  }
  return result;
}
