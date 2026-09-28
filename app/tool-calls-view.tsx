'use client';

// Tool calls: how the agent got from the prompt to the answer. One divider per
// round trip to the model, one row per tool call it proposed. What actually
// ran is the Sandbox view's job; each row links there.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronRight, FlaskConical, Workflow } from 'lucide-react';
import { type CallVerification, type SummaryState, type Trace } from './types';
import { money, duration, count as tokenCount } from './request-metrics';
import { buildBlocks, completionFailed, reportedResult, sumMetric, turnSpan } from './trace-utils';
import { CommandText, span, parsed } from './execution-table';
import { RunComparison } from './run-comparison';
import { TraceGraph } from './trace-graph';
import { type SelectedStep } from './decision-lab';

const PROXY_BASE = 'http://127.0.0.1:8797';

/** Per-request one-line summaries, cache first. Only runs while this view is
 * open, so browsing prompts never spends on summaries. */
function useSummaries(trace: Trace) {
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const cancelled = useRef(false);
  const summarizeOne = useCallback(async (id: string) => {
    setSummaries((prev) => ({ ...prev, [id]: { status: 'loading' } }));
    try {
      const cached = await fetch(`${PROXY_BASE}/raytace/summaries/${id}`);
      const data = cached.ok ? await cached.json() as { summary: { text: string } | null } : null;
      if (cancelled.current) return;
      if (data?.summary?.text) { setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: data.summary!.text } })); return; }
    } catch { /* fall through to generate */ }
    for (let attempt = 0, failures = 0; !cancelled.current && attempt < 8 && failures < 3; attempt += 1) {
      try {
        const response = await fetch(`${PROXY_BASE}/raytace/summaries`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
          body: JSON.stringify({ exchange_id: id }),
        });
        if (response.status === 409) { await new Promise((resolve) => setTimeout(resolve, 400)); continue; }
        const data = await response.json() as { text?: string };
        if (cancelled.current) return;
        if (response.ok && data.text) { setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: data.text! } })); return; }
      } catch { if (cancelled.current) return; }
      failures += 1; await new Promise((resolve) => setTimeout(resolve, 600 * failures));
    }
    if (!cancelled.current) setSummaries((prev) => ({ ...prev, [id]: { status: 'error' } }));
  }, []);
  const ids = (trace.requests ?? []).map((request) => request.id).join(',');
  useEffect(() => {
    cancelled.current = false;
    const queue = ids ? ids.split(',') : [];
    let cursor = 0;
    const worker = async () => { while (!cancelled.current && cursor < queue.length) { const id = queue[cursor]; cursor += 1; await summarizeOne(id); } };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => { cancelled.current = true; };
  }, [ids, summarizeOne]);
  return summaries;
}

function argumentsOf(trace: Trace, call: CallVerification): string {
  const event = trace.events.find((item) => item.title.startsWith('Tool call:') && item.exchange_id === call.exchange_id && item.output_index === call.output_index);
  if (!event) return '';
  try {
    const raw = JSON.parse(event.raw) as { arguments?: unknown; input?: unknown };
    const args = raw.arguments ?? raw.input ?? '';
    const value = typeof args === 'string' ? JSON.parse(args) : args;
    return JSON.stringify(value, null, 2);
  } catch { return event.detail; }
}

function Sandboxed({ call, rejected, onOpen }: { call: CallVerification; rejected: boolean; onOpen: () => void }) {
  if (call.exec_id) return <button type="button" className="rt-ran ok" title="The sandbox saw this command run. Open it in Sandbox evidence."
    onClick={(event) => { event.stopPropagation(); onOpen(); }}>✓ ran</button>;
  if (rejected) return <span className="rt-ran fail" title="The agent's sandbox policy refused to run this command.">✗ rejected</span>;
  return <span className="rt-ran none" title="No process was observed for this call. Missing evidence is not proof it did not run.">— not seen</span>;
}

