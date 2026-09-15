import { gzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['native', 'openrouter']) test(`${mode}: HTTP capture → async trials → persistence; streams/settings preserved and writes origin-gated`, { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(),'raytace-trials-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const received = [];
  const upstream = createServer(async (req,res) => {
    let body = ''; for await (const part of req) body += part;
    const payload = JSON.parse(body); received.push({payload,authorization:req.headers.authorization,url:req.url,headers:req.headers});
    const kept = Array.isArray(payload.input) && payload.input.some((item)=>item.content === 'Search result: auth.ts');
    const result = { id:'fixture-response',status:'completed',output:[{type:'function_call',name:kept?'read_file':'search',arguments:kept?'{"path":"auth.ts"}':'{"query":"login"}'}] };
    if (payload.instructions?.startsWith('You analyze a captured model action')) {
      const source = JSON.parse(payload.input).earlier_context_excerpts[0];
      result.output = [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({hypotheses:[{evidence_id:source.evidence_id,title:'A context reference guided the action',explanation:'The prior context provided this reference.',excerpt:source.text.slice(0,40)}]}) }] }];
    }
    res.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip'});
    res.end(gzipSync(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:result})}\n\n`));
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  async function launch() {
    const child = spawn(process.execPath,['--disable-warning=ExperimentalWarning','proxy/raytace-proxy.mjs'],{env:{...process.env,RAYTACE_PORT:'0',RAYTACE_PROVIDER:mode,OPENROUTER_API_KEY:'router-secret',RAYTACE_OPENROUTER_MODEL:'coder',RAYTACE_OPENROUTER_UPSTREAM:`http://127.0.0.1:${upstream.address().port}/api`,RAYTACE_STORE:join(directory,'events.jsonl'),RAYTACE_OPENAI_UPSTREAM:`http://127.0.0.1:${upstream.address().port}`},stdio:['ignore','pipe','pipe']});
    const exited = once(child,'exit');
    t.after(async()=>{ if(child.exitCode===null)child.kill('SIGTERM'); await exited; });
    const url = await new Promise((resolve,reject)=>{
      child.stdout.on('data',(data)=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
      child.stderr.on('data',(data)=>reject(new Error(String(data))));
      child.on('exit',(code)=>reject(new Error(`Proxy exited: ${code}`)));
    });
    return {child,exited,url};
  }
  const first = await launch();
  const headers = {'content-type':'application/json','x-raytace-experiment':'1',origin:'http://localhost:3000'};
  let res = await fetch(`${first.url}/raytace/experiments`,{method:'POST',headers:{...headers,origin:'https://untrusted.example'},body:'{}'});
  assert.equal(res.status,403);
  res = await fetch(`${first.url}/raytace/experiments`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(res.status,403); assert.equal(received.length,0);
  const payload = {model:'fixture-model',stream:true,reasoning:{effort:'medium'},tools:[{type:'function',name:'read_file'}],input:[{type:'message',role:'user',content:'Search result: auth.ts'},{type:'message',role:'user',content:'Fix login'}]};
  res = await fetch(`${first.url}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-secret'},body:JSON.stringify(payload)});
  assert.equal(res.status,200); assert.match(await res.text(),/response.completed/);
  const traces = await fetch(`${first.url}/raytace/traces`).then((r)=>r.json());
  const trace = traces.traces[0]; const snapshot = JSON.parse(trace.events[0].raw);
  assert.equal(snapshot.replay_reason,null);assert.equal(trace.provider,mode === 'native' ? 'openai' : 'openrouter');
  const config = {exchange_id:snapshot.exchange_id,evidence_id:trace.evidence[0].id,repetitions:2,target:{type:'tool_contains',name:'read_file',contains:'auth.ts'}};
  res = await fetch(`${first.url}/raytace/experiments`,{method:'POST',headers,body:JSON.stringify(config)});
  assert.equal(res.status,202); assert.equal(res.headers.get('access-control-allow-origin'),'http://localhost:3000');
  let job = await res.json();
  for (let i=0; i<100 && ['running','queued'].includes(job.status); i++) { await new Promise((resolve)=>setTimeout(resolve,20)); job=await fetch(`${first.url}/raytace/experiments/${job.id}`).then((r)=>r.json()); }
  assert.equal(job.status,'completed'); assert.equal(job.trials.length,4);
  assert.equal(job.summary.baseline.rate,1); assert.equal(job.summary.intervention.rate,0);
  assert.equal(received.length,5);
  for(const item of received) {assert.equal(item.payload.stream,true);assert.deepEqual(item.payload.reasoning,payload.reasoning);assert.equal(item.authorization,mode === 'native' ? 'Bearer fixture-secret' : 'Bearer router-secret');assert.equal(item.payload.model,mode === 'native' ? 'fixture-model' : 'qwen/qwen3-coder');assert.equal(item.url,mode === 'native' ? '/v1/responses' : '/api/v1/responses');}
  // Persistence completes after the final progress update. Everything now lands
  // in SQLite, so scan the database bytes directly: that also proves no
  // credential reached disk through any table, blob, or journal.
  const onDisk = async () => (await Promise.all(['raytace.db','raytace.db-wal','raytace.db-journal']
    .map((name)=>readFile(join(directory,name),'utf8').catch(()=>'')))).join('');
  let saved=''; for(let i=0;i<100;i++){saved=await onDisk();if(saved.includes('"status":"completed"'))break;await new Promise((r)=>setTimeout(r,20));}
  assert.match(saved,/"status":"completed"/);
  assert.equal(saved.includes('fixture-secret'),false);
  assert.equal(saved.includes('router-secret'),false);
  first.child.kill('SIGTERM'); await first.exited;
  const second = await launch();
  const archivedStepResponse = await fetch(`${second.url}/raytace/steps/${snapshot.exchange_id}/0`);
  assert.equal(archivedStepResponse.status, 200);
  const archivedStep = await archivedStepResponse.json();
  assert.equal(archivedStep.decision.calls[0].name, 'read_file');
  assert.ok(archivedStep.evidence.length > 0);
  assert.match(archivedStep.replay_reason, /Saved log/);
  assert.equal(received.length, 5); // Inspection never invokes a provider.
  const history = await fetch(`${second.url}/raytace/experiments`).then((r)=>r.json());
  assert.equal(history.experiments[0].status,'completed');
  res=await fetch(`${second.url}/raytace/experiments`,{method:'POST',headers,body:JSON.stringify(config)});
  assert.equal(res.status,409); assert.equal(received.length,5);
  await fetch(`${second.url}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-secret'},body:JSON.stringify(payload)});
  const fresh = await fetch(`${second.url}/raytace/traces`).then(r=>r.json());
  assert.equal(fresh.traces.length,1);
  const allRuns = await fetch(`${second.url}/raytace/traces?scope=history`).then(r=>r.json());
  assert.equal(allRuns.traces.length,2);
  assert.ok(allRuns.traces.some(t=>t.id===trace.id));
  assert.ok(allRuns.traces.some(t=>t.id===fresh.traces[0].id));
  assert.equal(received.length,6); // Reading history makes no upstream calls.
  const selected = fresh.traces[0].events.find(event=>event.output_index === 0);
  assert.ok(selected?.exchange_id);
  const step = await fetch(`${second.url}/raytace/steps/${selected.exchange_id}/0`).then(r=>r.json());
  assert.equal(step.decision.calls[0].name,'read_file');
  res = await fetch(`${second.url}/raytace/step-runs`,{method:'POST',headers:{...headers,origin:'https://untrusted.example'},body:'{}'});
  assert.equal(res.status,403);
  res = await fetch(`${second.url}/raytace/step-runs`,{method:'POST',headers,body:JSON.stringify({exchange_id:selected.exchange_id,output_index:0,evidence_id:step.evidence[0].id,context:'No search result',model:mode === 'native' ? 'fixture-model' : 'coder',mode:'decision',repetitions:2,max_requests:1})});
  assert.equal(res.status,202); let stepJob = await res.json();
  for(let i=0;i<100 && ['queued','running'].includes(stepJob.status);i++){await new Promise(r=>setTimeout(r,20));stepJob=await fetch(`${second.url}/raytace/experiments/${stepJob.id}`).then(r=>r.json());}
  assert.equal(stepJob.status,'completed');assert.equal(stepJob.summary.baseline.rate,1);assert.equal(stepJob.summary.intervention.rate,0);
  if(mode === 'openrouter') {
    const before = received.length;
    const explain = () => fetch(`${second.url}/raytace/explanations`,{method:'POST',headers,body:JSON.stringify({exchange_id:selected.exchange_id,output_index:0})});
    const generated = await explain(); assert.equal(generated.status,200); assert.equal((await generated.json()).hypotheses.length,1);
    assert.equal((await explain()).status,200); assert.equal(received.length,before+1);
    assert.equal(received.at(-1).payload.model,'qwen/qwen3-coder');
    const reopened = await fetch(`${second.url}/raytace/steps/${selected.exchange_id}/0`).then(r=>r.json());
    assert.equal(reopened.explanation_generated,true);assert.equal(reopened.hypotheses.length,1);
  }

});
