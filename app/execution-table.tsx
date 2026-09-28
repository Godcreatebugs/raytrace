'use client';

// "Proposed vs observed": one row per tool call a model request proposed,
// next to the process the sandbox actually ran for it. The left side is what
// the model asked for; everything to the right is observation (gVisor, via
// runtime_processes and runtime_attributions), except the last column, which is the agent's own report
// checked against that observation.
import { type CallVerification, type Descendant } from './types';
import { processKey, SeverityBadge, type CallLabels, type Command, type Severity } from './runtime-evidence';

/** HH:MM:SS.mmm in the viewer's timezone: commands in one turn land
 * milliseconds apart, so whole seconds would hide their order. */
export function clockTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const at = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}
export const parsed = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
export function span(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
export const nsToMs = (ns: string | null | undefined) => (ns ? Number(BigInt(ns) / BigInt(1_000_000)) : NaN);

/** The command as the model meant it: Codex's `bash -lc` wrapper removed. */
function bare(argv: string[] | null | undefined): string {
  if (!argv?.length) return '';
  const wrapped = /(^|\/)(ba|z)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1] ?? '');
  return (wrapped ? argv.slice(2) : argv).join(' ');
}

/** A command on one line: long ones (heredocs, env preambles, pipelines)
 * are cut with an ellipsis, and the full text is one hover away. Newlines
 * are shown as ⏎ so a multi-line command still reads as one line. */
export function CommandText({ text }: { text: string }) {
  const oneLine = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return <code className="exec-cmd" title={text}>{oneLine}</code>;
}

export type PlainOutcome = { label: string; code: string | null; tone: 'ok' | 'fail' | 'muted'; title: string };

const SUCCESS_CAVEAT = 'The program reported success. That is not proof it did what was intended: `rm -f` also succeeds when there was nothing to delete.';
// Exit codes with a conventional meaning. Anything else non-zero is the
// program's own error code.
const EXIT_MEANING: Record<number, [string, string]> = {
  1: ['Failed', 'A general error — the most common failure code.'],
  2: ['Failed', 'Usually a wrongly used command or invalid arguments.'],
  126: ["Couldn't run", 'The file exists but is not executable (a permission problem).'],
  127: ["Couldn't run", 'Command not found.'],
  130: ['Interrupted', 'Stopped by an interrupt (Ctrl-C).'],
  137: ['Killed', 'Forcibly killed — often out of memory or a timeout.'],
  143: ['Stopped', 'Asked to terminate.'],
};
const SIGNAL_MEANING: Record<number, [string, string]> = {
  2: ['Interrupted', 'Stopped by an interrupt (Ctrl-C).'],
  6: ['Crashed', 'Aborted by the program itself.'],
  9: ['Killed', 'Forcibly killed — often out of memory or a timeout.'],
  11: ['Crashed', 'Crashed accessing invalid memory.'],
  15: ['Stopped', 'Asked to terminate.'],
};

/** How a process ended, in words a non-programmer can act on, with the raw
 * code kept alongside. Never turns missing evidence into an outcome. */