export function ToolCallsView({ trace, traces, focusCall, onOpenSandbox, onOpenLab }: {
  trace: Trace;
  traces: Trace[];
  focusCall: string | null;
  onOpenSandbox: (callId?: string) => void;
  onOpenLab: (step: SelectedStep) => void;
}) {
  const [graph, setGraph] = useState(false);
  const [open, setOpen] = useState<string | null>(focusCall);
  const summaries = useSummaries(trace);
  const blocks = buildBlocks(trace.events);
  const calls = trace.callVerifications ?? [];
  const number = new Map(calls.map((call, index) => [call.call_id, index + 1]));
  const requests = trace.requests ?? [];
  const models = [...new Set(requests.map((request) => request.model))];
  const stats: [string, string][] = [
    ['Round trips', String(requests.length)],
    ['Tool calls', String(calls.length)],
    ['Cost', money(sumMetric(requests, 'cost'))],
    ['Time', duration(turnSpan(requests))],
    ['Tokens in / out', `${tokenCount(sumMetric(requests, 'input'))} / ${tokenCount(sumMetric(requests, 'output'))}`],
    [models.length > 1 ? 'Models' : 'Model', models.join(', ') || trace.model],
  ];

  useEffect(() => {
    if (!focusCall) return;
    const frame = requestAnimationFrame(() => document.getElementById(`call-${focusCall}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [focusCall]);

  return <section className="rt-view">
    <header className="rt-view-head">
      <div><span className="eyebrow">TOOL CALLS</span><h1>How the agent got there</h1></div>
      <div className="rt-actions">
        <RunComparison traces={traces} currentId={trace.id} />
        <button type="button" className={`visualize-button ${graph ? 'active' : ''}`} onClick={() => setGraph(!graph)}><Workflow size={14} /> {graph ? 'Back to list' : 'Graph'}</button>
        {trace.sandboxId && <button type="button" className="rt-button" onClick={() => onOpenSandbox()}>Sandbox evidence <ArrowRight size={14} /></button>}
      </div>
    </header>
    <dl className="rt-stats">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>

    {graph ? <TraceGraph trace={trace} blocks={blocks} summaries={summaries} onSelectStep={() => setGraph(false)} /> :
      <div className="rt-table-wrap"><table className="rt-table rt-calls">
        <thead><tr><th>#</th><th>Tool</th><th>Command</th><th>Agent reported</th><th>Sandbox</th><th>Ran for</th></tr></thead>
        <tbody>
          {blocks.map((block) => {
            const metric = requests.find((request) => request.id === block.exchangeId);
            const summary = summaries[block.exchangeId];
            const failed = block.completion ? completionFailed(block.completion) : null;
            const own = calls.filter((call) => call.exchange_id === block.exchangeId);
            const answered = block.items.some(({ event }) => event.title === 'Model answer');
            return <Fragment key={block.exchangeId}>
              <tr className="rt-trip"><td colSpan={6}>
                <span>Round trip {block.number}</span>
                {summary?.status === 'ready' && <em>{summary.text}</em>}
                <small>{metric ? `${money(metric.cost)} · ${duration(metric.durationMs)}` : ''}{failed ? ' · failed' : ''}{answered && !own.length ? ' · answered' : ''}</small>
              </td></tr>
              {own.map((call) => {
                const reported = reportedResult(trace.events, call.call_id);
                const expanded = open === call.call_id;
                const started = parsed(call.started_at); const ended = parsed(call.ended_at);
                const step: SelectedStep = { exchange_id: call.exchange_id, output_index: call.output_index, title: `#${number.get(call.call_id)} ${call.name}`, detail: call.proposed ?? call.name };
                return <Fragment key={call.call_id}>
                  <tr id={`call-${call.call_id}`} className={`rt-row${expanded ? ' open' : ''}${focusCall === call.call_id ? ' rt-focus' : ''}`}
                    onClick={() => setOpen(expanded ? null : call.call_id)}>
                    <td className="rt-num"><ChevronRight size={12} className="rt-caret" />{number.get(call.call_id)}</td>
                    <td className="rt-tool">{call.name}</td>
                    <td className="rt-cmd"><CommandText text={call.proposed || call.name} /></td>
                    <td className={`rt-reported ${reported.state}`}>{reported.state === 'none' ? '—' : reported.state === 'rejected' ? 'rejected' : reported.code != null ? `exit ${reported.code}` : reported.state}</td>
                    <td><Sandboxed call={call} rejected={reported.state === 'rejected'} onOpen={() => onOpenSandbox(call.call_id)} /></td>
                    <td className="rt-time">{Number.isFinite(started) && Number.isFinite(ended) ? span(ended - started) : '—'}</td>
                  </tr>
                  {expanded && <tr className="rt-expand"><td colSpan={6}>
                    <h4>Arguments</h4><pre>{argumentsOf(trace, call)}</pre>
                    <h4>Output the agent got back</h4><pre>{reported.output.trim() || '(no result captured)'}</pre>
                    <div className="rt-actions">
                      {call.exec_id && <button type="button" className="rt-button" onClick={() => onOpenSandbox(call.call_id)}>Show in sandbox <ArrowRight size={14} /></button>}
                      <button type="button" className="rt-button" onClick={() => onOpenLab(step)}><FlaskConical size={14} /> Open in Lab</button>
                    </div>
                  </td></tr>}
                </Fragment>;
              })}
            </Fragment>;
          })}
        </tbody>
      </table></div>}
  </section>;
}
