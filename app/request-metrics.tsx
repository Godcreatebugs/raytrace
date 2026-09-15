export type RequestMetric = { id: string; model: string; startedAt: string; completedAt: string | null; input: number | null; output: number | null; cost: number | null; durationMs: number | null };
// Exported so the per-request breakdown can render inline on each timeline
// block (see app/page.tsx) instead of a separate dropdown.
export const money = (value: number | null) => value === null ? 'Unavailable' : value === 0 ? '$0' : value < .000001 ? '<$0.000001' : `$${value.toFixed(6)}`;
export const duration = (value: number | null) => value === null ? 'Unavailable' : `${(value / 1000).toFixed(2)} s`;
export const count = (value: number | null) => value === null ? '—' : value.toLocaleString();
export function RequestMetrics({ requests = [] }: { requests?: RequestMetric[] }) {
  if (!requests.length) return null;
  function total(key: 'cost' | 'durationMs' | 'input' | 'output') {
    const known = requests.filter(r => r[key] !== null);
    return { value: known.length ? known.reduce((sum, r) => sum + r[key]!, 0) : null, known: known.length };
  }
  const cost = total('cost'); const time = total('durationMs');
  const starts = requests.map(r => Date.parse(r.startedAt));
  const ends = requests.map(r => Date.parse(r.completedAt || ''));
  const span = [...starts, ...ends].every(Number.isFinite) ? Math.max(...ends) - Math.min(...starts) : null;
  return <section className="request-metrics" aria-label="Cost and latency">
    <div className="metric-summary">
      <div><span>Reported cost · USD</span><strong>{money(cost.value)}</strong><small>{cost.known}/{requests.length} calls reported{cost.known > 0 && cost.known < requests.length ? ' · partial total' : ''}</small></div>
      <div><span>Model request time</span><strong>{duration(time.value)}</strong><small>Sum of {time.known}/{requests.length} call durations</small></div>
      <div><span>Captured span</span><strong>{duration(span)}</strong><small>First request to last response</small></div>
    </div>
  </section>;
}
