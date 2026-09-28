'use client';
import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Stable key for one process: pid plus its own start time. Shared by the
 * sandbox tree and the "proposed vs observed" table so either can point at
 * the other, whichever exec event each happened to keep for the process. */
export const processKey = (pid: number | null | undefined, startNs: string | null | undefined) =>
  pid == null ? null : `${pid}:${startNs ?? ''}`;
const processDomId = (key: string) => `proc-${key.replace(':', '-')}`;

/** Which call a process belongs to, from its runtime_attributions. Null when
 * the process was not recorded yet, which is not the same as unattributed (a
 * recorded process that matched no call: both ids null). */
export type Attribution = { call_id: string | null; parent_call_id: string | null; tier: string | null };

/** One command the sandbox actually ran, folded out of the raw event stream by
 * proxy/exec-narrative.mjs. `description_source` says where the sentence came
 * from, and the UI keeps the three visibly apart:
 *   rule  — derived from the command text itself
 *   model — a model's reading of a command no rule covered
 *   raw   — no description available; the command is shown verbatim */
export type Command = {
  event_id: number; pid: number; ppid: number | null;
  process_start_ns?: string | null;
  attribution?: Attribution | null;
  argv: string[]; command: string;
  started_ns: string | null; ended_ns: string | null;
  exit_code: number | null; signal: number | null;
  parent_event_id: number | null;
  description: string | null;
  description_source: 'rule' | 'model' | 'raw';
  /** Top-level commands only (proxy/call-assessment.mjs). Null when nothing
   * was assessed: no rule fired and Jev was off or failed. */
  severity?: Severity | null;
};

/** 0-3, aligned with classification_impact_levels. `floor` is what a rule on
 * the command text proved; Jev can only raise the level above it. */
export type Severity = {
  level: 0 | 1 | 2 | 3; label: 'none' | 'low' | 'high' | 'severe';
  floor: number; rule: string | null;
  /** `probabilities` is Jev's distribution over levels "0".."3". */
  jev: { score: number; confidence: number | null; probabilities?: Record<string, number> | null } | null;
  needs_review: boolean; reason: string;
};
/** Jev's structured reading of one tool call. `key_line` is quoted verbatim
 * from the call's output, never paraphrased. */
export type CallLabels = {
  outcome: { choice: string; confidence: number | null } | null;
  phase: { choice: string; confidence: number | null } | null;
  key_line: string | null;
  flags: Record<string, number>;
};
type Folded = { preamble: number; machinery: number; reexec: number; exits: number; preambleChars: number };
type RawEvent = { event_id: number; kind: string; timestamp_ns?: string; pid?: number; ppid?: number; argv?: string[]; exit_code?: number | null; errno?: number };
export type RuntimePage = { commands?: Command[]; folded?: Folded; events?: RawEvent[]; gaps: number; error?: string;
  call_labels?: Record<string, CallLabels>; severity_source?: 'jev' | 'rules' };

/** The most severe top-level command each call ran, keyed by call id. */
export function severityByCall(commands: Command[]): Map<string, Severity> {
  const out = new Map<string, Severity>();
  for (const command of commands) {
    const callId = command.attribution?.call_id ?? command.attribution?.parent_call_id;
    if (!callId || !command.severity) continue;
    const seen = out.get(callId);
    if (!seen || command.severity.level > seen.level) out.set(callId, command.severity);
  }
  return out;
}

const FLAG_WORDS: Record<string, string> = {
  irreversible: 'hard to undo', touches_project_data: 'changes project files', touches_secrets: 'touches secrets',
  network_egress: 'sends data out', beyond_intent: 'did more than asked', steering_text: 'text addresses the reviewer',
};

/** Severity as a coloured word. `~` marks a level the reviewer should check
 * (low confidence, or text aimed at the checker); the hover says why. */
