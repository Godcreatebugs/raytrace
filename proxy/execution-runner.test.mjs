import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { executeSequence, copyWorkspace } from './execution-runner.mjs';
import { providerConfig } from './providers.mjs';
const exec = promisify(execFile);

test('execution copies current files, isolates secrets, forwards the selected model and enforces the request cap', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'raytace-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const bin = join(root, 'bin');
  await mkdir(source); await mkdir(bin); await exec('git', ['init', '-q'], { cwd: source });
  await writeFile(join(source, 'transaction.js'), 'original'); await writeFile(join(source, '.env'), 'SECRET=value');
  await symlink(join(source, '.env'), join(source, 'secret-link'));
  const copy = join(root, 'copy'); await mkdir(copy); await copyWorkspace(source, copy);
  assert.equal(await readFile(join(copy, 'transaction.js'), 'utf8'), 'original');
  await assert.rejects(readFile(join(copy, '.env'))); await assert.rejects(readFile(join(copy, 'secret-link')));
  const seen = [];
  const upstream = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; seen.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"completed","output":[]}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  // A fake Codex client exercises the actual gateway without running paid models.
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2); const base=a.find(x=>x.startsWith('model_providers.raytace_execution.base_url=')).split('=')[1].replaceAll('"',''); const cwd=a[a.indexOf('--cd')+1]; if(!a.includes('workspace-write')||!a.includes('never')||!a.includes('--ignore-user-config'))process.exit(3); fs.writeFileSync(cwd+'/transaction.js','edited copy'); let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',async()=>{for(let i=0;i<3;i++){const r=await fetch(base+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'wrong',input:prompt})});await r.text();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));} });`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const routing = providerConfig({ RAYTACE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test', RAYTACE_OPENROUTER_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` });
  const job = { id: 'test-run', model: routing.defaultModel, max_requests: 2, events: [] };
  await executeSequence(job, { input: [{ role: 'user', content: 'fix transaction' }] }, routing, source, join(root, 'runs'), new AbortController().signal);
  assert.equal(job.status, 'limited'); assert.equal(seen.length, 2); assert.equal(seen[0].model, routing.defaultModel);
  assert.equal(await readFile(join(source, 'transaction.js'), 'utf8'), 'original');
  assert.equal(await readFile(join(job.workspace, 'transaction.js'), 'utf8'), 'edited copy');
});
