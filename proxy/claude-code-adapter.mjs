/**
 * Claude Code without the proxy: rebuilds each model call from a Claude Code
 * session transcript (~/.claude/projects/<project>/<session>.jsonl) in the
 * shape the proxy records, so the store and dashboard take it unchanged.
 *
 * The transcript is Claude Code's own record, not the wire. Each assistant
 * message carries the API `requestId` it came from, and everything that went
 * into the model's context is written ahead of it: the user's prompt, tool
 * results, and "attachment" lines for what the harness injected (files,
 * environment, skills, the system prompt snapshot). A call's input is that
 * conversation so far; its output is its assistant lines. What Claude Code
 * actually sent can differ (it drops old thinking, renders attachments its
 * own way), so rows are marked `source: claude-code-transcript`.
 *
 * Items are translated to the Responses shape the rest of RayTrace reads:
 * tool_use -> function_call, tool_result -> function_call_output, text ->
 * message, harness injections -> developer messages, the system prompt ->
 * `instructions`.
 *
 * The transcript format is internal to Claude Code and not a stable API:
 * unknown line and attachment types are skipped, never guessed at.
 */
import { createHash } from 'node:crypto';

// Attachments that are account data or bookkeeping, not model context.
const SKIPPED_ATTACHMENTS = new Set(['session_context', 'credential_org', 'remote_session_change', 'deferred_tools_record',
  'thinking_drop', 'prompt_snapshot']);

// USD per million tokens (Anthropic first-party rates). Cache writes bill at
// 1.25x input for a 5-minute entry and 2x for a 1-hour one; cache reads at
// each model's own rate. Fast mode doubles every rate. Longest prefix wins.
const PRICES = [
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
].sort((a, b) => b[0].length - a[0].length);

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const toMs = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };

/** A stable UUID-shaped id, so re-reading a transcript never records a call twice. */
function stableId(...parts) {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Estimated USD for one call's usage, or null for a model not in the table. */
export function estimateCost(model, usage) {
  const price = PRICES.find(([prefix]) => String(model ?? '').startsWith(prefix))?.[1];
  if (!price || !usage) return null;
  const writes = usage.cache_creation;
  const write1h = writes ? num(writes.ephemeral_1h_input_tokens) : 0;
  const write5m = writes ? num(writes.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens);
  const dollars = num(usage.input_tokens) * price.input + write5m * price.input * 1.25 + write1h * price.input * 2
    + num(usage.cache_read_input_tokens) * price.cacheRead + num(usage.output_tokens) * price.output;
  return (dollars / 1_000_000) * (usage.speed === 'fast' ? 2 : 1);
}

/** Token counts and estimated cost in the dashboard's metric shape. `input`
 * counts every prompt token, cached or not, as OpenRouter reports it. */
export function claudeCodeMetrics(model, usage, startedMs, completedMs) {
  if (!usage) return { input: null, output: null, cost: null, durationMs: null };
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  return {
    input: num(usage.input_tokens) + cacheRead + cacheWrite,
    output: num(usage.output_tokens),
    cacheRead, cacheWrite,
    cost: estimateCost(model, usage),
    costEstimated: true,
    // From transcript timestamps: the last user or tool-result line to the
    // answer. Approximate (includes harness time), not the API's latency.
    durationMs: Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : null,
  };
}

const textParts = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : '');

// A slash command's own output and markers are harness text, not a prompt.
const HARNESS_TEXT = /^\s*<(local-command-|command-name|command-message|command-args|system-reminder)/;

function toolOutput(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : '')).join('\n');
  return JSON.stringify(content ?? '');
}

/** One user line -> Responses items. */
function userItems(line) {
  const content = line.message?.content;
  const items = [];
  const text = textParts(Array.isArray(content) ? content.filter((part) => part?.type !== 'tool_result') : content).trim();
  if (text) {
    const injected = line.isMeta || line.isCompactSummary || HARNESS_TEXT.test(text);
    items.push({ type: 'message', role: injected ? 'developer' : 'user', content: [{ type: 'input_text', text }] });
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type !== 'tool_result') continue;
      items.push({ type: 'function_call_output', call_id: part.tool_use_id, output: toolOutput(part.content), ...(part.is_error ? { is_error: true } : {}) });
    }
  }
  return items;
}

/** One attachment line -> a developer message, or null when it is not context. */
function attachmentItem(attachment) {
  const kind = attachment?.type;
  if (!kind || SKIPPED_ATTACHMENTS.has(kind)) return null;
  let text;
  if (kind === 'file') {
    const file = attachment.content?.file;
    text = `File ${attachment.displayPath ?? attachment.filename ?? ''}:\n${file?.content ?? textParts(attachment.content) ?? ''}`;
  } else if (kind === 'compact_file_reference') {
    text = `Read before the conversation was compacted: ${attachment.displayPath ?? attachment.filename ?? ''}`;
  } else if (typeof attachment.text === 'string') text = attachment.text;
  else if (typeof attachment.content === 'string') text = attachment.content;
  else if (Array.isArray(attachment.addedBlocks)) text = attachment.addedBlocks.join('\n\n');
  else if (Array.isArray(attachment.addedLines)) text = attachment.addedLines.join('\n');
  else if (attachment.snapshot && typeof attachment.snapshot === 'object') text = JSON.stringify(attachment.snapshot, null, 2);
  else return null;
  if (!text?.trim()) return null;
  return { type: 'message', role: 'developer', content: [{ type: 'input_text', text: `<claude-code:${kind}>\n${text}` }] };
}