export function SeverityBadge({ severity, flags }: { severity?: Severity | null; flags?: Record<string, number> }) {
  if (!severity) return null;
  const flagText = Object.entries(flags ?? {}).map(([name, p]) => `${FLAG_WORDS[name] ?? name}${Number.isFinite(Number(p)) ? ` (${Math.round(Number(p) * 100)}%)` : ''}`).join(', ');
  const source = severity.jev ? 'Rated by Jev, a classifier; a rule on the command text sets a minimum it cannot go under.' : 'Set by a rule on the command text; Jev did not rate this.';
  const title = [severity.reason, flagText && `Flags: ${flagText}`, severity.needs_review && 'Needs review: the rating is uncertain or the command text tries to influence it.', source]
    .filter(Boolean).join('\n');
  return <span className={`severity-badge severity-${severity.level}`} title={title}>{severity.label}{severity.needs_review ? ' ~' : ''}</span>;
}

const LOW_CONFIDENCE = 0.7;

/** Severity for the sandbox table. `?` means Jev was under 70% sure, and
 * "(rule)" means a rule on the command text set the level, not Jev. Clicking
 * shows Jev's full distribution and the flags that fired. */
export function SeverityChip({ severity, flags }: { severity?: Severity | null; flags?: Record<string, number> }) {
  if (!severity) return <span className="exec-muted">—</span>;
  const jev = severity.jev;
  const byRule = severity.floor > 0 && severity.floor === severity.level && (!jev || Math.round(jev.score) < severity.floor);
  const unsure = !!jev && (jev.confidence ?? 0) < LOW_CONFIDENCE;
  const levels = ['none', 'low', 'high', 'severe'];
  const fired = Object.entries(flags ?? {});
  return <Popover>
    <PopoverTrigger className={`severity-badge severity-${severity.level} rt-sev`}>
      {severity.label}{unsure ? '?' : ''}{byRule ? ' (rule)' : ''}
    </PopoverTrigger>
    <PopoverContent className="rt-sev-pop" align="end">
      <strong>{severity.label}{byRule ? ', set by a rule' : ''}</strong>
      {severity.rule && <p>Rule: {severity.rule}</p>}
      {jev ? <>
        <p>Jev: {jev.score.toFixed(2)} of 3, {Math.round((jev.confidence ?? 0) * 100)}% confident</p>
        {jev.probabilities && <ul className="rt-dist">{levels.map((name, level) => {
          const p = jev.probabilities?.[String(level)] ?? 0;
          return <li key={name}><span>{name}</span><i><b className={`severity-${level}`} style={{ width: `${Math.round(p * 100)}%` }} /></i><em>{p.toFixed(2)}</em></li>;
        })}</ul>}
      </> : <p>Jev did not rate this command.</p>}
      {fired.length > 0 && <p>Flags: {fired.map(([name, p]) => `${FLAG_WORDS[name] ?? name}${Number.isFinite(Number(p)) ? ` ${Number(p).toFixed(2)}` : ''}`).join(', ')}</p>}
    </PopoverContent>
  </Popover>;
}

/** How the tree labels a call it links to, and what clicking it does. */
export type CallLinks = {
  label: (callId: string) => string | null;
  select: (callId: string) => void;
};

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

function AttributionChip({ attribution, links }: { attribution?: Attribution | null; links?: CallLinks }) {
  if (!attribution) return null;
  const own = attribution.call_id;
  const parent = attribution.parent_call_id;
  if (!own && !parent) return <span className="evidence-call unattributed" title="This process ran, but it matched no proposed tool call. Either the correlator failed or nothing proposed it.">unattributed</span>;
  const callId = (own ?? parent)!;
  const label = links?.label(callId) ?? 'a tool call';
  const text = own ? `← ${label}` : `under ${label}`;
  const title = own ? 'The tool call this process ran as. Click to select that step.' : 'Started by the process of this tool call. Click to select that step.';
  return <button type="button" className={`evidence-call ${own ? 'own' : 'under'}`} title={title}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); links?.select(callId); }}>{text}</button>;
}

function Row({ command, ordinal, links }: { command: Command; ordinal?: number; links?: CallLinks }) {
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
    <SeverityBadge severity={command.severity} />
    <AttributionChip attribution={command.attribution} links={links} />
  </>;
}

