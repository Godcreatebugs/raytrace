'use client';

import { useMemo, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, CircleDot, FileCode2, FlaskConical, FolderSearch2, GitBranch, Play, Search, ShieldCheck, TerminalSquare, Waypoints, X } from 'lucide-react';

type EventKind = 'model' | 'search' | 'read' | 'edit' | 'test';
const events: { kind: EventKind; title: string; detail: string; time: string }[] = [
  { kind: 'model', title: 'Model decision', detail: 'claude-sonnet-4 · 2.1k input', time: '14:22:01.042' },
  { kind: 'search', title: 'Search repository', detail: 'rg "refreshToken" src test', time: '14:22:03.184' },
  { kind: 'read', title: 'Read src/auth.ts', detail: 'lines 42–128 · 86 lines', time: '14:22:04.223' },
  { kind: 'model', title: 'Model decision', detail: 'Tool selection · 3.0k input', time: '14:22:05.116' },
  { kind: 'edit', title: 'Edit src/auth.ts', detail: '+8 −3 · refresh expiry guard', time: '14:22:08.907' },
  { kind: 'test', title: 'Run focused tests', detail: 'pnpm test auth · passed', time: '14:22:11.518' },
];
const kindIcon = { model: Braces, search: Search, read: FileCode2, edit: GitBranch, test: TerminalSquare };

export default function Home() {
  const [selected, setSelected] = useState(0);
  const [removed, setRemoved] = useState(false);
  const [mode, setMode] = useState<'decision' | 'trajectory'>('decision');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const current = events[selected]; const Icon = kindIcon[current.kind];
  const prediction = useMemo(() => !removed ? 'Read src/auth.ts' : mode === 'decision' ? 'Search “refreshToken”' : 'Read src/middleware.ts', [removed, mode]);
  function runFork() { setRunning(true); setResult(null); window.setTimeout(() => { setRunning(false); setResult(prediction); }, 800); }
  return <main className="app-shell">
    <aside className="nav"><div className="brand"><span className="brand-mark"><Waypoints size={19} /></span> raytace</div><div className="workspace-label">WORKSPACE</div><button className="project-switch">acme / web-api <ChevronDown size={15} /></button><nav><a className="nav-item active"><CircleDot size={17} /> Traces <span>12</span></a><a className="nav-item"><GitBranch size={17} /> Experiments</a><a className="nav-item"><FolderSearch2 size={17} /> Evidence</a></nav><div className="nav-bottom"><ShieldCheck size={16} /> Payloads redacted</div></aside>
    <section className="trace-column"><header className="topbar"><div><span className="eyebrow">TRACE / TR_01HZX4</span><h1>Repair refresh-token expiry check</h1></div><div className="status"><i /> COMPLETE</div></header><div className="trace-meta"><span>Claude Code</span><b>→</b><span>claude-sonnet-4</span><b>·</b><span>18.4k tokens</span><b>·</b><span>12.8 sec</span></div><div className="timeline-head"><span>EXECUTION TIMELINE</span><span>6 observed events</span></div><div className="timeline">{events.map((event, index) => { const EventIcon = kindIcon[event.kind]; return <button key={event.time} onClick={() => setSelected(index)} className={`event ${selected === index ? 'selected' : ''}`}><span className={`event-icon ${event.kind}`}><EventIcon size={16} /></span><span className="event-copy"><strong>{event.title}</strong><small>{event.detail}</small></span><time>{event.time}</time><ChevronRight className="event-arrow" size={16} /></button>; })}</div>
      <section className="decision-card"><div className="card-kicker"><Icon size={15} /> SELECTED EVENT <span>OBSERVED</span></div><h2>{current.title}</h2><pre>{selected === 0 ? 'tool_call: read_file\npath: src/auth.ts\nline_end: 128' : current.detail}</pre><div className="evidence-row"><span>Likely influenced by</span><button onClick={() => setRemoved(!removed)} className={removed ? 'evidence removed' : 'evidence'}>{removed ? <X size={13} /> : <FileCode2 size={13} />} Failing test output</button><button className="evidence"><Search size={13} /> Search result #1</button></div></section>
    </section>
    <aside className="fork-panel"><div className="fork-heading"><div><span className="eyebrow">LIVE EXPERIMENT</span><h2>Fork this decision</h2></div><FlaskConical size={20} /></div><div className="fork-tabs"><button className={mode === 'decision' ? 'tab-on' : ''} onClick={() => setMode('decision')}>Decision</button><button className={mode === 'trajectory' ? 'tab-on' : ''} onClick={() => setMode('trajectory')}>Trajectory</button></div><p className="fork-copy">{mode === 'decision' ? 'Replay only the selected model call with an exact context snapshot.' : 'Continue the agent in an isolated project snapshot.'}</p><label className="input-label">EVIDENCE VARIANT</label><button className={`variant ${removed ? 'variant-off' : ''}`} onClick={() => setRemoved(!removed)}><span><FileCode2 size={15} /> Failing test output</span><span className="toggle"><i /></span></button><label className="input-label">MODEL</label><button className="select-control">claude-sonnet-4 <ChevronDown size={16} /></button><div className="budget"><span>Estimated upper bound</span><strong>{mode === 'decision' ? '1.2k tokens' : '20 steps · 24k tokens'}</strong><small>Sandboxed · network disabled</small></div><button className="run-button" onClick={runFork} disabled={running}><Play size={15} fill="currentColor" /> {running ? 'Replaying…' : 'Run fork'}</button>{result && <div className="fork-result"><span>LIKELY NEXT ACTION</span><strong>{result}</strong><small>{removed ? 'Changed after withholding one evidence item.' : 'Matches observed branch.'}</small></div>}<div className="legend"><span><i className="dot observed" /> Observed</span><span><i className="dot inferred" /> Inferred</span><span><i className="dot forked" /> Forked</span></div></aside>
  </main>;
}
