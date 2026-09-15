import type { RequestMetric } from './request-metrics';
import type { ContextItem } from './types';
export type ComparisonTrace = { id: string; title: string; model: string; provider: string; startedAt: string; requests?: RequestMetric[]; events: { title: string; raw: string; exchange_id?: string }[]; evidence: ContextItem[] };
export type Action = { name: string; args: string };
function parse(raw: string) { try { return JSON.parse(raw); } catch { return {}; } }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? '';
}
export function actions(trace: ComparisonTrace): Action[] {
  return trace.events.filter(e => e.title.startsWith('Tool call:')).map(e => {
    const raw = parse(e.raw); let args = raw.arguments ?? raw.input ?? raw.function?.arguments ?? '';
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* plain arguments */ } }
    return { name: raw.name ?? raw.function?.name ?? e.title.slice(11), args: stable(args) };
  });
}
// Exact matches anchor the sequence. Pair same-name calls only within unmatched gaps.
export function alignActions(a: Action[], b: Action[]): { a?: Action; b?: Action; status: string }[] {
  const rows: { a?: Action; b?: Action; status: string }[] = [];
  if (a.length * b.length > 250000) return [...a.map(a => ({ a, status: 'Baseline only' })), ...b.map(b => ({ b, status: 'Comparison only' }))];
  const key = (x: Action) => `${x.name}\n${x.args}`;
  const dp = Array.from({length: a.length + 1}, () => new Uint32Array(b.length + 1));
  for (let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) dp[i][j]=key(a[i])===key(b[j]) ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j],dp[i][j+1]);
  let i=0,j=0; let left: Action[] = [], right: Action[] = [];
  function flush() {
    for (const item of left) { const match = right.findIndex(x => x.name === item.name); rows.push(match < 0 ? {a:item,status:'Removed'} : {a:item,b:right.splice(match,1)[0],status:'Arguments changed'}); }
    rows.push(...right.map(b => ({b,status:'Added'}))); left=[];right=[];
  }
  while(i<a.length || j<b.length) {
    if(i<a.length && j<b.length && key(a[i])===key(b[j])) { flush(); rows.push({a:a[i++],b:b[j++],status:'Same'}); }
    else if(i<a.length && (j===b.length || dp[i+1][j]>=dp[i][j+1])) left.push(a[i++]);
    else right.push(b[j++]);
  }
  flush(); return rows;
}
export function metrics(trace: ComparisonTrace) {
  const r=trace.requests ?? [];
  const total=(key:'cost'|'input'|'output'|'durationMs') => r.length && r.every(x => typeof x[key]==='number' && Number.isFinite(x[key])) ? r.reduce((n,x)=>n+x[key]!,0) : null;
  const starts=r.map(x=>Date.parse(x.startedAt)), ends=r.map(x=>Date.parse(x.completedAt ?? ''));
  return { cost:total('cost'), input:total('input'), output:total('output'), time:total('durationMs'), span:r.length && [...starts,...ends].every(Number.isFinite) ? Math.max(...ends)-Math.min(...starts) : null, calls:r.length || trace.events.filter(e=>e.title==='Context assembled').length, tools:actions(trace).length };
}
export function answer(trace: ComparisonTrace) {
  const event=trace.events.findLast(e=>e.title==='Model answer');
  if(!event) return 'No model answer captured.';
  const raw=parse(event.raw);
  const extract=(x: unknown): string => {
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.map(extract).join('\n');
    if (!x || typeof x !== 'object') return '';
    const value = x as { text?: unknown; content?: unknown };
    return typeof value.text === 'string' ? value.text : value.content ? extract(value.content) : '';
  };
  return extract(raw) || event.raw;
}
export function contextText(trace: ComparisonTrace, exchange: string) {
  return trace.evidence.filter(e=>e.exchange_id===exchange).map(e=>`[${e.kind}] ${e.label}\n${e.content ?? e.preview}${e.content === undefined ? '\n[Preview only]' : ''}`).join('\n\n') || 'No context captured.';
}