/**
 * One command and everything it started. A command with children is a
 * disclosure: the summary is the command itself, and opening it reveals the
 * numbered steps it caused. Top level is open so the turn reads as a short
 * list; deeper levels stay closed until you ask.
 */
type StepView = { tree: Map<number, Command[]>; highlight: string | null; openPath: Set<number>; links?: CallLinks };

function Step({ command, depth, ordinal, view }: { command: Command; depth: number; ordinal?: number; view: StepView }) {
  const failed = command.exit_code != null && command.exit_code !== 0;
  const kids = inOrder(view.tree.get(command.event_id) ?? []);
  const key = processKey(command.pid, command.process_start_ns);
  const highlighted = key != null && key === view.highlight;
  const className = `${failed ? 'evidence-step failed' : 'evidence-step'}${highlighted ? ' exec-highlight' : ''}`;
  const id = key ? processDomId(key) : undefined;

  if (!kids.length) {
    return <li id={id} className={className}><Row command={command} ordinal={ordinal} links={view.links} /><Argv command={command} /></li>;
  }
  // A jump target nested inside a collapsed parent opens the path to it.
  return <li id={id} className="evidence-node">
    <details open={depth === 0 || view.openPath.has(command.event_id)}>
      <summary className={className}><Row command={command} ordinal={ordinal} links={view.links} /></summary>
      <Argv command={command} />
      <ol className="evidence-list evidence-children">
        {kids.map((kid, index) =>
          <Step key={kid.event_id} command={kid} depth={depth + 1} ordinal={index + 1} view={view} />)}
      </ol>
    </details>
  </li>;
}

/** Fetches (and, while the turn is still open, polls) the sandbox's folded
 * process tree for one turn. Shared by the tree panel and the table's
 * "ran, but no tool call accounts for it" section, so both read one copy. */
export function useRuntimeEvidence(sandboxId?: string, since?: number, until?: number) {
  const [data, setData] = useState<RuntimePage | null>(null);
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
        const value = await response.json() as RuntimePage;
        if (!response.ok) throw Error(value.error || 'Runtime evidence unavailable');
        if (!stopped) { setData(value); setError(''); }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Runtime evidence unavailable'); }
      // Poll only while the turn is still open; a finished turn cannot change.
      if (!stopped && !until) timer = setTimeout(load, 3000);
    };
    setData(null); void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [sandboxId, since, until, raw]);

  return { data, error, raw, setRaw };
}

export function RuntimeEvidence({ sandboxId, prompt, runtime, open, onOpenChange, highlight = null, links }: {
  sandboxId?: string; prompt?: string;
  runtime: ReturnType<typeof useRuntimeEvidence>;
  open: boolean; onOpenChange: (open: boolean) => void;
  /** processKey of a process to scroll to and mark, e.g. from a table row. */
  highlight?: string | null;
  links?: CallLinks;
}) {
  const { data, error, raw, setRaw } = runtime;
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
  // Every ancestor of the highlighted process, so each collapsed level on the
  // way down to it opens.
  const openPath = new Set<number>();
  const target = highlight ? commands.find((c) => processKey(c.pid, c.process_start_ns) === highlight) : undefined;
  const byEvent = new Map(commands.map((c) => [c.event_id, c]));
  for (let at = target?.parent_event_id; at != null && !openPath.has(at); at = byEvent.get(at)?.parent_event_id) openPath.add(at);
  const view: StepView = { tree, highlight, openPath, links };

  useEffect(() => {
    if (!open || !highlight || raw) return;
    // After the path has opened: scroll the process into view.
    const frame = requestAnimationFrame(() => document.getElementById(processDomId(highlight))?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [open, highlight, raw, data]);

  return <details className="evidence-panel" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
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
            <code>{e.kind === 'exec_succeeded' ? (e.argv ?? []).join(' ') : e.kind === 'exec_failed' ? `exec failed (errno ${e.errno ?? '?'}): ${(e.argv ?? []).join(' ')}` : `${e.kind} exit=${e.exit_code ?? 'unknown'}`}</code>
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
            <Step key={command.event_id} command={command} depth={0} view={view} />)}
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
