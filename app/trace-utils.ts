// Small, dependency-free helpers over TraceEvent shared between the timeline
// (app/page.tsx) and the graph view (app/trace-graph.tsx), so "did this
// exchange fail" is computed identically in both places instead of drifting.
import { type TraceBlock, type TraceEvent } from './types';
import { type RequestMetric } from './request-metrics';

export function isCompletion(event: TraceEvent) { return event.title.startsWith('Exchange complete'); }

export function completionFailed(event: TraceEvent) {
  if (!isCompletion(event)) return false;
  const status = Number(event.title.split('·')[1]?.trim());
  try { const data = JSON.parse(event.raw); if (['failed', 'incomplete', 'cancelled'].includes(data.response_status)) return true; } catch { /* older capture */ }
  return !Number.isFinite(status) || status < 200 || status >= 300;
}

export function isAction(event: TraceEvent) { return event.title !== 'Context assembled' && (!isCompletion(event) || completionFailed(event)); }

export function lastActionIndex(events: TraceEvent[]) { for (let i = events.length - 1; i >= 0; i--) if (isAction(events[i])) return i; return -1; }

/** One block per model request: the flat event list split at each "Context
 * assembled" event. Shared by the tool-calls view and the graph view. */
export function buildBlocks(events: TraceEvent[]): TraceBlock[] {
  const blocks: TraceBlock[] = [];
  for (const [index, event] of events.entries()) {
    if (event.title === 'Context assembled') {
      let exchangeId = `request-${index}`;
      try { exchangeId = JSON.parse(event.raw).exchange_id || exchangeId; } catch { /* older capture */ }
      blocks.push({ exchangeId, number: blocks.length + 1, items: [] });
      continue;
    }
    const block = blocks[blocks.length - 1];
    if (!block) continue;
    if (isCompletion(event) && !block.completion) block.completion = event;
    if (isAction(event)) block.items.push({ event, index });
  }
  return blocks;
}

/** Total of one request metric, or null when no request reported it. */
export function sumMetric(requests: RequestMetric[] | undefined, key: 'cost' | 'durationMs' | 'input' | 'output'): number | null {
  const known = (requests ?? []).filter((request) => request[key] !== null);
  return known.length ? known.reduce((sum, request) => sum + request[key]!, 0) : null;
}

/** First request start to last response end, in ms. */
export function turnSpan(requests: RequestMetric[] | undefined): number | null {
  const starts = (requests ?? []).map((request) => Date.parse(request.startedAt));
  const ends = (requests ?? []).map((request) => Date.parse(request.completedAt || ''));
  return starts.length && [...starts, ...ends].every(Number.isFinite) ? Math.max(...ends) - Math.min(...starts) : null;
}

/** The trace's time window for the sandbox query, with a second of slack each
 * side: a process can start just before a request is logged. */
export function turnWindow(requests: RequestMetric[] | undefined): { since?: number; until?: number } {
  const times = (requests ?? []).flatMap((r) => [Date.parse(r.startedAt), r.completedAt ? Date.parse(r.completedAt) : NaN]).filter(Number.isFinite);
  return times.length ? { since: Math.min(...times) - 1000, until: Math.max(...times) + 1000 } : {};
}

/** What the agent's runner said happened to one call, read from the tool
 * result it sent back. Codex writes "Process exited with code N" or, when its
 * sandbox policy refused the command, "exec_command failed: … Rejected(". */
export type Reported = { state: 'ok' | 'failed' | 'rejected' | 'none'; code: number | null; output: string };
export function reportedResult(events: TraceEvent[], callId: string): Reported {
  const event = events.find((item) => {
    if (!item.title.startsWith('Tool result:')) return false;
    try { return JSON.parse(item.raw).call_id === callId; } catch { return false; }
  });
  if (!event) return { state: 'none', code: null, output: '' };
  let output = '';
  try { const raw = JSON.parse(event.raw); output = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output ?? ''); } catch { /* unreadable */ }
  if (/Rejected\(/.test(output)) return { state: 'rejected', code: null, output };
  const code = Number(output.match(/Process exited with code (\d+)/)?.[1] ?? NaN);
  if (Number.isFinite(code)) return { state: code === 0 ? 'ok' : 'failed', code, output };
  return { state: /failed/i.test(output.slice(0, 80)) ? 'failed' : 'ok', code: null, output };
}
