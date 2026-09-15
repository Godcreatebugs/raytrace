'use client';
import { useEffect, useState } from 'react';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { actions, alignActions, metrics, answer, contextText, type ComparisonTrace } from './run-comparison-data';
function TextDiff({ title, a, b }: { title: string; a: string; b: string }) {
  const left=new Set(a.split('\n')),right=new Set(b.split('\n'));
  return <details className="compare-detail"><summary>{title} · {a===b ? 'Same' : 'Different'}</summary><p>Highlighted lines occur only on that side.</p><details><summary>How this is measured</summary><p>Line order is preserved; this is not a word-level diff.</p></details><div className="compare-pair">{[a,b].map((text,side)=><div key={side}><h4>{side ? 'Comparison' : 'Baseline'}</h4><pre>{text.split('\n').map((line,i)=><span className={!(side ? left : right).has(line) ? 'diff-line' : ''} key={i}>{line || ' '} {'\n'}</span>)}</pre></div>)}</div></details>;
}
function Results({ a,b }: {a: ComparisonTrace;b: ComparisonTrace}) {
  const [ai,setAi]=useState(''),[bi,setBi]=useState('');
  const exchanges=(t:ComparisonTrace)=>t.events.filter(e=>e.title==='Context assembled').map(e=>{try{return JSON.parse(e.raw).exchange_id as string;}catch{return '';}}).filter(Boolean);
  const ax=exchanges(a),bx=exchanges(b),ae=ax.includes(ai)?ai:ax[0]??'',be=bx.includes(bi)?bi:bx[0]??'';
  const ma=metrics(a),mb=metrics(b); const aa=actions(a),bb=actions(b); const aligned=alignActions(aa,bb);
  const format=(v:number|null,unit:string)=>v===null?'Unavailable':unit==='$'?`$${v.toFixed(6)}`:unit==='s'?`${(v/1000).toFixed(2)} s`:v.toLocaleString();
  const fields=[['cost','Reported cost','$'],['span','Elapsed time','s'],['time','Summed request time','s'],['input','Input tokens',''],['output','Output tokens',''],['calls','API calls',''],['tools','Proposed tool calls','']] as const;
  return <><div className="compare-pair compare-identities">{[a,b].map((t,i)=><div key={t.id}><h3>{i?'Comparison':'Baseline'}</h3><p>{t.provider} · {[...new Set(t.requests?.map(r=>r.model) ?? [t.model])].join(', ')}</p><small>{new Date(t.startedAt).toLocaleString()}</small></div>)}</div>
    <p className="compare-notice">{a.title===b.title?'Prompt titles match.':'Starting prompts differ.'}</p><details className="compare-detail"><summary>How this is measured</summary><p className="compare-note">Review captured context below before interpreting changes. Lower cost or time does not establish answer quality.</p></details>
    <div className="metrics-table"><table><thead><tr><th>Metric</th><th>Baseline</th><th>Comparison</th><th>Change (B − A)</th></tr></thead><tbody>{fields.map(([key,label,unit])=>{const x=ma[key],y=mb[key],d=x===null||y===null?null:y-x;return <tr key={key}><th>{label}</th><td>{format(x,unit)}</td><td>{format(y,unit)}</td><td>{d===null?'Unavailable':`${d>0?'+':''}${format(d,unit)}${x===0?' · % unavailable':` (${d>0?'+':''}${(d/x!*100).toFixed(1)}%)`}`}</td></tr>;})}</tbody></table></div>
    <p className="compare-note">Totals require every call to report the metric.</p><details className="compare-detail"><summary>How this is measured</summary><p className="compare-note">Elapsed time spans the first request to the last response; summed time can include overlapping calls.</p></details>
    <TextDiff title="Starting prompt" a={a.title} b={b.title}/>
    <section><h3>Execution differences</h3><p>{aligned.filter(r=>r.status==='Same').length} matching · {aligned.filter(r=>r.status==='Added').length} added · {aligned.filter(r=>r.status==='Removed').length} removed · {aligned.filter(r=>r.status==='Arguments changed').length} changed</p><p className="compare-note">Exact tool names and arguments anchor matches.</p><details className="compare-detail"><summary>How this is measured</summary><p className="compare-note">Same-name calls between anchors are paired as possible argument changes. Reordered calls may appear as added and removed. Each repeated call stays separate; carried tool results are excluded.</p></details>{aa.length*bb.length>250000&&<p>These runs exceed the alignment limit. Calls are listed separately.</p>}
    {aligned.length ? aligned.map((r,i)=><details className="compare-detail" key={i}><summary>{r.status} · {r.a?.name??r.b?.name}</summary><div className="compare-pair"><pre>{r.a?.args??'No call'}</pre><pre>{r.b?.args??'No call'}</pre></div></details>):<p>No proposed tool calls captured.</p>}</section>
    <section><h3>Captured context by request</h3><div className="compare-pair">{[ax,bx].map((ids,side)=><label key={side}>{side?'Comparison request':'Baseline request'}<NativeSelect value={side?be:ae} onChange={e=>(side?setBi:setAi)(e.target.value)}>{!ids.length&&<NativeSelectOption value="">No requests</NativeSelectOption>}{ids.map((id,i)=><NativeSelectOption key={id} value={id}>Request {i+1}</NativeSelectOption>)}</NativeSelect></label>)}</div><TextDiff title="Instructions, messages, and tool results" a={contextText(a,ae)} b={contextText(b,be)}/></section>
    <TextDiff title="Last captured model answer" a={answer(a)} b={answer(b)}/>
  </>;
}
export function RunComparison({traces: liveTraces,currentId}:{traces:ComparisonTrace[];currentId:string}) {
  const [history,setHistory]=useState<ComparisonTrace[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const traces=[...new Map([...history,...liveTraces].map(t=>[t.id,t])).values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  const [open,setOpen]=useState(false),[base,setBase]=useState(''),[other,setOther]=useState('');
  useEffect(()=>{
    if(!open) return;
    const controller=new AbortController(); setLoading(true);setError('');
    fetch('http://127.0.0.1:8797/raytace/traces?scope=history',{signal:controller.signal}).then(async response=>{
      if(!response.ok) throw new Error('Could not load saved runs. Check that the proxy is running with the latest version.');
      const data=await response.json() as {traces:ComparisonTrace[]}; if(!Array.isArray(data.traces)) throw new Error('Invalid saved-run response.');
      setHistory(data.traces);
    }).catch(err=>{if(!controller.signal.aborted)setError(err.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,retry]);
  const a=traces.find(t=>t.id===base),b=traces.find(t=>t.id===other);
  return <Sheet open={open} onOpenChange={value=>{setOpen(value);if(value){setBase(currentId||traces[0]?.id||'');setOther('');}}}><SheetTrigger className="graph-open-button">Compare runs</SheetTrigger><SheetContent className="run-compare-panel"><SheetHeader><SheetTitle>Compare runs</SheetTitle><SheetDescription>Compare saved captures. No new model calls are made.</SheetDescription></SheetHeader><div className="compare-body">{loading&&<output>Loading saved runs…</output>}{error&&<p role="alert">{error} <button className="graph-open-button" onClick={()=>setRetry(n=>n+1)}>Retry</button></p>}<p className="compare-note">Most recent 100 saved runs across sessions. Reopen to refresh history.</p><div className="compare-pair">{[base,other].map((value,i)=><label key={i}>{i?'Comparison run':'Baseline run'}<NativeSelect value={value} onChange={e=>(i?setOther:setBase)(e.target.value)}><NativeSelectOption value="">Choose a captured run</NativeSelectOption>{traces.map(t=><NativeSelectOption key={t.id} value={t.id}>{new Date(t.startedAt).toLocaleString()} · {t.model} · {t.title.slice(0,90)}</NativeSelectOption>)}</NativeSelect></label>)}</div>{loading ? null : traces.length<2?<p>Capture at least two runs to compare them. Try the same task with a different prompt or model.</p>:!a||!b?<p>Select two saved runs to see cost, timing, execution, context, and answer differences.</p>:a.id===b.id?<p>Choose two different runs.</p>:<Results key={`${a.id}-${b.id}`} a={a} b={b}/>}</div></SheetContent></Sheet>;
}
