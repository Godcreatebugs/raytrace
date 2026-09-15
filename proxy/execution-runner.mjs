import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { routeRequest } from './providers.mjs';
const exec = promisify(execFile);

export async function copyWorkspace(source, destination) {
  const root = await realpath(source);
  const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 10_000_000 });
  let size = 0;
  for (const file of new Set(stdout.split('\0').filter(Boolean))) {
    if (file.split('/').some((part) => ['.git', '.codex', '.agents', '.raytace', 'node_modules', 'dist'].includes(part) || part.startsWith('.env')) || /\.(pem|key)$/i.test(file)) continue;
    const from = resolve(root, file); const to = resolve(destination, file);
    if (!from.startsWith(root + sep) || !to.startsWith(resolve(destination) + sep)) throw new Error('Invalid workspace path.');
    let stat; try { stat = await lstat(from); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || !(await realpath(from)).startsWith(root + sep)) continue;
    size += stat.size;
    if (size > 100_000_000) throw new Error('Workspace copy exceeds 100 MB.');
    await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
  }
}

export async function executeSequence(job, payload, routing, source, root, signal) {
  if (routing.mode !== 'openrouter') throw new Error('Full execution requires OpenRouter routing.');
  job.status = 'running';
  const directory = join(root, job.id); const workspace = join(directory, 'workspace'); const home = join(directory, 'home');
  await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
  await copyWorkspace(source, workspace);
  if (signal.aborted) { job.status = 'cancelled'; return; }
  job.workspace = workspace;
  job.note = 'Continuation from edited context using a copy of current project files, not a historical filesystem snapshot. Dependencies and credentials are not copied.';
  let requests = 0; let child; let stopped = false; let outputSize = 0;
  const stop = () => {
    stopped = true;
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, 1500); force.unref(); }
  };
  const deadline = AbortSignal.timeout(180_000);
  const controller = AbortSignal.any([signal, deadline]);
  const gateway = createServer(async (req, res) => {
    try {
      if (controller.aborted || stopped) { res.writeHead(409); return res.end('Run stopped.'); }
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(400); return res.end('Only Responses requests are supported.'); }
      if (requests >= job.max_requests) { job.limit_reached = true; res.writeHead(429); res.end('Run request limit reached.'); stop(); return; }
      const parts = []; let bytes = 0;
      for await (const part of req) { bytes += part.length; if (bytes > 2_000_000) throw new Error('Execution request too large.'); parts.push(part); }
      const input = JSON.parse(Buffer.concat(parts)); input.model = job.model;
      const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(input)));
      if (requests >= job.max_requests) { job.limit_reached = true; res.writeHead(429); res.end('Run request limit reached.'); stop(); return; }
      requests++; job.requests = requests;
      const response = await fetch(routed.url, { method: 'POST', headers: routed.headers, body: routed.body, signal: controller });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
      for await (const chunk of response.body) { if (controller.aborted) break; res.write(chunk); }
      res.end();
      if (!response.ok) { job.error = `Provider returned HTTP ${response.status}.`; stop(); }
    } catch (error) { job.error = error.message; if (!res.headersSent) res.writeHead(502); res.end(); stop(); }
  });
  try {
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    const args = ['-a', 'never', '-c', 'model_provider="raytace_execution"',
      '-c', 'model_providers.raytace_execution.name="RayTrace execution"', '-c', 'model_providers.raytace_execution.wire_api="responses"',
      '-c', `model_providers.raytace_execution.base_url="http://127.0.0.1:${gateway.address().port}/v1"`,
      '-c', 'sandbox_workspace_write.network_access=false',
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', '--cd', workspace, '--model', job.model, '-'];
    const context = JSON.stringify({ instructions: payload.instructions, input: payload.input }, null, 2).split(source).join(workspace);
    const prompt = `Continue the user's task from the supplied edited conversation context, before the next model decision. Use your available tools in this workspace. The original selected action has not been supplied: decide what to do next. Work only in this copy. Do not publish, send messages, or perform external side effects. Dependencies may be absent. If blocked, explain and stop.\n\n${context}`;
    child = spawn('codex', args, { cwd: workspace, detached: true, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    controller.addEventListener('abort', stop, { once: true });
    if (controller.aborted) stop();
    let pending = ''; let stderr = '';
    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > 2_000_000) { job.error = 'Execution log exceeded 2 MB.'; stop(); return; }
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) { try { const event = JSON.parse(line); job.events.push(event); } catch { /* partial diagnostic */ } }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    const [code] = await once(child, 'close');
    controller.removeEventListener('abort', stop);
    job.status = signal.aborted ? 'cancelled' : deadline.aborted || job.limit_reached ? 'limited' : code === 0 && !job.error ? 'completed' : 'failed';
    if (job.status === 'failed' && !job.error) job.error = stderr || `Codex exited with code ${code}.`;
    await writeFile(join(directory, 'result.json'), JSON.stringify({ status: job.status, events: job.events, note: job.note }, null, 2));
  } finally { gateway.closeAllConnections(); gateway.close(); }
}