export function plainOutcome({ observed, status, exitCode = null, signal = null, error = null }: {
  observed: boolean; status?: string | null; exitCode?: number | null; signal?: number | null; error?: string | null;
}): PlainOutcome {
  if (!observed) return { label: '—', code: null, tone: 'muted', title: 'Nothing was observed for this call. Missing evidence is not proof it did not run.' };
  const errno = error?.match(/^exec failed: errno (\d+)/)?.[1];
  if (errno) return { label: "Couldn't start", code: `errno ${errno}`, tone: 'fail', title: 'The program never launched: the attempt to start it failed.' };
  if (status === 'running') return { label: 'Still running', code: null, tone: 'muted', title: 'The sandbox saw it start and has not seen it end yet.' };
  if (status === 'unknown' || (!status && exitCode == null && !signal)) {
    return { label: 'Unknown', code: error?.startsWith('evidence lost') ? 'evidence lost' : null, tone: 'muted',
      title: error?.startsWith('evidence lost') ? `The sandbox stopped reporting before this ended (${error.slice('evidence lost: '.length)}). That is not proof it failed.` : 'How this ended was not recorded.' };
  }
  const sig = signal ?? Number(error?.match(/^killed by signal (\d+)/)?.[1] ?? NaN);
  if (Number.isFinite(sig) && sig > 0) {
    const [label, meaning] = SIGNAL_MEANING[sig] ?? ['Killed', `Stopped by signal ${sig}.`];
    return { label, code: `signal ${sig}`, tone: 'fail', title: meaning };
  }
  // Rows that only carry the error text ('exit 2') still get the meaning.
  const code = exitCode ?? (error?.match(/^exit (\d+)$/) ? Number(error.slice(5)) : status === 'completed' ? 0 : null);
  if (code === 0) return { label: 'Succeeded', code: 'exit 0', tone: 'ok', title: SUCCESS_CAVEAT };
  if (code != null) {
    const [label, meaning] = EXIT_MEANING[code] ?? (code > 128 && code < 160 ? ['Killed', `Stopped by signal ${code - 128}.`] : ['Failed', "The program's own error code."]);
    return { label, code: `exit ${code}`, tone: 'fail', title: meaning };
  }
  return { label: 'Failed', code: null, tone: 'fail', title: error || 'The program reported a failure.' };
}

/** The outcome as the Result cell shows it: the word, then the raw code. */
export function OutcomeText({ outcome }: { outcome: PlainOutcome }) {
  return <span title={outcome.title}>{outcome.label}{outcome.code && <span className="exec-code"> {outcome.code}</span>}</span>;
}

function result(call: CallVerification): PlainOutcome {
  return plainOutcome({ observed: !!call.exec_id, status: call.status, exitCode: call.exit_code, error: call.error });
}

function link(call: CallVerification): { text: string; title: string; tone: 'strong' | 'weak' | 'none' } {
  if (!call.exec_id) return { text: '○ none', tone: 'none', title: 'No process was observed for this call. Missing evidence is not proof it did not run.' };
  const score = typeof call.match_score === 'number' ? ` · text similarity ${call.match_score.toFixed(2)}` : '';
  if (call.match_basis === 'id') return { text: '● exact', tone: 'strong', title: `The call ID travelled with the process, so this join is exact, not a text match.` };
  if (call.match_basis === 'window') {
    const sent = call.window_end_ms != null ? `result sent ${clockTime(call.window_end_ms)}` : 'no result sent yet when it matched';
    return { text: '● window', tone: 'strong',
      title: `Proposed ${clockTime(call.window_start_ms)} · ${sent} · ran ${clockTime(parsed(call.started_at))}${score}. The process started after the proposal and before the agent reported back, and its command matches.` };
  }
  return { text: '◐ text', tone: 'weak', title: `Matched by command text within ±30 s of the proposal${score}. No causal window was available, so a wrong match is possible.` };
}

function agentSaid(call: CallVerification): { text: string; title: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (call.reported_check) {
    case 'agrees': return { text: '✓ agrees', tone: 'ok', title: "The agent's reported exit code and run time match what the sandbox observed." };
    case 'exit_code_differs': return { text: '⚠ exit code differs', tone: 'warn', title: "The agent reported a different exit code from the one the sandbox observed. The sandbox's observation is the independent one." };
    case 'duration_differs': return { text: '⚠ run time differs', tone: 'warn', title: "The agent's reported run time is far from what the sandbox observed. The sandbox's observation is the independent one." };
    default: return { text: '—', tone: 'muted', title: 'Nothing comparable was reported yet (no result, a still-running command, or no runner header).' };
  }
}

/** The processes a call actually spawned. Nobody proposed any of these — a
 * `pretest` hook that deletes a file is as invisible in the tool call as it
 * is consequential — so this is collapsed by default and says how many there
 * are, rather than either hiding them or burying the call itself. */
