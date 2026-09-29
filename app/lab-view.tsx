'use client';

// Lab: what the model had in context for one prompt, in three boxes.
//   A  what you asked before, in the same conversation
//   B  what the model brought: its earlier answers and the files whose
//      contents reached it, with how much of each got in
//   C  internals the harness injects on every request
// The experiment tools sit underneath, collapsed, as "Test it".
import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, FlaskConical } from 'lucide-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { type Trace } from './types';
import { DecisionLab, type SelectedStep } from './decision-lab';

const API = 'http://127.0.0.1:8797/raytace';

type FileEntry = { path: string; op: 'read' | 'wrote' | 'listed'; when: 'before' | 'this prompt'; reads: number; lines: number; chars: number; share: number;
  shared_output: boolean; used_later: string[]; command: string; call_id: string; context_index: number; excerpt: string };
type Internal = { kind: string; context_index: number | 'instructions' | 'tools'; chars: number; share: number; excerpt?: string; fields?: Record<string, string>; names?: string[] };
type Summary = { prompts: string[]; answers: string; model?: string };
type PromptContext = {
  earlierPrompts: { index: number; text: string }[];
  answers: { index: number; when: string; text: string }[];
  files: FileEntry[]; internals: Internal[];
  totals: { items: number; chars: number };
  model: string; context_window: number | null;
  summary: Summary | null; summary_needed: boolean; summary_model: string;
  error?: string;
};

// Sizes arrive as characters; ~4 characters per token is the usual estimate.
const est = (chars: number) => Math.round(chars / 4);
const k = (tokens: number) => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens));
const itemUrl = (traceId: string, index: number | string) => `${API}/prompt-context/${traceId}/item/${index}`;
const oneLine = (text: string, max = 140) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

function useContext(traceId: string) {
  const [data, setData] = useState<PromptContext | null>(null);
  const [error, setError] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    let closed = false;
    fetch(`${API}/prompt-context/${traceId}`).then(async (response) => {
      const value = await response.json() as PromptContext;
      if (response.status === 404 && value.error === 'Unknown local endpoint.') throw new Error('The proxy is running an older version without the Lab. Restart it (npm run proxy) and reload.');
      if (!response.ok) throw new Error(value.error || 'Context unavailable');
      if (!closed) setData(value);
    }).catch((e) => { if (!closed) setError(e instanceof Error ? e.message : 'Context unavailable'); });
    return () => { closed = true; };
  }, [traceId]);
  // Boxes A and B get a one-line summary from one cached, cheap model call,
  // made only when there is something before the prompt to summarise.
  useEffect(() => {
    if (!data || data.summary || !data.summary_needed || asked.current) return;
    asked.current = true;
    let closed = false;
    setSummarizing(true);
    fetch(`${API}/prompt-context/summary`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' }, body: JSON.stringify({ trace_id: traceId }) })
      .then(async (response) => { const value = await response.json() as Summary & { error?: string }; if (response.ok && !closed) setData((prev) => prev && { ...prev, summary: value }); })
      .catch(() => { /* boxes still render without the summary line */ })
      .finally(() => { if (!closed) setSummarizing(false); });
    return () => { closed = true; };
  }, [data, traceId]);
  return { data, error, summarizing };
}

function FileRow({ file, traceId, onTest }: { file: FileEntry; traceId: string; onTest?: () => void }) {
  const [open, setOpen] = useState(false);
  const size = file.op === 'wrote' ? '—' : `${file.lines} line${file.lines === 1 ? '' : 's'}`;
  return <>
    <li className={`rt-file${open ? ' open' : ''}`}>
      <button type="button" className="rt-file-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`rt-op rt-op-${file.op}`}>{file.op}</span>
        <code className="rt-file-path" title={file.path}>{file.path}</code>
        <span className="rt-file-size" title={file.shared_output ? 'This output came from several commands chained together, so it cannot be split between them.' : undefined}>
          {size}{file.shared_output ? '*' : ''}</span>
        <span className="rt-file-tokens" title="Estimated tokens this file added to the context window">{file.op === 'wrote' ? '' : `~${k(est(file.chars))} tokens`}</span>
        <span className="rt-file-used" title={file.used_later.length ? `Words from this output appear later in what the model wrote: ${file.used_later.join(', ')}. A hint, not proof it mattered.` : 'Nothing from this output reappears later. A hint, not proof it did not matter.'}>
          {file.used_later.length ? <><Check size={12} /> used</> : ''}</span>
      </button>
    </li>
    {open && <li className="rt-file-detail">
      <p className="rt-muted">{file.when === 'before' ? 'In context before your question' : 'Read while answering this prompt'}{file.reads > 1 ? ` · read ${file.reads} times` : ''} · via <code>{oneLine(file.command, 90)}</code></p>
      <div className="rt-actions">
        {file.op !== 'wrote' && <a className="rt-button" href={itemUrl(traceId, file.context_index)} target="_blank" rel="noreferrer">Open what the model saw <ExternalLink size={13} /></a>}
        {onTest && file.op !== 'wrote' && <button type="button" className="rt-button" onClick={onTest}><FlaskConical size={14} /> Test impact</button>}
      </div>
    </li>}
  </>;
}

