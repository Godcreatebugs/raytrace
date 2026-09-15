import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A deliberately small user-facing check: this is the shortest path proving
// the three things a local install must provide — capture, inspection, and a
// persisted counterfactual run — without Codex CLI or a paid provider.
test('smoke: capture → inspect → experiment', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raytace-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    const body = JSON.stringify({
      id: 'smoke-response', status: 'completed',
      output: [{ type: 'function_call', name: 'read_file', arguments: '{"path":"README.md"}' }],
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: JSON.parse(body) })}\n\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'proxy/raytace-proxy.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      RAYTACE_PORT: '0',
      RAYTACE_DB: join(directory, 'raytace.db'),
      RAYTACE_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'smoke-secret',
      RAYTACE_OPENROUTER_MODEL: 'coder',
      RAYTACE_OPENROUTER_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.stderr.on('data', (chunk) => reject(new Error(String(chunk))));
    child.on('exit', (code) => reject(new Error(`Proxy exited before startup (${code})`)));
  });

  const headers = { 'content-type': 'application/json', authorization: 'Bearer client-secret' };
  const captured = await fetch(`${url}/v1/responses`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'smoke-model', stream: false, input: [{ role: 'user', content: 'Inspect the README.' }] }),
  });
  assert.equal(captured.status, 200);
  const traces = await fetch(`${url}/raytace/traces`).then((response) => response.json());
  assert.equal(traces.traces.length, 1);
  const trace = traces.traces[0];
  const exchangeId = JSON.parse(trace.events[0].raw).exchange_id;
  const outputIndex = trace.events.find((event) => event.output_index === 0)?.output_index ?? 0;

  const inspected = await fetch(`${url}/raytace/steps/${exchangeId}/${outputIndex}`);
  assert.equal(inspected.status, 200);
  const step = await inspected.json();
  assert.equal(step.decision.calls[0].name, 'read_file');
  assert.ok(step.evidence.length > 0);

  const experiment = await fetch(`${url}/raytace/step-runs`, {
    method: 'POST',
    headers: { ...headers, origin: 'http://localhost:3000', 'x-raytace-experiment': '1' },
    body: JSON.stringify({
      exchange_id: exchangeId, output_index: outputIndex, evidence_id: step.evidence[0].id,
      context: 'README.md exists', model: 'coder', mode: 'decision', repetitions: 2, max_requests: 2,
    }),
  });
  assert.equal(experiment.status, 202);
  let job = await experiment.json();
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = await fetch(`${url}/raytace/experiments/${job.id}`).then((response) => response.json());
  }
  assert.equal(job.status, 'completed');
  assert.equal(job.trials.length, 4);
  const history = await fetch(`${url}/raytace/experiments`).then((response) => response.json());
  assert.equal(history.experiments[0].status, 'completed');
});