export function DescendantTree({ items, onShowProcess }: { items: Descendant[]; onShowProcess?: (key: string) => void }) {
  if (!items.length) return null;
  const failed = items.filter((child) => child.status === 'failed').length;
  // Who started whom: depth counts ancestors that are also in this list, so
  // `rm` sits under the `node` script that ran it rather than beside it.
  const byPid = new Map(items.map((child) => [child.pid, child]));
  const depthOf = (child: Descendant) => {
    let depth = 0;
    const seen = new Set<number | null>([child.pid]);
    for (let parent = byPid.get(child.ppid ?? -1); parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid ?? -1)) { seen.add(parent.pid); depth += 1; }
    return depth;
  };
  const ordered = [...items].sort((a, b) => (parsed(a.started_at) || 0) - (parsed(b.started_at) || 0));
  return <details className="raw-details descendant-tree">
    <summary>{items.length} process{items.length === 1 ? '' : 'es'} ran underneath{failed ? ` · ${failed} failed` : ''}</summary>
    <ol className="descendant-list">
      {ordered.map((child) => {
        const key = processKey(child.pid, child.start_time_ns);
        const started = parsed(child.started_at);
        const ended = parsed(child.ended_at);
        const outcome = plainOutcome({ observed: true, status: child.status, error: child.error });
        return <li key={child.id} className={child.status === 'failed' ? 'descendant failed' : 'descendant'}>
          <span className="descendant-time" title={child.started_at ?? undefined}>{clockTime(started)}</span>
          <span className="descendant-span">{Number.isFinite(ended) && Number.isFinite(started) ? `+${span(ended - started)}` : ''}</span>
          <span className="descendant-what" style={{ paddingLeft: `${depthOf(child) * 14}px` }}>
            {depthOf(child) > 0 && <span className="descendant-branch" aria-hidden="true">└ </span>}
            <CommandText text={child.argv.join(' ') || '(no argv recorded)'} />
          </span>
          <span className="descendant-meta" title={`pid ${child.pid}, started by pid ${child.ppid}`}>
            {onShowProcess && key ? <button type="button" className="link-button" onClick={() => onShowProcess(key)}>pid {child.pid}</button> : <>pid {child.pid}</>}
          </span>
          <span className={`descendant-outcome exec-${outcome.tone}`}><OutcomeText outcome={outcome} /></span>
        </li>;
      })}
    </ol>
    <p className="chain-note">Observed by the kernel layer, not proposed by the model. Nothing here appears in the tool call above. Times are when each process started, on this machine&apos;s clock.</p>
  </details>;
}

/** Jev's reading of a call next to its severity: phase and outcome as chips,
 * and the one output line that explains it, quoted as it was printed. */
function Assessment({ severity, labels }: { severity?: Severity | null; labels?: CallLabels | null }) {
  if (!severity && !labels) return <span className="exec-muted">—</span>;
  const chip = (value: { choice: string; confidence: number | null } | null) => value &&
    <span className="assess-chip" title={`Jev: ${Math.round((value.confidence ?? 0) * 100)}% confident. A classifier's reading, not an observation.`}>
      {value.choice}{(value.confidence ?? 0) < 0.9 ? ' ~' : ''}</span>;
  return <span className="exec-assessment">
    <SeverityBadge severity={severity} flags={labels?.flags} />
    {chip(labels?.phase ?? null)}
    {chip(labels?.outcome ?? null)}
    {labels?.key_line && <code className="assess-key-line" title="The output line Jev picked as the one that explains this step, quoted verbatim.">{labels.key_line}</code>}
  </span>;
}

const HEAD = ['#', 'Proposed by the model', 'Observed in the sandbox', 'Ran', 'Result', 'Assessment', 'Link', 'Agent said'];

