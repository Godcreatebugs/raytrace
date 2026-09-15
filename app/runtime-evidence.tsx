'use client';
import { useEffect, useState } from 'react';
type Event = { event_id: number; kind: string; timestamp_ns?: string; pid?: number; ppid?: number; argv?: string[]; exit_code?: number | null; signal?: number | null; process_start_ns?: string };
type Page = { events: Event[]; next_before: number | null; gaps: number; error?: string };
export function RuntimeEvidence({ sandboxId }: { sandboxId?: string }) {
  const [cursor, setCursor] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!sandboxId) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:8797/raytace/runtime?sandbox=${encodeURIComponent(sandboxId)}&before=${cursor}`, { signal: controller.signal });
        const value = await response.json() as Page;
        if (!response.ok) throw Error(value.error || 'Runtime evidence unavailable');
        if (!stopped) { setData(value); setError(''); }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Runtime evidence unavailable'); }
      if (!stopped && !cursor) timer = setTimeout(load, 3000);
    };
    setData(null); void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [sandboxId, cursor]);
  return <details style={{ margin: '16px 0', padding: 16, border: '1px solid #64748b', borderRadius: 8 }}>
    <summary>Independent sandbox execution evidence</summary>
    {!sandboxId ? <p>No sandbox mapping for this capture. Agent logs alone do not confirm execution.</p> : <>
      <p><code>{sandboxId}</code></p>
      <p>Whole-sandbox timeline, not an exact tool-call match. Other prompts and background processes may appear. Successful exec proves a program started, not that its output or the answer is correct.</p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading runtime events…</p>}
      {data && <><p>Selected process events; completeness not certified. Collector-wide gaps/errors: {data.gaps}. Missing evidence is not proof of non-execution.</p>
      <button onClick={() => setCursor(0)} disabled={!cursor}>Latest</button>{' '}
      <button onClick={() => setCursor(data.next_before!)} disabled={!data.next_before}>Older events</button>
      <div style={{ overflowX: 'auto', maxHeight: 500 }}><table style={{ width: '100%', textAlign: 'left' }}><thead><tr><th>Time</th><th>Evidence</th><th>PID / parent</th><th>Command / result</th></tr></thead><tbody>
      {data.events.map(e => <tr key={e.event_id}>
        <td>{e.timestamp_ns ? new Date(Number(BigInt(e.timestamp_ns) / BigInt(1000000))).toLocaleTimeString() : '—'}</td>
        <td>{e.kind === 'exec_succeeded' ? 'Execution confirmed' : e.kind === 'process_exit' ? 'Process finished' : e.kind}</td>
        <td>{e.pid} / {e.ppid}</td>
        <td><code style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.argv ? JSON.stringify(e.argv) : `exit=${e.exit_code ?? 'unknown'} signal=${e.signal ?? 'none'}`}</code><small> · event #{e.event_id} · process start {e.process_start_ns}</small></td>
      </tr>)}</tbody></table></div>{!data.events.length && <p>No matching runtime events recorded.</p>}</>}
    </>}
  </details>;
}