/** How much of the model's context window the answer used, and on what. */
function ContextWindow({ data }: { data: PromptContext }) {
  const used = est(data.totals.chars);
  const internal = (kind: string) => data.internals.filter((item) => item.kind === kind).reduce((sum, item) => sum + item.chars, 0);
  const files = data.files.filter((file) => file.op !== 'wrote').reduce((sum, file) => sum + file.chars, 0);
  const named = internal('System prompt') + internal('Tools') + files;
  const parts = [
    { label: 'System prompt', chars: internal('System prompt'), tone: 1 },
    { label: 'Tool definitions', chars: internal('Tools'), tone: 2 },
    { label: 'File contents', chars: files, tone: 3 },
    { label: 'Conversation and other instructions', chars: Math.max(0, data.totals.chars - named), tone: 4 },
  ].filter((part) => part.chars > 0);
  const size = data.context_window;
  const scale = size || used || 1;
  return <section className="rt-window" aria-label="Context window">
    <div className="rt-window-head">
      <strong>Context window: ~{k(used)} tokens used{size ? ` of ${k(size)}` : ''}</strong>
      <span>{size ? `${((used / size) * 100).toFixed(1)}% full by the final answer · ${data.model}` : `by the final answer · window size for ${data.model} unknown`}</span>
    </div>
    <div className="rt-window-bar">{parts.map((part) => <i key={part.label} className={`rt-seg-${part.tone}`}
      style={{ width: `${Math.max(0.4, (est(part.chars) / scale) * 100)}%` }} title={`${part.label}: ~${k(est(part.chars))} tokens`} />)}</div>
    <div className="rt-window-legend">{parts.map((part) => <span key={part.label}><i className={`rt-seg-${part.tone}`} />{part.label} ~{k(est(part.chars))}</span>)}</div>
  </section>;
}

