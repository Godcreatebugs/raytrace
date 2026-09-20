'use client';
import { useEffect, useState } from 'react';

/** One command the sandbox actually ran, folded out of the raw event stream by
 * proxy/exec-narrative.mjs. `description_source` says where the sentence came
 * from, and the UI keeps the three visibly apart:
 *   rule  — derived from the command text itself
 *   model — a model's reading of a command no rule covered
 *   raw   — no description available; the command is shown verbatim */
type Command = {
  event_id: number; pid: number; ppid: number | null;
  argv: string[]; command: string;
  started_ns: string | null; ended_ns: string | null;
  exit_code: number | null; signal: number | null;
  parent_event_id: number | null;
  description: string | null;
  description_source: 'rule' | 'model' | 'raw';
};
type Folded = { preamble: number; machinery: number; reexec: number; exits: number; preambleChars: number };
type RawEvent = { event_id: number; kind: string; timestamp_ns?: string; pid?: number; ppid?: number; argv?: string[]; exit_code?: number | null };
type Page = { commands?: Command[]; folded?: Folded; events?: RawEvent[]; gaps: number; error?: string };

/** Commands in one turn land milliseconds apart, so whole seconds hide the
 * ordering the numbered children claim. Render HH:MM:SS.mmm. */
const clock = (ns: string | null | undefined) => {
  if (!ns) return '—';
  const at = new Date(Number(BigInt(ns) / BigInt(1_000_000)));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
};

function foldedSummary(folded: Folded) {
  const parts: string[] = [];
  if (folded.preamble) parts.push(`${folded.preamble} env preamble${folded.preamble > 1 ? 's' : ''} (${folded.preambleChars.toLocaleString()} chars)`);
  if (folded.reexec) parts.push(`${folded.reexec} re-exec${folded.reexec > 1 ? 's' : ''}`);
  if (folded.machinery) parts.push(`${folded.machinery} internal probe${folded.machinery > 1 ? 's' : ''}`);
  if (folded.exits) parts.push(`${folded.exits} exit row${folded.exits > 1 ? 's' : ''}`);
  return parts.join(', ');
}

/** Siblings carry a position number, so they must be in the order they ran. */
const inOrder = (list: Command[]) => [...list].sort((a, b) => {
  const at = a.started_ns ? BigInt(a.started_ns) : null;
  const bt = b.started_ns ? BigInt(b.started_ns) : null;
  if (at != null && bt != null && at !== bt) return at < bt ? -1 : 1;
  return a.event_id - b.event_id;
});

/** The command exactly as the sandbox ran it, plus the two process ids that
 * place it in the tree. This is the observation; the line above it is a
 * description of the observation. */
function Argv({ command }: { command: Command }) {
  return <details className="evidence-argv"><summary>command</summary>
    <code>{command.argv.join(' ')}</code>
    <small> pid {command.pid}{command.ppid != null ? ` · parent pid ${command.ppid}` : ''}</small>
  </details>;
}

function Row({ command, ordinal }: { command: Command; ordinal?: number }) {
  const failed = command.exit_code != null && command.exit_code !== 0;
  return <>
    {ordinal != null && <span className="evidence-ordinal">{ordinal}.</span>}
    <span className="evidence-time">{clock(command.started_ns)}</span>
    <span className="evidence-what">
      {command.description ?? <code>{command.command}</code>}
      {command.description_source === 'model' && <span className="evidence-ai" title="Described by a model, not derived from the command text. Treat as a reading, not an observation.">~AI</span>}
      {command.description_source === 'raw' && <span className="evidence-nodesc" title="No rule matched and no description was generated; this is the command exactly as it ran.">verbatim</span>}
    </span>
    {command.exit_code != null && <span className={failed ? 'evidence-exit failed' : 'evidence-exit'}>exit {command.exit_code}</span>}
    {command.signal ? <span className="evidence-exit failed">signal {command.signal}</span> : null}
  </>;
}

/**
 * One command and everything it started. A command with children is a
 * disclosure: the summary is the command itself, and opening it reveals the
 * numbered steps it caused. Top level is open so the turn reads as a short
 * list; deeper levels stay closed until you ask.
 */
