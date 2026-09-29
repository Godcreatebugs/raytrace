'use client';

// Prompts: what was asked and what came back. Everything about how the agent
// got there lives in Tool calls and Sandbox, one click away.
import { useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { type Trace } from './types';
import { ActivityGraph, dayKey } from './activity-graph';
import { money } from './request-metrics';
import { sumMetric } from './trace-utils';

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '(empty prompt)';

export function PromptsView({ traces, selectedId, onSelect, onOpen }: {
  traces: Trace[];
  selectedId: string;
  onSelect: (traceId: string) => void;
  onOpen: (view: 'calls' | 'sandbox' | 'lab', traceId: string) => void;
}) {
  const [day, setDay] = useState<string | null>(null);
  const shown = traces.filter((trace) => !day || dayKey(trace.startedAt) === day)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return <section className="rt-view">
    <header className="rt-view-head"><div><span className="eyebrow">PROMPTS</span><h1>What you asked</h1></div></header>
    <ActivityGraph dates={traces.map((trace) => trace.startedAt)} selected={day} onSelect={setDay} />
    <div className="rt-list-head">
      {day
        ? <button type="button" className="rt-chip" onClick={() => setDay(null)}>
            {new Date(`${day}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} <X size={12} />
          </button>
        : <span>Recent</span>}
      <small>{shown.length} prompt{shown.length === 1 ? '' : 's'}</small>
    </div>
    {!shown.length && <p className="rt-empty">No prompts captured yet. Send a request through the proxy and it will appear here.</p>}
    <ol className="rt-prompts">
      {shown.map((trace) => {
        const open = trace.id === selectedId;
        const cost = sumMetric(trace.requests, 'cost');
        const calls = trace.callVerifications?.length ?? 0;
        return <li key={trace.id} className={open ? 'rt-prompt open' : 'rt-prompt'}>
          <button type="button" className="rt-prompt-row" aria-expanded={open} onClick={() => onSelect(open ? '' : trace.id)}>
            <time dateTime={trace.startedAt}>{new Date(trace.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time>
            <strong>{firstLine(trace.title)}</strong>
            <small>{trace.model} · {calls} tool call{calls === 1 ? '' : 's'} · {money(cost, trace.requests?.some((r) => r.costEstimated))}</small>
          </button>
          {open && <div className="rt-prompt-detail">
            <h3>Prompt</h3>
            <p className="rt-text">{trace.title}</p>
            <h3>Answer</h3>
            {trace.answer ? <p className="rt-text">{trace.answer}</p> : <p className="rt-muted">No final answer was captured for this prompt.</p>}
            <div className="rt-actions">
              <button type="button" className="rt-button" onClick={() => onOpen('calls', trace.id)}>Tool calls <ArrowRight size={14} /></button>
              {trace.sandboxId && <button type="button" className="rt-button" onClick={() => onOpen('sandbox', trace.id)}>Sandbox evidence <ArrowRight size={14} /></button>}
              <button type="button" className="rt-button" onClick={() => onOpen('lab', trace.id)}>Lab <ArrowRight size={14} /></button>
            </div>
          </div>}
        </li>;
      })}
    </ol>
  </section>;
}
