'use client';
import { useEffect, useState } from 'react';
import type { ContextItem } from './types';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

const API = 'http://127.0.0.1:8797/raytace';
export type SelectedStep = { exchange_id?: string; output_index?: number; title: string; detail: string };
type Decision = { label: string; text: string; calls: { name: string; arguments: unknown }[] };
type Step = { explanation_generated: boolean; explanation_model: string; exchange_id: string; output_index: number; model: string; decision: Decision; replay_reason: string | null; evidence: ContextItem[]; hypotheses: { evidence_id: string; title: string; explanation: string; excerpt: string }[] };
type Arm = { successful: number; hits: number; rate: number | null; interval: number[] | null };
// Renamed from the earlier "Run" — the API's own field is already `experiments`,
// and "run" separately means a captured trace in run-comparison.tsx. One word,
// one meaning per concept.
type Experiment = { id: string; kind?: string; mode: string; exchange_id: string; output_index: number; evidence_id: string; model: string; status: string; cost: number; requests?: number; max_requests: number; workspace?: string; note?: string; error?: string; recorded: Decision; trials: { arm: string; status: string; matches?: boolean; outcome?: Decision; error?: string }[]; events: Record<string, unknown>[]; summary: { baseline: Arm; intervention: Arm } };
const busy = (experiment: Experiment) => ['queued', 'running'].includes(experiment.status);
const percent = (value: number | null) => value === null ? 'Not measured' : `${Math.round(value * 100)}%`;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', 'x-raytace-experiment': '1' }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`); return data;
}
function label(item: ContextItem) {
  if (item.preview.trim().startsWith('<skills_instructions>')) return 'Codex skill instructions';
  if (item.preview.trim().startsWith('<environment_context>')) return 'Environment context';
  return item.action || `${item.kind} · ${item.preview.replace(/\s+/g, ' ').slice(0, 55)}`;
}
export function DecisionLab({ selected }: { selected?: SelectedStep }) {
  const [step, setStep] = useState<Step | null>(null);
  const [models, setModels] = useState<{ alias: string; id: string }[]>([]);
  const [execution, setExecution] = useState(false);
  const [model, setModel] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [context, setContext] = useState('');
  const [mode, setMode] = useState('decision');
  const [count, setCount] = useState('3');
  const [limit, setLimit] = useState('10');
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [experimentId, setExperimentId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!selected?.exchange_id && selected.output_index !== undefined);
  const [starting, setStarting] = useState(false);
  const [explaining, setExplaining] = useState(false);
  useEffect(() => {
    let closed = false;
    api<{ models: { alias: string; id: string }[]; execution_available: boolean }>('/models').then((data) => { if (!closed) { setModels(data.models); setExecution(data.execution_available); } }).catch((error) => { if (!closed) setError(error.message); });
    return () => { closed = true; };
  }, []);
  useEffect(() => {
    let closed = false;
    if (!selected?.exchange_id || selected.output_index === undefined) return;
    api<Step>(`/steps/${selected.exchange_id}/${selected.output_index}`).then((data) => {
      if (closed) return; setStep(data); setModel(data.model);
      const source = data.evidence.find((item) => item.id === data.hypotheses[0]?.evidence_id) || data.evidence[0];
      setEvidenceId(source?.id || ''); setContext(source?.content ?? source?.preview ?? '');
    }).catch((error) => { if (!closed) setError(error.message); }).finally(() => { if (!closed) setLoading(false); });
    return () => { closed = true; };
  }, [selected?.exchange_id, selected?.output_index]);
  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const data = await api<{ experiments: Experiment[] }>('/experiments'); if (!closed) setExperiments(data.experiments); } catch { /* page shows connection status */ } if (!closed) timer = setTimeout(poll, 1500); };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, []);
  const source = step?.evidence.find((item) => item.id === evidenceId);
  const active = experiments.find(busy);
  const experiment = experiments.find((item) => item.id === experimentId);
  const repetitions = Number(count); const maxRequests = Number(limit);
  const valid = mode === 'decision' ? Number.isInteger(repetitions) && repetitions >= 2 && repetitions <= 20 : Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 20;
  function choose(id: string) { const item = step?.evidence.find((item) => item.id === id); setEvidenceId(id); setContext(item?.content ?? item?.preview ?? ''); }
  async function explain() {
    if (!step) return;
    setExplaining(true); setError('');
    try {
      const result = await api<{ hypotheses: Step['hypotheses']; model: string }>('/explanations', { exchange_id: step.exchange_id, output_index: step.output_index });
      setStep({ ...step, hypotheses: result.hypotheses, explanation_generated: true, explanation_model: result.model });
      if (result.hypotheses[0]) choose(result.hypotheses[0].evidence_id);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not generate explanations.'); }
    finally { setExplaining(false); }
  }
  async function start() {
    if (!step || !source || !valid) return;
    setStarting(true); setError('');
    try { const job = await api<Experiment>('/step-runs', { exchange_id: step.exchange_id, output_index: step.output_index, evidence_id: evidenceId, context, model, mode, repetitions: mode === 'decision' ? repetitions : 2, max_requests: mode === 'execute' ? maxRequests : 1 }); setExperiments((old) => [job, ...old]); setExperimentId(job.id); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not start run.'); } finally { setStarting(false); }
  }
  return <aside className="fork-panel lab decision-lab">
    <span className="eyebrow">COUNTERFACTUAL LAB</span><h2>Explore this decision</h2>
    {!step && !loading && !error && <p>Select a proposed tool call or model answer in the sequence.</p>}
    {loading && <output>Loading the context before this step…</output>}
    {error && <p className="experiment-error" role="alert">{error}</p>}
    {step && <>
      <section className="step-focus"><small>SELECTED STEP</small><h3>{selected?.title}</h3><p>{selected?.detail}</p></section>
      <h3>Possible explanations</h3><p className="lab-caption">{step.explanation_generated ? `Generated by ${step.explanation_model} from earlier context. These are hypotheses, not private reasoning.` : `Generate a short explanation using ${step.explanation_model}. One additional paid API request; saved for this step.`}</p>
      {!step.explanation_generated && <button type="button" className="run-button" disabled={explaining || !execution} onClick={explain}>{explaining ? 'Generating explanations…' : 'Generate explanations'}</button>}
      <ol className="hypothesis-list">{step.hypotheses.map((hypothesis, index) => {
        const result = experiments.find((item) => item.kind === 'step' && item.mode === 'decision' && item.exchange_id === step.exchange_id && item.output_index === step.output_index && item.evidence_id === hypothesis.evidence_id && item.model === model && item.status === 'completed');
        return <li key={hypothesis.evidence_id} className={hypothesis.evidence_id === evidenceId ? 'chosen' : ''}><button type="button" onClick={() => choose(hypothesis.evidence_id)}><span>{index + 1}</span><strong>{hypothesis.title}</strong></button>
          <p>{result ? `Action repeated: ${percent(result.summary.baseline.rate)} original / ${percent(result.summary.intervention.rate)} edited` : 'Action repeat rate: not measured'}</p>
          <details><summary>Supporting evidence</summary><p>{hypothesis.explanation}</p><blockquote>{hypothesis.excerpt}</blockquote></details>
        </li>;
      })}</ol>
      {step.explanation_generated && !step.hypotheses.length && <p>Insufficient evidence: no explanations with verifiable supporting quotes were returned.</p>}
      <h3>Edit and rerun</h3>
      <label htmlFor="step-context">Context to change</label>
      <NativeSelect id="step-context" className="lab-select" value={evidenceId} onChange={(event) => choose(event.target.value)}>{step.evidence.map((item) => <NativeSelectOption key={item.id} value={item.id}>#{item.index + 1} · {label(item)}</NativeSelectOption>)}</NativeSelect>
      <label htmlFor="edited-context">Edited context</label>
      <textarea id="edited-context" value={context} onChange={(event) => setContext(event.target.value)} spellCheck={false} rows={8} />
      <div className="context-actions"><button type="button" onClick={() => setContext(source?.content ?? source?.preview ?? '')}>Reset</button><button type="button" onClick={() => setContext('')}>Withhold text</button></div>
      <small>Only this context item changes. Other messages and tool history are retained.</small>
      <label htmlFor="step-model">Model</label>
      <NativeSelect id="step-model" className="lab-select" value={model} onChange={(event) => setModel(event.target.value)}>{!models.some((item) => item.id === step.model) && <NativeSelectOption value={step.model}>{step.model}</NativeSelectOption>}{models.map((item) => <NativeSelectOption key={item.alias} value={item.id}>{item.alias} · {item.id}</NativeSelectOption>)}</NativeSelect>
      <label htmlFor="run-mode">Run mode</label>
      <NativeSelect id="run-mode" className="lab-select" value={mode} onChange={(event) => setMode(event.target.value)}><NativeSelectOption value="decision">Replay model decision</NativeSelectOption><NativeSelectOption value="execute" disabled={!execution}>Execute and continue</NativeSelectOption></NativeSelect>
      {mode === 'decision' ? <><label htmlFor="step-count">Runs per version</label><input id="step-count" type="number" min={2} max={20} step={1} value={count} onChange={(event) => setCount(event.target.value)} /><p>{valid ? `${repetitions} original + ${repetitions} edited = ${repetitions * 2} paid API calls maximum.` : 'Enter a whole number from 2 to 20.'}</p><details className="raw-details"><summary>How this is measured</summary><p>Both use the selected model. Tools are not executed.</p></details></> : <><label htmlFor="step-limit">Maximum model requests</label><input id="step-limit" type="number" min={1} max={20} step={1} value={limit} onChange={(event) => setLimit(event.target.value)} /><p>One continuation in a separate copy of current project files, up to {valid ? maxRequests : '—'} paid requests and 3 minutes.</p><details className="raw-details"><summary>How this is measured</summary><p>Tools can edit the copy; network access and approval-requiring actions are blocked. Dependencies are not copied. This reconstructs the task from edited context; it is not an exact historical session resume.</p></details></>}
      {step.replay_reason && <p className="scope-note">{step.replay_reason}</p>}
      <button className="run-button" type="button" disabled={starting || !!active || !valid || !source || !!step.replay_reason} onClick={start}>{starting ? 'Starting…' : mode === 'decision' ? 'Compare responses' : 'Execute in project copy'}</button>
      {active && <div className="job-progress"><p>{active.mode === 'execute' ? `${active.requests || 0}/${active.max_requests} model requests` : `${active.trials?.length || 0}/${active.max_requests} trials`} · {active.status}</p><button type="button" onClick={() => api(`/experiments/${active.id}/cancel`, {}).catch((error) => setError(error.message))}>Cancel experiment</button></div>}
      {experiments.some((item) => item.kind === 'step' && item.exchange_id === step.exchange_id && item.output_index === step.output_index) && <><label htmlFor="step-run">Results for this action</label><NativeSelect id="step-run" className="lab-select" value={experimentId} onChange={(event) => setExperimentId(event.target.value)}><NativeSelectOption value="">Choose an experiment</NativeSelectOption>{experiments.filter((item) => item.kind === 'step' && item.exchange_id === step.exchange_id && item.output_index === step.output_index).map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.mode} · {item.model} · {item.status}</NativeSelectOption>)}</NativeSelect></>}
    </>}
    {experiment && <section className="trial-report"><h3>Original vs rerun</h3><p>{experiment.status} · {experiment.model}</p>{experiment.error && <p role="alert" className="error-text">{experiment.error}</p>}
      <details><summary>Original action</summary><pre>{JSON.stringify(experiment.recorded, null, 2)}</pre></details>
      {experiment.mode === 'decision' ? <><div className="frequency-grid">{([['Original context', experiment.summary.baseline], ['Edited context', experiment.summary.intervention]] as const).map(([name, arm]) => <section className="frequency" key={name}><h4>{name}</h4><strong>{percent(arm.rate)}</strong><p>{arm.hits}/{arm.successful} successful responses repeated the selected action</p>{arm.interval && <small>95% interval: {percent(arm.interval[0])}–{percent(arm.interval[1])}</small>}</section>)}</div><p className="lab-caption">These rates measure action repetition, not the probability an explanation is true.</p><details className="raw-details"><summary>How this is measured</summary><p>Small samples are uncertain. Answers require exact text matches.</p></details><p>Reported API cost: ${experiment.cost.toFixed(4)}</p>{experiment.trials.map((trial, index) => <details key={index}><summary>{index + 1}. {trial.arm === 'baseline' ? 'Original' : 'Edited'} · {trial.status === 'succeeded' ? trial.matches ? 'same action' : 'different response' : trial.status}</summary><pre>{trial.error || JSON.stringify(trial.outcome, null, 2)}</pre></details>)}</> : <><p>{experiment.note}</p>{experiment.workspace && <p>Files: <code>{experiment.workspace}</code></p>}<h4>New execution sequence</h4>{experiment.events.map((event, index) => <details key={index}><summary>{typeof event.type === 'string' ? event.type : 'Event'} {String((event.item as { type?: string })?.type || '')}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</>}
    </section>}
  </aside>;
}