function Step({ command, tree, depth, ordinal }: { command: Command; tree: Map<number, Command[]>; depth: number; ordinal?: number }) {
  const failed = command.exit_code != null && command.exit_code !== 0;
  const kids = inOrder(tree.get(command.event_id) ?? []);
  const className = failed ? 'evidence-step failed' : 'evidence-step';

  if (!kids.length) {
    return <li className={className}><Row command={command} ordinal={ordinal} /><Argv command={command} /></li>;
  }
  return <li className="evidence-node">
    <details open={depth === 0}>
      <summary className={className}><Row command={command} ordinal={ordinal} /></summary>
      <Argv command={command} />
      <ol className="evidence-list evidence-children">
        {kids.map((kid, index) =>
          <Step key={kid.event_id} command={kid} tree={tree} depth={depth + 1} ordinal={index + 1} />)}
      </ol>
    </details>
  </li>;
}

export function RuntimeEvidence({ sandboxId, since, until, prompt }: { sandboxId?: string; since?: number; until?: number; prompt?: string }) {
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (!sandboxId) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      try {
        const window = `${since ? `&since=${since}` : ''}${until ? `&until=${until}` : ''}`;
        const response = await fetch(`http://127.0.0.1:8797/raytace/runtime?sandbox=${encodeURIComponent(sandboxId)}${window}${raw ? '&raw=1' : ''}`, { signal: controller.signal });
        const value = await response.json() as Page;
        if (!response.ok) throw Error(value.error || 'Runtime evidence unavailable');
        if (!stopped) { setData(value); setError(''); }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Runtime evidence unavailable'); }
      // Poll only while the turn is still open; a finished turn cannot change.
      if (!stopped && !until) timer = setTimeout(load, 3000);
    };
    setData(null); void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [sandboxId, since, until, raw]);

  const commands = data?.commands ?? [];
  // A real tree: each command hangs under whichever command started it. Roots
  // are the ones whose parent is not on this page -- either they are what the
  // agent ran directly, or their parent started before this prompt did.
  const present = new Set(commands.map((c) => c.event_id));
  const tree = new Map<number, Command[]>();
  const roots: Command[] = [];
  for (const command of commands) {
    const parent = command.parent_event_id;
    if (parent == null || !present.has(parent)) { roots.push(command); continue; }
    const siblings = tree.get(parent);
    if (siblings) siblings.push(command); else tree.set(parent, [command]);
  }

  return <details className="evidence-panel">
    <summary>What ran in the sandbox</summary>
    {!sandboxId ? <p className="chain-note">No sandbox mapping for this capture. Agent logs alone do not confirm execution.</p> : <>
      {prompt && <p className="evidence-prompt">for: <em>{prompt.slice(0, 110)}</em></p>}
      <p className="chain-note">Observed by the sandbox kernel layer, independent of anything the agent reported.
        A successful exec proves a program started, not that its output or the answer is correct.</p>
      {error && <p role="alert" className="verify-error">{error}</p>}
      {!data && !error && <p className="chain-note">Loading…</p>}

      {data && raw && <>
        <p className="chain-note">Every recorded event, unfolded. <button type="button" className="link-button" onClick={() => setRaw(false)}>Back to commands</button></p>
        <ul className="evidence-raw">
          {(data.events ?? []).map((e) => <li key={e.event_id}>
            <span className="evidence-time">{clock(e.timestamp_ns)}</span>
            <code>{e.kind === 'exec_succeeded' ? (e.argv ?? []).join(' ') : `${e.kind} exit=${e.exit_code ?? 'unknown'}`}</code>
            <small> pid {e.pid} · #{e.event_id}</small>
          </li>)}
        </ul>
        {!(data.events ?? []).length && <p className="chain-note">No events recorded in this window.</p>}
      </>}

      {data && !raw && <>
        {!commands.length && <p className="chain-note">No commands ran in the sandbox during this prompt.
          Missing evidence is not proof of non-execution — check that the sandbox is reporting.</p>}
        <ol className="evidence-list">
          {inOrder(roots).map((command) =>
            <Step key={command.event_id} command={command} tree={tree} depth={0} />)}
        </ol>
        {data.folded && foldedSummary(data.folded) && <p className="chain-note evidence-folded">
          Folded: {foldedSummary(data.folded)}.{' '}
          <button type="button" className="link-button" onClick={() => setRaw(true)}>Show every event</button>
        </p>}
        <p className="chain-note">Collector-wide gaps/errors: {data.gaps}. Missing evidence is not proof of non-execution.</p>
      </>}
    </>}
  </details>;
}
