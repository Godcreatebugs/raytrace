'use client';

// Sandbox evidence: what actually ran for one prompt, as the kernel layer saw
// it. One table in time order. Processes no tool call accounts for sit inline
// where they happened, not in a table of their own.
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { type Trace } from './types';
import { processKey, SeverityChip, useRuntimeEvidence, type Command } from './runtime-evidence';
import { CommandText, OutcomeText, clockTime, nsToMs, plainOutcome, span } from './execution-table';
import { turnWindow } from './trace-utils';

const inOrder = (list: Command[]) => [...list].sort((a, b) => {
  const at = a.started_ns ? BigInt(a.started_ns) : null;
  const bt = b.started_ns ? BigInt(b.started_ns) : null;
  if (at != null && bt != null && at !== bt) return at < bt ? -1 : 1;
  return a.event_id - b.event_id;
});

const outcomeOf = (command: Command) => plainOutcome({ observed: true, status: command.exit_code != null || command.signal ? undefined : 'running', exitCode: command.exit_code, signal: command.signal });

export function SandboxView({ trace, focusCall, onOpenCall }: {
  trace: Trace;
  focusCall: string | null;
  onOpenCall: (callId?: string) => void;
}) {
  const { since, until } = turnWindow(trace.requests);
  const runtime = useRuntimeEvidence(trace.sandboxId, since, until);
  const { data, error, raw, setRaw } = runtime;
  const [open, setOpen] = useState<Set<number>>(new Set());
  const commands = data?.commands ?? [];
  const labels = data?.call_labels ?? {};
  const calls = trace.callVerifications ?? [];
  const number = new Map(calls.map((call, index) => [call.call_id, index + 1]));

  const present = new Set(commands.map((command) => command.event_id));
  const children = new Map<number, Command[]>();
  const roots: Command[] = [];
  for (const command of commands) {
    const parent = command.parent_event_id;
    if (parent == null || !present.has(parent)) { roots.push(command); continue; }
    children.set(parent, [...(children.get(parent) ?? []), command]);
  }
  const ordered = inOrder(roots);
  const outcomes = ordered.map(outcomeOf);
  const bySeverity = [0, 1, 2, 3].map((level) => ordered.filter((command) => command.severity?.level === level).length);
  const [severityFilter, setSeverityFilter] = useState<number | null>(null);
  const shown = severityFilter == null ? ordered : ordered.filter((command) => command.severity?.level === severityFilter);
  const focused = (command: Command) => !!focusCall && command.attribution?.call_id === focusCall;

  const focusTarget = ordered.find(focused);
  const focusKey = focusTarget ? processKey(focusTarget.pid, focusTarget.process_start_ns) : null;
  useEffect(() => {
    if (!focusKey) return;
    const frame = requestAnimationFrame(() => document.getElementById(`proc-${focusKey.replace(':', '-')}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  const toggle = (id: number) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // A plain function, not a component, so re-rendering keeps each row (and an
  // open severity popover) mounted.
  function renderRow(command: Command, depth: number): ReactNode {
    const kids = inOrder(children.get(command.event_id) ?? []);
    const expanded = open.has(command.event_id);
    const outcome = outcomeOf(command);
    const started = nsToMs(command.started_ns); const ended = nsToMs(command.ended_ns);
    const key = processKey(command.pid, command.process_start_ns);
    const callId = command.attribution?.call_id ?? null;
    const parentCall = command.attribution?.parent_call_id ?? null;
    return <Fragment key={command.event_id}>
      <tr id={key ? `proc-${key.replace(':', '-')}` : undefined}
        className={`rt-row${depth ? ' rt-child' : ''}${outcome.tone === 'fail' ? ' failed' : ''}${focused(command) ? ' rt-focus' : ''}`}
        onClick={kids.length ? () => toggle(command.event_id) : undefined}>
        <td className="rt-time">{clockTime(started)}</td>
        <td className="rt-cmd" style={{ paddingLeft: `${8 + depth * 18}px` }}>
          {kids.length ? <ChevronRight size={12} className={`rt-caret${expanded ? ' down' : ''}`} /> : <span className="rt-caret-gap" />}
          <span title={command.command}>{command.description ?? <CommandText text={command.command} />}</span>
          {kids.length > 0 && <small className="rt-muted"> · {kids.length} child{kids.length === 1 ? '' : 'ren'}</small>}
        </td>
        <td className="rt-pid">{command.pid}</td>
        <td className={`exec-${outcome.tone}`}><OutcomeText outcome={outcome} /></td>
        <td className="rt-time">{Number.isFinite(started) && Number.isFinite(ended) ? span(ended - started) : '—'}</td>
        <td>{depth === 0 ? <SeverityChip severity={command.severity} flags={callId ? labels[callId]?.flags : undefined} /> : null}</td>
        <td>{depth > 0 ? null : callId
          ? <button type="button" className="link-button" onClick={(event) => { event.stopPropagation(); onOpenCall(callId); }}>#{number.get(callId) ?? '?'}</button>
          : parentCall ? <span className="rt-muted">under #{number.get(parentCall) ?? '?'}</span>
          : <span className="rt-muted" title="This process ran, but matched no proposed tool call.">no tool call</span>}</td>
      </tr>
      {expanded && kids.map((kid) => renderRow(kid, depth + 1))}
    </Fragment>;
  }

  return <section className="rt-view">
    <header className="rt-view-head">
      <div><span className="eyebrow">SANDBOX EVIDENCE</span><h1>What actually ran</h1></div>
      <div className="rt-actions"><button type="button" className="rt-button" onClick={() => onOpenCall()}><ArrowLeft size={14} /> Tool calls</button></div>
    </header>
    {!trace.sandboxId ? <p className="rt-empty">This prompt did not run in a sandbox, so there is no independent evidence of what ran.</p> : <>
      <dl className="rt-stats">
        <div><dt>Commands</dt><dd>{ordered.length}</dd></div>
        <div><dt>Succeeded</dt><dd className="exec-ok">{outcomes.filter((o) => o.tone === 'ok').length}</dd></div>
        <div><dt>Failed</dt><dd className="exec-fail">{outcomes.filter((o) => o.tone === 'fail').length}</dd></div>
        <div><dt>Severity</dt><dd className="rt-sev-counts">{['none', 'low', 'high', 'severe'].map((name, level) =>
          <button key={name} type="button" aria-pressed={severityFilter === level}
            className={`severity-badge severity-${level}${severityFilter === level ? ' rt-sev-on' : ''}${severityFilter != null && severityFilter !== level ? ' rt-sev-off' : ''}`}
            title={severityFilter === level ? 'Show every severity' : `Show only ${name} commands`}
            onClick={() => setSeverityFilter((prev) => (prev === level ? null : level))}>{bySeverity[level]} {name}</button>)}</dd></div>
      </dl>
      {error && <p role="alert" className="verify-error">{error}</p>}
      {!data && !error && <p className="rt-empty">Loading…</p>}
      {data && !raw && <>
        {severityFilter != null && <p className="rt-foot rt-filter-note">Showing {shown.length} of {ordered.length} commands with {['none', 'low', 'high', 'severe'][severityFilter]} severity.{' '}
          <button type="button" className="link-button" onClick={() => setSeverityFilter(null)}>Show all</button></p>}
        {!ordered.length ? <p className="rt-empty">No commands ran in the sandbox during this prompt. Missing evidence is not proof of non-execution.</p> :
          !shown.length ? <p className="rt-empty">No commands with this severity.</p> :
          <div className="rt-table-wrap"><table className="rt-table rt-sandbox">
            <thead><tr><th>Started</th><th>Command</th><th>pid</th><th>Result</th><th>Took</th><th>Severity</th><th>Tool call</th></tr></thead>
            <tbody>{shown.map((command) => renderRow(command, 0))}</tbody>
          </table></div>}
        <p className="rt-foot">Seen by the sandbox kernel layer, independent of what the agent reported. Collector gaps: {data.gaps}.{' '}
          <button type="button" className="link-button" onClick={() => setRaw(true)}>Show every raw event</button></p>
      </>}
      {data && raw && <>
        <p className="rt-foot"><button type="button" className="link-button" onClick={() => setRaw(false)}>Back to commands</button></p>
        <ul className="evidence-raw">{(data.events ?? []).map((event) => <li key={event.event_id}>
          <code>{event.kind === 'exec_succeeded' ? (event.argv ?? []).join(' ') : `${event.kind} exit=${event.exit_code ?? 'unknown'}`}</code>
          <small> pid {event.pid} · #{event.event_id}</small>
        </li>)}</ul>
      </>}
    </>}
  </section>;
}