/** One assistant content block -> a Responses output item, or null. */
function outputItem(block, messageId, index) {
  if (block?.type === 'text' && block.text) return { type: 'message', role: 'assistant', id: `${messageId}-${index}`, status: 'completed', content: [{ type: 'output_text', text: block.text }] };
  if (block?.type === 'tool_use') return { type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), status: 'completed' };
  if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return { type: 'reasoning', summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [] };
  return null;
}

/** Parses JSONL text; a partial last line (still being written) is dropped. */
export function parseTranscript(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { /* partial or corrupt line */ }
  }
  return lines;
}

/**
 * Transcript lines -> proxy-shaped `model.exchange` rows, oldest first.
 *
 * Claude Code starts a tool while the answer is still streaming, so one
 * call's assistant lines can have that tool's result written between them.
 * A call is therefore every assistant line with its requestId up to the next
 * call's first line, and it is complete once that next call exists, or when
 * `final` (the session stopped): a call is never recorded half-written.
 * Subagent (sidechain) lines are left out.
 *
 * `sessionId` / `sessionStartedAt` file the rows under another session than
 * the transcript's own (a sandbox's rtp- id, so its evidence joins them).
 */
export function exchangesFromTranscript(lines, { final = false, version = null, sessionId: filedUnder = null, sessionStartedAt = null } = {}) {
  const main = lines.filter((line) => !line.isSidechain);
  const transcriptSession = main.find((line) => line.sessionId)?.sessionId ?? null;
  const sessionId = filedUnder ?? transcriptSession;
  const sessionStarted = sessionStartedAt ?? main.find((line) => line.timestamp)?.timestamp ?? null;
  const callOf = (line) => (line?.type === 'assistant' && line.message ? line.requestId ?? line.message.id : null);
  const grouped = new Set(); // indexes already emitted as part of an earlier line's call
  const rows = [];
  let conversation = [];
  let instructions = null;
  let lastWrittenMs = null;

  for (let i = 0; i < main.length; i++) {
    if (grouped.has(i)) continue;
    const line = main[i];
    if (line.type === 'system' && line.subtype === 'compact_boundary') { conversation = []; continue; }
    if (line.type === 'attachment') {
      const attachment = line.attachment;
      if (attachment?.type === 'prompt_snapshot' && Array.isArray(attachment.systemPrompt)) instructions = attachment.systemPrompt.join('\n\n');
      const item = attachmentItem(attachment);
      // Attachments are stamped when flushed, often with the answer itself,
      // so they do not move the call's start time.
      if (item) conversation.push(item);
      continue;
    }
    if (line.type === 'user') {
      conversation.push(...userItems(line));
      lastWrittenMs = toMs(line.timestamp) ?? lastWrittenMs;
      continue;
    }
    if (line.type !== 'assistant' || !line.message) continue;

    // One API call: its assistant lines up to the next call's first line.
    // Lines between them (tool results, attachments) are read after it.
    const requestId = callOf(line);
    let next = i + 1;
    const members = [i];
    for (; next < main.length; next++) {
      const call = callOf(main[next]);
      if (call === requestId) members.push(next);
      else if (call) break;
    }
    if (!final && next === main.length) break;
    for (const index of members) grouped.add(index);
    const group = members.map((index) => main[index]);

    const last = group.at(-1).message;
    const output = group.flatMap((entry, index) => (entry.message.content ?? []).map((block, part) => outputItem(block, entry.message.id, `${index}.${part}`))).filter(Boolean);
    const model = last.model ?? null;
    const startedMs = lastWrittenMs ?? toMs(line.timestamp);
    const completedMs = toMs(group.at(-1).timestamp) ?? startedMs;
    rows.push({
      event_type: 'model.exchange',
      session_id: sessionId, session_started_at: sessionStarted,
      trace_id: stableId('trace', transcriptSession, requestId),
      span_id: stableId('claude-code', transcriptSession, requestId),
      parent_span_id: null,
      timestamp: new Date(startedMs ?? Date.now()).toISOString(),
      completed_at: new Date(completedMs ?? Date.now()).toISOString(),
      provider: 'claude-code',
      route: '/claude-code/v1/messages', method: 'POST',
      metrics: claudeCodeMetrics(model, last.usage, startedMs, completedMs),
      source: { kind: 'claude-code-transcript', version: group.at(-1).version ?? version, request_id: requestId },
      request: { headers: null, bytes: null, sha256: null,
        payload: { model, ...(instructions ? { instructions } : {}), input: structuredClone(conversation) } },
      response: { status: 200, headers: null, bytes: null, sha256: null,
        payload: { id: last.id, model, status: 'completed', stop_reason: last.stop_reason ?? null, output, usage: last.usage ?? null } },
    });
    conversation.push(...output.filter((item) => item.type !== 'reasoning'));
    lastWrittenMs = completedMs;
  }
  return rows;
}
