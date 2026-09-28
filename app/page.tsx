'use client';

// The shell: four sections, each answering one question, linked to each other.
//   Prompts     what was asked and what came back (all prompts, by day)
//   Tool calls  how the agent got there, for one prompt
//   Sandbox     what actually ran, for one prompt
//   Lab         what if one step had been different
// Which section and prompt are open lives in the URL, so every cross-link is a
// real link and Back works.
import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, MessagesSquare, ShieldCheck, Waypoints, Wrench } from 'lucide-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { type Trace } from './types';
import { DecisionLab, type SelectedStep } from './decision-lab';
import { PromptsView } from './prompts-view';
import { ToolCallsView } from './tool-calls-view';
import { SandboxView } from './sandbox-view';

const PROXY_BASE = 'http://127.0.0.1:8797';
type View = 'prompts' | 'calls' | 'sandbox' | 'lab';
type Place = { view: View; trace: string; call: string | null; step: string | null };
const VIEWS: View[] = ['prompts', 'calls', 'sandbox', 'lab'];

function readPlace(): Place {
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const view = query.get('view') as View | null;
  return { view: view && VIEWS.includes(view) ? view : 'prompts', trace: query.get('trace') ?? '', call: query.get('call'), step: query.get('step') };
}
function writePlace(place: Place) {
  const query = new URLSearchParams();
  if (place.view !== 'prompts') query.set('view', place.view);
  if (place.trace) query.set('trace', place.trace);
  if (place.call) query.set('call', place.call);
  if (place.step) query.set('step', place.step);
  const search = query.toString();
  window.history.pushState(null, '', search ? `?${search}` : window.location.pathname);
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';
const stepKey = (step: { exchange_id?: string; output_index?: number }) => `${step.exchange_id}:${step.output_index}`;

export default function Home() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [place, setPlace] = useState<Place>({ view: 'prompts', trace: '', call: null, step: null });

  useEffect(() => {
    setPlace(readPlace());
    const onPop = () => setPlace(readPlace());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((next: Partial<Place>) => {
    setPlace((prev) => { const value = { ...prev, call: null, step: null, ...next }; writePlace(value); return value; });
  }, []);

  // Every captured prompt, not only the latest session: the activity graph
  // and the prompt list span the whole history.
  useEffect(() => {
    let closed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`${PROXY_BASE}/raytace/traces?scope=history`);
        if (!response.ok) throw new Error('Proxy unavailable');
        const data = await response.json() as { traces: Trace[] };
        if (!closed) { setTraces(data.traces || []); setConnected(true); }
      } catch { if (!closed) setConnected(false); }
      if (!closed) { setLoaded(true); timer = setTimeout(load, 5000); }
    };
    void load(); return () => { closed = true; clearTimeout(timer); };
  }, []);

  const trace = traces.find((item) => item.id === place.trace);
  const calls = trace?.callVerifications ?? [];
  const steps: SelectedStep[] = calls.map((call, index) => ({ exchange_id: call.exchange_id, output_index: call.output_index, title: `#${index + 1} ${call.name}`, detail: call.proposed ?? call.name }));
  const step = steps.find((item) => stepKey(item) === place.step) ?? steps[0];

  const nav: { view: View; label: string; icon: typeof Wrench }[] = [
    { view: 'prompts', label: 'Prompts', icon: MessagesSquare },
    { view: 'calls', label: 'Tool calls', icon: Wrench },
    { view: 'sandbox', label: 'Sandbox evidence', icon: ShieldCheck },
    { view: 'lab', label: 'Lab', icon: FlaskConical },
  ];

  function noPrompt() {
    return <section className="rt-view"><p className="rt-empty">
      {loaded && place.trace && !trace ? 'That prompt is no longer in the loaded history.' : 'Choose a prompt first.'}{' '}
      <button type="button" className="link-button" onClick={() => go({ view: 'prompts' })}>Go to Prompts</button>
    </p></section>;
  }

  return <main className="rt-shell">
    <aside className="nav rt-nav">
      <div className="brand"><Waypoints size={22} /> RayTrace</div>
      <nav className="nav-destinations">
        {nav.map(({ view, label, icon: Icon }) => <button key={view} type="button" className={`nav-item ${place.view === view ? 'active' : ''}`}
          onClick={() => go({ view, trace: place.trace })}><Icon size={16} /> {label}</button>)}
      </nav>
      {trace && <div className="rt-viewing">
        <span className="workspace-label">VIEWING</span>
        <button type="button" onClick={() => go({ view: 'prompts', trace: trace.id })} title={trace.title}>{firstLine(trace.title)}</button>
        <small>{new Date(trace.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
      </div>}
      <div className="nav-bottom"><span className={`status ${connected ? '' : 'offline'}`}><i />{connected ? 'CONNECTED' : 'PROXY OFFLINE'}</span></div>
    </aside>

    {place.view === 'prompts' && <PromptsView traces={traces} selectedId={place.trace}
      onSelect={(id) => go({ view: 'prompts', trace: id })}
      onOpen={(view, id) => go({ view, trace: id })} />}

    {place.view === 'calls' && (trace ? <ToolCallsView key={trace.id} trace={trace} traces={traces} focusCall={place.call}
      onOpenSandbox={(callId) => go({ view: 'sandbox', trace: trace.id, call: callId ?? null })}
      onOpenLab={(selected) => go({ view: 'lab', trace: trace.id, step: stepKey(selected) })} /> : noPrompt())}

    {place.view === 'sandbox' && (trace ? <SandboxView key={trace.id} trace={trace} focusCall={place.call}
      onOpenCall={(callId) => go({ view: 'calls', trace: trace.id, call: callId ?? null })} /> : noPrompt())}

    {place.view === 'lab' && (trace ? <section className="rt-view rt-lab">
      <header className="rt-view-head"><div><span className="eyebrow">LAB</span><h1>What if this step were different?</h1></div></header>
      {steps.length ? <>
        <label htmlFor="lab-step" className="workspace-label">STEP</label>
        <NativeSelect id="lab-step" className="trace-picker" value={step ? stepKey(step) : ''}
          onChange={(event) => go({ view: 'lab', trace: trace.id, step: event.target.value })}>
          {steps.map((item) => <NativeSelectOption key={stepKey(item)} value={stepKey(item)}>{item.title} · {item.detail.slice(0, 80)}</NativeSelectOption>)}
        </NativeSelect>
        <div className="rt-lab-body"><DecisionLab key={step ? stepKey(step) : 'none'} selected={step} /></div>
      </> : <p className="rt-empty">This prompt proposed no tool calls, so there is no step to experiment on.</p>}
    </section> : noPrompt())}
  </main>;
}
