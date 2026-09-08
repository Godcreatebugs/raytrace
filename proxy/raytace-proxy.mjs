#!/usr/bin/env node
/** Local API recorder. Point a compatible client at http://127.0.0.1:8787. */
import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const port = Number(process.env.RAYTACE_PORT || 8787);
const store = process.env.RAYTACE_STORE || join(process.cwd(), '.raytace', 'events.jsonl');
const upstreams = { openai: process.env.RAYTACE_OPENAI_UPSTREAM || 'https://api.openai.com', anthropic: process.env.RAYTACE_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com' };
const maxBodyBytes = Number(process.env.RAYTACE_MAX_BODY_BYTES || 2_000_000);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    /authorization|api[-_]?key|token|secret|password/i.test(key) ? [key, '[REDACTED]'] : [key, redact(item)],
  ));
}
async function record(event) { await mkdir(dirname(store), { recursive: true }); await appendFile(store, `${JSON.stringify(event)}\n`); }
function provider(req) { return req.headers['anthropic-version'] || req.url?.startsWith('/v1/messages') ? 'anthropic' : 'openai'; }
function safeHeaders(headers) { const keep = ['content-type', 'anthropic-version', 'openai-beta', 'user-agent', 'x-request-id']; return Object.fromEntries(Object.entries(headers).filter(([key]) => keep.includes(key.toLowerCase()))); }

createServer(async (req, res) => {
  const parts = []; for await (const part of req) parts.push(part); const requestBody = Buffer.concat(parts);
  const traceId = req.headers['x-raytace-trace-id'] || req.headers['x-request-id'] || randomUUID(); const started = new Date().toISOString(); const selectedProvider = provider(req);
  let requestPayload = null; try { requestPayload = JSON.parse(requestBody); } catch { /* record only hash for non-JSON */ }
  try {
    const response = await fetch(`${upstreams[selectedProvider]}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'content-length', 'connection'].includes(key))), body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : requestBody, duplex: 'half' });
    const responseBody = Buffer.from(await response.arrayBuffer()); let responsePayload = null;
    if ((response.headers.get('content-type') || '').includes('application/json') && responseBody.length <= maxBodyBytes) try { responsePayload = JSON.parse(responseBody); } catch { /* record hash */ }
    await record({ event_type: 'model.exchange', trace_id: traceId, span_id: randomUUID(), parent_span_id: req.headers['x-raytace-parent-span-id'] || null, timestamp: started, completed_at: new Date().toISOString(), provider: selectedProvider, route: req.url, method: req.method, request: { headers: safeHeaders(req.headers), bytes: requestBody.length, sha256: hash(requestBody), payload: requestPayload && redact(requestPayload) }, response: { status: response.status, headers: safeHeaders(Object.fromEntries(response.headers)), bytes: responseBody.length, sha256: hash(responseBody), payload: responsePayload && redact(responsePayload) } });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(responseBody);
  } catch (error) { await record({ event_type: 'proxy.error', trace_id: traceId, timestamp: started, provider: selectedProvider, route: req.url, error: String(error) }); res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'raytace_proxy_upstream_error', trace_id: traceId })); }
}).listen(port, '127.0.0.1', () => console.log(`Raytace proxy listening on http://127.0.0.1:${port}`));