export function LabView({ trace, stepKey, onStep }: {
  trace: Trace;
  /** `exchange_id:output_index` of the step "Test it" is on. */
  stepKey: string | null;
  onStep: (key: string) => void;
}) {
  const { data, error, summarizing } = useContext(trace.id);
  // Closed until asked for: the boxes are the point of this page.
  const [testing, setTesting] = useState(false);
  const [focusCall, setFocusCall] = useState<string | null>(null);
  const testRef = useRef<HTMLDetailsElement>(null);
  const calls = trace.callVerifications ?? [];
  const steps: (SelectedStep & { call_id: string })[] = calls.map((call, index) => ({ call_id: call.call_id, exchange_id: call.exchange_id, output_index: call.output_index, title: `#${index + 1} ${call.name}`, detail: call.proposed ?? call.name }));
  const key = (step: { exchange_id?: string; output_index?: number }) => `${step.exchange_id}:${step.output_index}`;
  const step = steps.find((item) => key(item) === stepKey) ?? steps[0];

  // Testing a file's impact means rerunning the next decision after the model
  // read it, with that output blanked.
  function testImpact(file: FileEntry) {
    const at = steps.findIndex((item) => item.call_id === file.call_id);
    const next = at >= 0 ? steps[at + 1] : undefined;
    if (!next) return;
    setFocusCall(file.call_id); setTesting(true); onStep(key(next));
    requestAnimationFrame(() => testRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  const canTest = (file: FileEntry) => { const at = steps.findIndex((item) => item.call_id === file.call_id); return at >= 0 && at < steps.length - 1; };

  const reads = data?.files.filter((file) => file.op !== 'listed') ?? [];
  const listed = data?.files.filter((file) => file.op === 'listed') ?? [];
  const earlierAnswers = data?.answers.filter((answer) => answer.when === 'before') ?? [];
  const env = data?.internals.find((item) => item.kind === 'Environment')?.fields;

  return <section className="rt-view">
    <header className="rt-view-head">
      <div><span className="eyebrow">LAB</span><h1>What the model was working from</h1>
        <p className="rt-muted rt-sub">{oneLine(trace.title, 120)} · {new Date(trace.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
</p></div>
    </header>
    {data && <ContextWindow data={data} />}
    {error && <p role="alert" className="verify-error">{error}</p>}
    {!data && !error && <p className="rt-empty">Loading the context…</p>}
    {data && <div className="rt-boxes">
      <section className="rt-box">
        <h2><span>A</span> You asked before</h2>
        {!data.earlierPrompts.length ? <p className="rt-muted">This was the first prompt in this conversation, so nothing you asked earlier was in context.</p> :
          <ol className="rt-box-list">{data.earlierPrompts.map((item, index) => <li key={item.index}>
            {data.summary?.prompts[index] ?? oneLine(item.text)}
          </li>)}</ol>}
        {summarizing && <p className="rt-muted">Summarising…</p>}
      </section>

      <section className="rt-box rt-box-wide">
        <h2><span>B</span> The model brought</h2>
        <p className="rt-box-note">{earlierAnswers.length
          ? data.summary?.answers || `${earlierAnswers.length} earlier answer${earlierAnswers.length === 1 ? '' : 's'}: ${oneLine(earlierAnswers.at(-1)!.text, 120)}`
          : 'No earlier answers: it started this conversation with your question.'}</p>
        {reads.length ? <ul className="rt-files" title="Inferred from the commands the model ran, not observed at the file level.">
          {reads.map((file) => <FileRow key={`${file.op}:${file.path}`} file={file} traceId={trace.id} onTest={canTest(file) ? () => testImpact(file) : undefined} />)}
        </ul> : <p className="rt-muted">No file contents reached the model.</p>}
        {listed.length > 0 && <details className="rt-listed"><summary>listed {listed.length} location{listed.length === 1 ? '' : 's'}</summary>
          <ul className="rt-files">{listed.map((file) => <FileRow key={`${file.op}:${file.path}`} file={file} traceId={trace.id} />)}</ul></details>}
        <p className="rt-box-foot">Tokens are estimates of what each file added to the context window. “used” means words from the file reappear in what the model wrote later. Test impact reruns the next step without it.</p>
      </section>

      <section className="rt-box">
        <h2><span>C</span> Internals</h2>
        <ul className="rt-internals">{data.internals.map((item) => <li key={item.kind}>
          <details><summary><strong>{item.kind}</strong><span>~{k(est(item.chars))} tokens</span></summary>
            {item.kind === 'Environment' && env ? <dl>{Object.entries(env).map(([name, value]) => <div key={name}><dt>{name.replace(/_/g, ' ')}</dt><dd>{value}</dd></div>)}</dl>
              : item.names ? <p className="rt-muted">{item.names.join(', ')}</p> : null}
            <a className="link-button" href={itemUrl(trace.id, item.context_index)} target="_blank" rel="noreferrer">Open full text ↗</a>
          </details>
        </li>)}</ul>
        {!data.internals.some((item) => item.kind === 'AGENTS.md') && <p className="rt-muted">No AGENTS.md was loaded.</p>}
      </section>
    </div>}

    <details className="rt-test" ref={testRef} open={testing} onToggle={(event) => setTesting(event.currentTarget.open)}>
      <summary><FlaskConical size={14} /> Test it: rerun a step with part of its context changed</summary>
      {steps.length ? <>
        <label htmlFor="lab-step" className="workspace-label">STEP</label>
        <NativeSelect id="lab-step" className="trace-picker" value={step ? key(step) : ''} onChange={(event) => { setFocusCall(null); onStep(event.target.value); }}>
          {steps.map((item) => <NativeSelectOption key={key(item)} value={key(item)}>{item.title} · {item.detail.slice(0, 80)}</NativeSelectOption>)}
        </NativeSelect>
        {testing && step && <div className="rt-lab-body"><DecisionLab key={`${key(step)}:${focusCall ?? ''}`} selected={step} focusCallId={focusCall} /></div>}
      </> : <p className="rt-empty">This prompt proposed no tool calls, so there is no step to rerun.</p>}
    </details>
  </section>;
}
