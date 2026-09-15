'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Braces, ChevronRight, FileCode2, FlaskConical, GitBranch, MessagesSquare, Search, TerminalSquare, Waypoints, Workflow } from 'lucide-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { type ContextItem, type Origin, type Snapshot, type Trace, type SummaryState, type TraceBlock } from './types';

import { DecisionLab } from './decision-lab';
import { RequestMetrics, money, duration, count as tokenCount } from './request-metrics';
import { RunComparison } from './run-comparison';
import { TraceGraph } from './trace-graph';
import { RuntimeEvidence } from './runtime-evidence';
import { isCompletion, completionFailed, isAction, lastActionIndex } from './trace-utils';

const PROXY_BASE = 'http://127.0.0.1:8797';
const icons = { model: Braces, search: Search, read: FileCode2, edit: GitBranch, test: TerminalSquare };


export default function Home() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [traceId, setTraceId] = useState('');
  const [selected, setSelected] = useState(0);
  const [connected, setConnected] = useState(false);
  const [jumpNotice, setJumpNotice] = useState('');
  const [openBlocks, setOpenBlocks] = useState<Record<string, boolean>>({});
  // Two top-level destinations: browsing captured prompts/traces, or the
  // Counterfactual Lab for whichever step was last selected while browsing.
  const [view, setView] = useState<'prompts' | 'lab' | 'graph'>('prompts');
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch('http://127.0.0.1:8797/raytace/traces');
        if (!response.ok) throw new Error('Proxy unavailable');
        const data = await response.json() as { traces: Trace[] };
        if (!closed) { setTraces(data.traces || []); setConnected(true); setTraceId((id) => data.traces?.some((trace) => trace.id === id) ? id : data.traces?.[0]?.id || ''); }
      } catch { if (!closed) setConnected(false); }
      if (!closed) timer = setTimeout(load, 2500);
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, []);
  // Summarize each model request in the open trace, several at once (the proxy
  // runs up to MAX_CONCURRENT_SUMMARIES concurrently), from cache first so
  // revisiting a trace never re-spends. Switching traces cancels in-flight work
  // for the old one via cancelledRef, which the effect below resets per trace.
  const cancelledRef = useRef(false);
  const summarizeOne = useCallback(async (id: string, { force = false } = {}) => {
    if (!force) {
      let alreadyDone = false;
      setSummaries((prev) => { if (prev[id]) { alreadyDone = true; return prev; } return { ...prev, [id]: { status: 'loading' } }; });
      if (alreadyDone) return;
    } else {
      setSummaries((prev) => ({ ...prev, [id]: { status: 'loading' } }));
    }
    try {
      const cachedResponse = await fetch(`${PROXY_BASE}/raytace/summaries/${id}`);
      const cached = cachedResponse.ok ? await cachedResponse.json() as { summary: { text: string } | null } : null;
      if (cancelledRef.current) return;
      if (cached?.summary?.text) { setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: cached.summary!.text } })); return; }
    } catch { /* fall through to generate */ }
    // 409 ("too many in flight") retries fast; a real network/HTTP failure gets a
    // few backed-off retries too instead of giving up after one flaky attempt —
    // that's what could silently drop a summary before (a single transient
    // failure looked identical to never having tried at all).
    let hardFailures = 0;
    for (let attempt = 0; !cancelledRef.current && attempt < 8 && hardFailures < 3; attempt += 1) {
      try {
        const response = await fetch(`${PROXY_BASE}/raytace/summaries`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' },
          body: JSON.stringify({ exchange_id: id }),
        });
        if (response.status === 409) { await new Promise((resolve) => setTimeout(resolve, 400)); continue; }
        const data = await response.json() as { text?: string; error?: string };
        if (cancelledRef.current) return;
        if (!response.ok || !data.text) { hardFailures += 1; await new Promise((resolve) => setTimeout(resolve, 600 * hardFailures)); continue; }
        setSummaries((prev) => ({ ...prev, [id]: { status: 'ready', text: data.text! } })); return;
      } catch {
        if (cancelledRef.current) return;
        hardFailures += 1; await new Promise((resolve) => setTimeout(resolve, 600 * hardFailures));
      }
    }
    if (!cancelledRef.current) setSummaries((prev) => ({ ...prev, [id]: { status: 'error' } }));
  }, []);
  useEffect(() => {
    if (!traceId) return;
    cancelledRef.current = false;
    // Small worker pool: several cheap, budget-capped summary calls run at once
    // instead of one at a time, so a 10-step trace fills in over a couple of
    // seconds rather than serially. Matches the proxy's own concurrency cap.
    const CONCURRENCY = 4;
    const run = async () => {
      const current = traces.find((item) => item.id === traceId);
      const requests = current?.requests || [];
      let cursor = 0;
      const worker = async () => { while (!cancelledRef.current && cursor < requests.length) { const id = requests[cursor].id; cursor += 1; await summarizeOne(id); } };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    };
    void run();
    return () => { cancelledRef.current = true; };
  }, [traceId, traces, summarizeOne]);
  const trace = traces.find((item) => item.id === traceId);
  const events = trace?.events || [];
  const actualIndex = events[selected] && isAction(events[selected]) ? selected : lastActionIndex(events);
  const current = events[actualIndex];
  const actionCount = events.filter(isAction).length;
  const context = (current?.exchange_id ? events.find((item) => {
    if (item.title !== 'Context assembled') return false;
    try { return JSON.parse(item.raw).exchange_id === current.exchange_id; } catch { return false; }
  }) : undefined) || events.slice(0, actualIndex + 1).findLast((item) => item.title === 'Context assembled');
  let snapshot: Snapshot | null = null;
  try { snapshot = context ? JSON.parse(context.raw) : null; } catch { /* older incompatible capture */ }
  const contextItems = (trace?.evidence || []).filter((item) => item.exchange_id === snapshot?.exchange_id);
  const Icon = current ? icons[current.kind] : Braces;
  function jumpToOrigin(origin: Origin) {
    const target = traces.find((item) => item.id === origin.trace_id);
    if (!target) { setJumpNotice(`"${origin.name}" was proposed outside the ${traces.length} most recently captured traces; only recent history stays loaded.`); return; }
    setJumpNotice(''); setTraceId(target.id);
    const index = target.events.findIndex((item) => { if (item.title !== 'Context assembled') return false; try { return (JSON.parse(item.raw) as { exchange_id?: string }).exchange_id === origin.exchange_id; } catch { return false; } });
    const actionIndex = target.events.findIndex((item, position) => position > index && isAction(item));
    setSelected(actionIndex >= 0 ? actionIndex : 0);
  }
  function originTimestamp(origin: Origin): number | null {
    const target = traces.find((item) => item.id === origin.trace_id);
    return target ? new Date(target.startedAt).getTime() : null;
  }
  // "45m ago" reads faster than a clock time when comparing steps that might
  // be minutes, hours, or days apart within the same long-running session.
  function relativeTime(ms: number | null): string {
    if (ms == null) return 'not in currently loaded history';
    const diffMs = Date.now() - ms;
    const mins = Math.round(diffMs / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }
  // Condense the request's context into a readable decision graph: the user's ask,
  // the last few tool results that fed this request, and the decision it produced.
  const userAsk = contextItems.findLast((item) => item.kind === 'user' && !item.preview.trimStart().startsWith('<environment_context>'));
  const toolResults = contextItems.filter((item) => item.source_call);
  const shownResults = toolResults.slice(-8);
  const collapsedCount = toolResults.length - shownResults.length;
  function nodeWhy(item: ContextItem): string {
    const action = item.action || 'ran a tool call';
    const status = item.succeeded === false ? ' — failed' : '';
    return action.charAt(0).toUpperCase() + action.slice(1) + status;
  }
  // Real ground truth (Codex's own execution log, correlated by call_id) vs.
  // the older regex-on-result-text heuristic. `verified` is only ever set by
  // the backend once real data exists for that call_id — see readTraces()'s
  // divergence-overlay step in raytace-proxy.mjs.
  function verifyBadge(item: ContextItem): { label: string; title: string; kind: 'kernel' | 'exact' | 'fuzzy' | 'unconfirmed' | 'heuristic' } | null {
    if (item.verified === true) {
      // Strongest tier: the layer that mediated the syscall (gVisor in the
      // sandbox, or the bpftrace sidecar in container mode) saw this program
      // start. Proves it ran, not that its output or the answer is correct.
      if (item.kernel_confirmed) {
        const running = item.real_status === 'running';
        return { label: running ? 'Sandbox: running' : 'Sandbox-verified', title: running
          ? 'gVisor saw this command start inside the sandbox; it has not exited yet, so success/failure is not known.'
          : 'gVisor observed this command start (and exit) inside the sandbox, independent of agent logs. Proves it ran, not that its output is correct.', kind: 'kernel' };
      }
      if (item.match_basis === 'id') return { label: 'Agent-log match', title: 'Exact call ID match in agent logs, not independent runtime confirmation.', kind: 'exact' };
      return { label: 'Agent-log match', title: 'Command-text match in agent logs, not independent runtime confirmation.', kind: 'fuzzy' };
    }
    if (item.verified === false) {
      return { label: 'Unverified', title: 'No matching agent-log entry. This does not prove non-execution.', kind: 'unconfirmed' };
    }
    return null; // no real execution data correlated for this trace/call yet — still the old text-heuristic only
  }
  function nodeOutput(item: ContextItem): string {
    const line = item.preview.split('\n').find((part) => part.trim().length > 2 && !/^Script (completed|failed)|^Wall time|^Output:|^Process (exited|completed|failed)\b/i.test(part.trim()));
    return line ? line.trim().slice(0, 100) : '';
  }
  // Group the flat event list into one block per model request, so the timeline
  // can collapse everything but the block a person is actually looking at instead
  // of always rendering the trace's whole history top to bottom.
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
  // Which "Model request #" a piece of evidence actually came from, so the
  // Decision Chain can say so explicitly instead of leaving a person to
  // notice a stray timestamp and work it out themselves.
  const blockNumberByExchangeId = new Map(blocks.map((block) => [block.exchangeId, block.number]));
  const currentBlockNumber = snapshot ? blockNumberByExchangeId.get(snapshot.exchange_id) : undefined;
  function turnInfo(item: ContextItem): { label: string; kind: 'fresh' | 'carried'; requestNumber: number | null } | null {
    if (!item.origin) return null;
    const originBlockNumber = blockNumberByExchangeId.get(item.origin.exchange_id) ?? null;
    if (originBlockNumber != null && currentBlockNumber != null && originBlockNumber === currentBlockNumber - 1) {
      return { label: 'This turn', kind: 'fresh', requestNumber: originBlockNumber };
    }
    return { label: originBlockNumber != null ? `Carried from request #${originBlockNumber}` : 'Carried from an earlier request', kind: 'carried', requestNumber: originBlockNumber };
  }
  return <main className={`app-shell view-${view}`}>
    <aside className="nav"><div className="brand"><Waypoints size={22} /> RayTrace</div>
      <nav className="nav-destinations">
        <button type="button" className={`nav-item ${view === 'prompts' || view === 'graph' ? 'active' : ''}`} onClick={() => setView('prompts')}><MessagesSquare size={16}/> Prompts</button>
        <button type="button" className={`nav-item ${view === 'lab' ? 'active' : ''}`} onClick={() => setView('lab')}><FlaskConical size={16}/> Lab experiments{!current && <small>Select a step first</small>}</button>
      </nav>
      {(view === 'prompts' || view === 'graph') && <>
        <label htmlFor="trace-picker" className="workspace-label">CAPTURED REQUESTS</label>
        <NativeSelect id="trace-picker" className="trace-picker" value={trace?.id || ''} onChange={(event) => { setTraceId(event.target.value); setSelected(0); }}><NativeSelectOption value="">Choose a captured trace</NativeSelectOption>{traces.map((item) => <NativeSelectOption key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleTimeString()} · {item.title.slice(0,70)}</NativeSelectOption>)}</NativeSelect>
        <p className="nav-help">Choose a prompt, then select a proposed tool call or answer to explore it.</p>
        {jumpNotice && <p className="nav-help" role="alert">{jumpNotice}</p>}
        <div className="nav-bottom">{traces.length} recent traces</div>
      </>}
      {view === 'lab' && current && <p className="nav-help">Exploring: <strong>{current.title}</strong></p>}
    </aside>
    {(view === 'prompts' || view === 'graph') && <section className="trace-column"><header className="topbar"><div><span className="eyebrow">{trace ? `TRACE / ${trace.id.slice(0,12)}` : 'LIVE CAPTURE'}</span><h1>{trace ? trace.title.length > 150 ? `${trace.title.slice(0, 150)}…` : trace.title : 'Select a captured request'}</h1>{trace && trace.title.length > 150 && <details className="prompt-details"><summary>Show full user prompt</summary><p>{trace.title}</p></details>}</div><div className={`status ${connected ? '' : 'offline'}`}><i />{connected ? 'CONNECTED' : 'PROXY OFFLINE'}</div></header>
      <div className="trace-meta"><span>{trace?.provider || '—'}</span><span>{trace?.model || 'Awaiting capture'}</span><span>{actionCount} steps</span></div>
      <div className="compare-entry"><RunComparison traces={traces} currentId={traceId}/>{trace && <button type="button" className={`visualize-button ${view === 'graph' ? 'active' : ''}`} onClick={() => setView(view === 'graph' ? 'prompts' : 'graph')}><Workflow size={14}/> {view === 'graph' ? 'Back to timeline' : 'Visualize'}</button>}</div>
      <RequestMetrics requests={trace?.requests}/>
      {trace && <RuntimeEvidence key={trace.id} sandboxId={trace.sandboxId}/>}
      {view === 'graph' && trace && <TraceGraph trace={trace} blocks={blocks} summaries={summaries} onSelectStep={(index) => { setSelected(index); setView('prompts'); }}/>}
      {view === 'prompts' && <><div className="timeline-head"><span>OBSERVED EXECUTION SEQUENCE</span></div>
      <div className="timeline">{blocks.length ? blocks.map((block, blockPosition) => {
        const containsSelection = block.items.some((item) => item.index === actualIndex);
        // An explicit user choice (expand or collapse) always wins, even for the
        // block holding the current selection or the newest block — otherwise a
        // block containing the selected step could never be collapsed.
        const explicitChoice = openBlocks[block.exchangeId];
        const isOpen = explicitChoice ?? (containsSelection || blockPosition === blocks.length - 1);
        return <Fragment key={block.exchangeId}>
          {(() => {
            const summary = summaries[block.exchangeId];
            const metric = trace?.requests?.find((request) => request.id === block.exchangeId);
            const titleState = summary?.status === 'loading' ? 'loading' : summary?.status === 'error' ? 'error' : '';
            const titleText = summary?.status === 'ready' ? summary.text
              : summary?.status === 'loading' ? 'Summarizing…'
              : summary?.status === 'error' ? 'Summary unavailable.'
              : `Model request ${block.number}`;
            const failed = block.completion ? completionFailed(block.completion) : null;
            return <button type="button" className="request-divider" aria-expanded={isOpen}
              onClick={() => setOpenBlocks((prev) => ({ ...prev, [block.exchangeId]: !isOpen }))}
            >
              <div className="request-divider-left">
                <ChevronRight size={16} style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform .15s', flexShrink: 0 }}/>
                <div className="request-divider-text">
                  <strong className={`request-divider-title ${titleState}`}>{titleText}</strong>
                  <span className="request-divider-sub">Model request {block.number}{!isOpen && ` · ${block.items.length} step${block.items.length === 1 ? '' : 's'}`}</span>
                </div>
              </div>
              {metric && <div className="request-divider-metrics">
                <span className="metric-cost">{money(metric.cost)}</span>
                <span className="metric-duration">{duration(metric.durationMs)}</span>
              </div>}
              <div className="request-divider-right">
                {summary?.status === 'error' && <button type="button" className="retry-summary"
                  onClick={(clickEvent) => { clickEvent.stopPropagation(); void summarizeOne(block.exchangeId, { force: true }); }}>Retry summary</button>}
                <small className={failed === null ? '' : failed ? 'status-fail' : 'status-ok'}>{failed === null ? 'No completion recorded' : failed ? 'Failed' : 'Success'}</small>
              </div>
            </button>;
          })()}
          {isOpen && (() => {
            const metric = trace?.requests?.find((request) => request.id === block.exchangeId);
            if (!metric) return null;
            return <dl className="request-inline-metrics">
              <div><dt>Duration</dt><dd>{duration(metric.durationMs)}</dd></div>
              <div><dt>Input tokens</dt><dd>{tokenCount(metric.input)}</dd></div>
              <div><dt>Output tokens</dt><dd>{tokenCount(metric.output)}</dd></div>
              <div><dt>Cost · USD</dt><dd>{money(metric.cost)}</dd></div>
              <div><dt>Model</dt><dd>{metric.model}</dd></div>
            </dl>;
          })()}
          {isOpen && block.items.length > 0 && <div className="request-children">{block.items.map(({ event, index }) => {
            const EventIcon = icons[event.kind];
            return <Fragment key={`${event.time}-${index}`}><button aria-pressed={actualIndex === index} onClick={() => setSelected(index)} className={`event ${actualIndex === index ? 'selected' : ''}`}><span className={`event-icon ${event.kind}`}><EventIcon size={16}/></span><span className="event-copy"><strong>{isCompletion(event) ? 'Response failed or incomplete' : event.title}</strong><small>{event.detail}</small></span><time dateTime={event.time} title={new Date(event.time).toLocaleString()}>{new Date(event.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}</time><ChevronRight className="event-arrow" size={16}/></button></Fragment>;
          })}</div>}
        </Fragment>;
      }) : <p className="empty-trace">Run the proxy and send a request through it. Saved steps remain readable; experiments need a live snapshot.</p>}</div>
      {current && <section className="decision-card"><div className="card-kicker"><Icon size={15}/> SELECTED STEP</div><h2>{current.title}</h2>
        <details className="raw-details"><summary>Step details and tool call ID</summary><pre>{current.raw}</pre></details>
        {snapshot && <details className="raw-details"><summary>Context before this decision</summary><div className="request-brief"><div className="request-hero"><span className="request-model">{snapshot.model}</span><span className="request-stream">{snapshot.stream ? 'Streaming' : 'Single response'}</span></div><div className="request-grid"><div><small>REASONING</small><strong>{snapshot.reasoning?.effort || 'Model default'}</strong></div><div><small>CONTEXT</small><strong>{snapshot.input_items} items</strong><span>Messages and tool history</span></div><div><small>TOOLS</small><strong>{snapshot.tool_count} available</strong></div></div><details><summary>Request metadata</summary><pre>{context?.raw}</pre></details></div></details>}
        {snapshot && <div className="chain-graph"><div className="card-kicker chain-kicker">DECISION CHAIN<span>{shownResults.length ? `last ${shownResults.length} of ${toolResults.length} steps` : 'no tool steps'}</span></div>
          <p className="chain-note">What fed this decision, condensed.</p>
          <details className="raw-details"><summary>How this is measured</summary><p className="chain-note">Descriptions are observed facts about each step; use the lab to measure whether a step actually influenced the decision.</p></details>
          <ol className="chain-graph-list">
            {userAsk && <li className="chain-node user"><span className="chain-dot"/><div><strong>User asked</strong><p>{userAsk.preview.slice(0, 120)}</p></div></li>}
            {collapsedCount > 0 && <li className="chain-node collapsed"><span className="chain-dot"/><div><p>{collapsedCount} earlier tool steps collapsed — they remain testable in the lab.</p></div></li>}
            {shownResults.map((item) => { const output = nodeOutput(item); const badge = verifyBadge(item); return <li key={item.id} className={`chain-node ${item.succeeded === false ? 'failed' : ''}`}><span className="chain-dot"/><div><div className="chain-node-head"><strong>{nodeWhy(item)}</strong>{badge && <span className={`verify-badge verify-${badge.kind}`} title={badge.title}>{badge.label}</span>}{typeof item.match_score === 'number' && <span className="chain-node-score" title={`Match basis: ${item.match_basis === 'id' ? 'exact call ID' : 'command text similarity'}`}>{item.match_score.toFixed(2)}</span>}</div>{output && <p className="chain-output">→ {output}</p>}{item.real_error && <p className="chain-output verify-error">{item.real_error}</p>}{item.origin && (() => { const turn = turnInfo(item); const rel = relativeTime(originTimestamp(item.origin!)); return <button type="button" className={`link-button turn-link ${turn?.kind === 'carried' ? 'turn-carried' : 'turn-fresh'}`} onClick={() => jumpToOrigin(item.origin!)} title="Jump to the request that originally proposed this call">{turn ? `${turn.label} · ${rel}` : `Open the exchange that proposed this (${rel})`}</button>; })()}</div></li>; })}
            <li className="chain-node decision"><span className="chain-dot"/><div><strong>Decision</strong><p>{snapshot.decision?.label || 'No completed decision captured for this exchange.'}</p>{snapshot.decision?.text && <details className="raw-details decision-details"><summary>Show full answer</summary><p className="chain-output decision-answer">{snapshot.decision.text}</p></details>}</div></li>
          </ol>
        </div>}
      </section>}</>}
    </section>}
    {view === 'lab' && <DecisionLab key={`${current?.exchange_id}-${current?.output_index}-${current?.title}`} selected={current}/>}
  </main>;
}