export function ExecutionTable({ calls, callNumber, onSelectCall, onShowProcess, severity, labels }: {
  calls: CallVerification[];
  callNumber: Map<string, number>;
  onSelectCall: (callId: string) => void;
  onShowProcess: (key: string) => void;
  /** From the runtime evidence page: severityByCall() and call_labels. */
  severity?: Map<string, Severity>;
  labels?: Record<string, CallLabels>;
}) {
  if (!calls.length) return null;
  return <div className="exec-table-wrap">
    <div className="card-kicker exec-kicker">PROPOSED VS OBSERVED</div>
    <table className="exec-table exec-table-calls">
      <thead><tr>{HEAD.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>
        {calls.map((call) => {
          const started = parsed(call.started_at);
          const ended = parsed(call.ended_at);
          const key = processKey(call.pid, call.start_time_ns);
          const outcome = result(call);
          const basis = link(call);
          const said = agentSaid(call);
          const children = call.descendants ?? [];
          return [
            <tr key={call.call_id} className="exec-row" onClick={() => onSelectCall(call.call_id)} title="Select this step">
              <td data-label="#" className="exec-num">{callNumber.get(call.call_id) ?? '—'}</td>
              <td data-label="Proposed"><CommandText text={call.proposed || call.name} /></td>
              <td data-label="Observed">{call.exec_id && key
                ? <span className="exec-observed"><button type="button" className="link-button exec-pid" title="Show this process in the sandbox tree"
                    onClick={(event) => { event.stopPropagation(); onShowProcess(key); }}>pid {call.pid}</button><CommandText text={bare(call.argv) || '(no argv recorded)'} /></span>
                : <span className="exec-muted">— not observed</span>}</td>
              <td data-label="Ran" className="exec-time">{call.exec_id
                ? <>{clockTime(started)} <span className="exec-muted">{Number.isFinite(ended) ? `+${span(ended - started)}` : call.status === 'running' ? 'running…' : ''}</span></>
                : '—'}</td>
              <td data-label="Result" className={`exec-${outcome.tone}`}><OutcomeText outcome={outcome} /></td>
              <td data-label="Assessment"><Assessment severity={severity?.get(call.call_id)} labels={labels?.[call.call_id]} /></td>
              <td data-label="Link" className={`exec-link exec-link-${basis.tone}`} title={basis.title}>{basis.text}</td>
              <td data-label="Agent said" className={`exec-said-${said.tone}`} title={said.title}>{said.text}</td>
            </tr>,
            children.length ? <tr key={`${call.call_id}-children`} className="exec-children"><td colSpan={HEAD.length}><DescendantTree items={children} onShowProcess={onShowProcess} /></td></tr> : null,
          ];
        })}
      </tbody>
    </table>
  </div>;
}

/** Top-level processes that ran in this turn but belong to no proposed call.
 * Usually the agent's own helpers; occasionally the thing worth seeing. */
export function UnattributedTable({ commands, onShowProcess }: { commands: Command[]; onShowProcess: (key: string) => void }) {
  const rows = commands.filter((c) => c.parent_event_id == null && c.attribution && !c.attribution.call_id && !c.attribution.parent_call_id);
  if (!rows.length) return null;
  return <div className="exec-table-wrap">
    <div className="card-kicker exec-kicker">RAN, BUT NO TOOL CALL ACCOUNTS FOR IT</div>
    <table className="exec-table exec-table-unattributed">
      <thead><tr>{['Observed in the sandbox', 'Ran', 'Result', 'Severity', 'Link'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>
        {rows.map((command) => {
          const key = processKey(command.pid, command.process_start_ns);
          const started = nsToMs(command.started_ns);
          const ended = nsToMs(command.ended_ns);
          const finished = command.exit_code != null || !!command.signal;
          const outcome = plainOutcome({ observed: true, status: finished ? undefined : 'running', exitCode: command.exit_code, signal: command.signal });
          return <tr key={command.event_id} className="exec-row">
            <td data-label="Observed"><span className="exec-observed">{key
              ? <button type="button" className="link-button exec-pid" title="Show this process in the sandbox tree" onClick={() => onShowProcess(key)}>pid {command.pid}</button>
              : <>pid {command.pid}</>}<CommandText text={command.command} /></span></td>
            <td data-label="Ran" className="exec-time">{clockTime(started)} <span className="exec-muted">{Number.isFinite(ended) ? `+${span(ended - started)}` : ''}</span></td>
            <td data-label="Result" className={`exec-${outcome.tone}`}><OutcomeText outcome={outcome} /></td>
            <td data-label="Severity">{command.severity ? <SeverityBadge severity={command.severity} /> : <span className="exec-muted">—</span>}</td>
            <td data-label="Link" className="exec-link exec-link-none" title="This process matched no proposed call. Either the correlator failed or nothing proposed it.">○ unattributed</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
