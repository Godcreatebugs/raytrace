// Small, dependency-free helpers over TraceEvent shared between the timeline
// (app/page.tsx) and the graph view (app/trace-graph.tsx), so "did this
// exchange fail" is computed identically in both places instead of drifting.
import { type TraceEvent } from './types';

export function isCompletion(event: TraceEvent) { return event.title.startsWith('Exchange complete'); }

export function completionFailed(event: TraceEvent) {
  if (!isCompletion(event)) return false;
  const status = Number(event.title.split('·')[1]?.trim());
  try { const data = JSON.parse(event.raw); if (['failed', 'incomplete', 'cancelled'].includes(data.response_status)) return true; } catch { /* older capture */ }
  return !Number.isFinite(status) || status < 200 || status >= 300;
}

export function isAction(event: TraceEvent) { return event.title !== 'Context assembled' && (!isCompletion(event) || completionFailed(event)); }

export function lastActionIndex(events: TraceEvent[]) { for (let i = events.length - 1; i >= 0; i--) if (isAction(events[i])) return i; return -1; }
