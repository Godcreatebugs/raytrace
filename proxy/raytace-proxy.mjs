#!/usr/bin/env node
import { requestMetrics } from './request-metrics.mjs';
/** Local API recorder. Point a compatible client at http://127.0.0.1:8797. */
import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { evidenceFor, replayEligibility, createExperiment, runExperiment, outcome, proposedCommand } from './experiment-engine.mjs';
import { loadEnvFile } from 'node:process';
import { providerConfig, routeRequest, selectModel } from './providers.mjs';
import { latestSessionRows } from './prompt-traces.mjs';
import { inspectStep, createStepRun, runDecision } from './step-lab.mjs';
import { executeSequence } from './execution-runner.mjs';
import { explanationRequest, parseExplanations } from './explanations.mjs';
import { summaryRequest, parseSummary } from './summaries.mjs';
import { fold as foldEvents, describeAll, undescribed, describeRequest, parseDescriptions } from './exec-narrative.mjs';
import { matchBatch, OPEN_WINDOW_CAP_MS } from './execution-correlation.mjs';
import { startGvisorForwarder } from './gvisor-forwarder.mjs';
import { omitToolChunkIds, toolResultStatus } from './tool-metadata.mjs';
import { openEvidenceStore } from './evidence-store.mjs';
import { typesafeConfig, systemOne } from './typesafe.mjs';
import { groupByCall, assessmentRequests, combineGroup, rulesOnly, withProbabilities } from './call-assessment.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const routing = providerConfig();
// Summaries default to the cheapest configured alias so per-step summarizing
// (many small calls) doesn't rack up cost; override with RAYTACE_SUMMARY_MODEL.
const summaryModel = process.env.RAYTACE_SUMMARY_MODEL
  ? selectModel(routing, process.env.RAYTACE_SUMMARY_MODEL)
  : (routing.models.oss || routing.defaultModel);
const fallbackSession = { session_id: randomUUID(), session_started_at: new Date().toISOString() };

const port = Number(process.env.RAYTACE_PORT || 8797);
const store = process.env.RAYTACE_STORE || join(process.cwd(), '.raytace', 'events.jsonl');
const maxBodyBytes = Number(process.env.RAYTACE_MAX_BODY_BYTES || 2_000_000);
const liveExchanges = new Map(); // Credentials stay in process memory, never in the event log.
const jobs = new Map();
const jobControllers = new Map();
const dbFile = process.env.RAYTACE_DB || join(dirname(store), 'evidence.db');
const archiveJsonl = process.env.RAYTACE_ARCHIVE_JSONL === '1';
const db = openEvidenceStore(dbFile);
const allowedOrigins = new Set((process.env.RAYTACE_UI_ORIGINS || '').split(',').filter(Boolean));
function trustedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try { const url = new URL(origin); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    /authorization|api[-_]?key|token|secret|password/i.test(key) ? [key, '[REDACTED]'] : [key, redact(item)],
  ));
}
// Command severity (Jev). Without TYPESAFE_API_KEY, or when a request fails,
// only the rule floor is shown -- and only where a rule actually fired.
const typesafe = typesafeConfig();
const pendingAssessments = new Map();
const ASSESS_CONCURRENCY = 4;

async function mapLimit(items, limit, run) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await run(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function assessGroup(group, context) {
  if (!typesafe.enabled) return rulesOnly(group);
  const { key, requests } = assessmentRequests(group, context, typesafe.model);
  const cached = db.getCallAssessment(key);
  if (cached) return withProbabilities(cached);
  if (!pendingAssessments.has(key)) {
    const task = (async () => {
      const responses = await Promise.all(requests.map((request) => systemOne(typesafe, { state: request.state, questions: request.questions })));
      const model = responses[0]?.model ?? typesafe.model;
      const input_tokens = responses.reduce((sum, response) => sum + (response.usage?.input_tokens ?? 0), 0);
      const result = { ...combineGroup(group, requests, responses), model, input_tokens };
      db.putCallAssessment(key, group.call_id, model, { ...result, answers: responses.map((response) => response.answers) });
      return result;
    })().finally(() => pendingAssessments.delete(key));
    pendingAssessments.set(key, task);
  }
  try { return await pendingAssessments.get(key); } catch (error) {
    console.error('[raytace] Jev assessment unavailable:', error.message);
    return rulesOnly(group);
  }
}

/** Sets `severity` on each top-level command and returns call-level labels
 * keyed by call id. Never throws: severity must not cost us the evidence. */
async function assessCommands(commands) {
  const groups = groupByCall(commands);
  const contexts = db.toolCallContexts(groups.map((group) => group.call_id));
  const results = await mapLimit(groups, ASSESS_CONCURRENCY, (group) => assessGroup(group, contexts.get(group.call_id) ?? null));
  const labels = {};
  groups.forEach((group, index) => {
    const { severities, labels: callLabels } = results[index];
    group.trees.forEach((tree, position) => { tree.root.severity = severities[position] ?? null; });
    if (callLabels && group.call_id) labels[group.call_id] = callLabels;
  });
  return labels;
}

async function record(event) {
  const row = omitToolChunkIds(event);
  if (row.event_type === 'model.exchange' && row.span_id) db.recordExchange(row);
  else if (row.event_type === 'proxy.error') db.recordProxyError(row);
  // Opt-in raw archive; the database is the source of truth.
  if (archiveJsonl) { await mkdir(dirname(store), { recursive: true }); await appendFile(store, `${JSON.stringify(row)}\n`); }
}
function safeHeaders(headers) { const keep = ['content-type', 'anthropic-version', 'openai-beta', 'user-agent', 'x-request-id']; return Object.fromEntries(Object.entries(headers).filter(([key]) => keep.includes(key.toLowerCase()))); }
function shortened(value, limit = 104) { const text = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function parseSseResponse(body) {
  const events = [];
  let completedResponse = null;
  for (const frame of body.toString('utf8').replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const event = JSON.parse(data);
      events.push(event);
      if (event.type === 'response.completed' && event.response) completedResponse = event.response;
    } catch { /* retain the raw response hash when an SSE event is not JSON */ }
  }
  if (completedResponse) return completedResponse;
  return events.length ? { stream: true, events } : null;
}
function toolKind(name) { const lower = name.toLowerCase(); return /search|rg|grep/.test(lower) ? 'search' : /read|open|cat|list/.test(lower) ? 'read' : /write|edit|patch|apply/.test(lower) ? 'edit' : 'test'; }
function event(kind, title, detail, time, raw) { return { kind, title, detail, time, raw: JSON.stringify(raw, null, 2) }; }
function publicOutput(item) {
  // Reasoning items can contain opaque/private model state. Keep only the
  // configuration and any explicit summary; never present hidden content as a trace.
  if (item?.type === 'reasoning') return { type: 'reasoning', id: item.id, summary: item.summary ?? null, encrypted_content: item.encrypted_content ? '[present]' : undefined };
  return item;
}
function extractText(item) {
  const content = item?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || '').filter(Boolean).join(' ');
  return item?.text || '';
}
async function invokeReplay(entry, payload, signal) {
  const headers = Object.fromEntries(Object.entries(entry.headers).filter(([key]) =>
    ['authorization', 'content-type', 'openai-organization', 'openai-project', 'openai-beta', 'user-agent'].includes(key.toLowerCase())));
  const response = await fetch(entry.upstreamUrl, {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider returned HTTP ${response.status}; batch stopped. Credentials may have expired or the intervention may be invalid.`); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBodyBytes) throw new Error('Replay response exceeded the capture size limit.'); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  return response.headers.get('content-type')?.includes('text/event-stream') ? parseSseResponse(body) : JSON.parse(body.toString());
}
async function persistExperiment(job) { db.saveExperiment(redact(omitToolChunkIds(job))); }
function splitExchange(row) {
  const request = row.request?.payload || {}; const response = row.response?.payload || {};
  // Preserve the date and UTC offset so each viewer can render their local time.
  const started = new Date(row.timestamp).toISOString(); const completed = new Date(row.completed_at || row.timestamp).toISOString();
  const input = Array.isArray(request.input) ? request.input : Array.isArray(request.messages) ? request.messages : [];
  const output = Array.isArray(response.output) ? response.output : Array.isArray(response.content) ? response.content : [];
  const toolCount = (request.tools || []).length + input.flatMap((item) => item?.tools || []).length;
  const live = liveExchanges.get(row.span_id);
  const reason = live ? replayEligibility(live) : 'Capture a fresh request after starting this proxy. Replay snapshots expire after 30 minutes or a restart.';
  let decision = null; try { decision = outcome(response); } catch { /* incomplete capture */ }
  const steps = [event('model', 'Context assembled', `${request.model || 'unknown model'} · ${input.length} input items · ${toolCount} available tools`, started, { exchange_id: row.span_id, model: request.model, stream: request.stream, input_items: input.length, tool_count: toolCount, reasoning: request.reasoning ?? null, replay_reason: reason, decision })];
  for (const item of input) {
    if (!/function_call_output|tool_result/i.test(item?.type || '')) continue;
    const name = item.name || item.tool_name || item.call_id || 'tool';
    steps.push(event(toolKind(name), `Tool result: ${name}`, toolResultStatus(item), started, item));
  }
  for (const [outputIndex, item] of output.entries()) {
    if (item?.type === 'reasoning') {
      const effort = response.reasoning?.effort || request.reasoning?.effort || 'model default';
      steps.push(event('model', 'Reasoning phase', `Effort: ${effort}. Private reasoning content is intentionally not displayed.`, completed, publicOutput(item)));
      continue;
    }
    const name = item?.name || item?.function?.name;
    if (name && /function_call|tool_use|tool_call/i.test(item?.type || '')) {
      const data = item.arguments || item.input || item.function?.arguments || '';
      steps.push({ ...event(toolKind(name), `Tool call: ${name}`, shortened(data), completed, publicOutput(item)), exchange_id: row.span_id, output_index: outputIndex });
      continue;
    }
    if (/message|text/i.test(item?.type || '')) steps.push({ ...event('model', 'Model answer', shortened(extractText(item), 180) || 'Message completed', completed, publicOutput(item)), exchange_id: row.span_id, output_index: outputIndex });
  }
  steps.push(event('model', `Exchange complete · ${row.response?.status || 'unknown'}`, `${row.request?.bytes || 0} B sent · ${row.response?.bytes || 0} B received`, completed, { response_status: response.status ?? null, http_status: row.response?.status ?? null, request_bytes: row.request?.bytes || 0, response_bytes: row.response?.bytes || 0, response_reasoning: response.reasoning ?? null }));
  return steps;
}
/** The fields that identify and time the sandbox process a call ran as
 * (db.divergence). All null when nothing was observed for the call. */
function executionFields(real) {
  return {
    exec_id: real?.exec_id ?? null,
    pid: real?.pid ?? null,
    start_time_ns: real?.start_time_ns ?? null,
    argv: Array.isArray(real?.argv) ? real.argv : null,
    started_at: real?.started_at ?? null,
    ended_at: real?.ended_at ?? null,
    exit_code: real?.exit_code ?? null,
    window_start_ms: real?.window_start_ms ?? null,
    window_end_ms: real?.window_end_ms ?? null,
  };
}
async function readTraces(includeHistory = false) {
  const rows = db.exchangeRows({ history: includeHistory }).map(omitToolChunkIds);
  // Rows arrive already grouped: each carries its turn as trace_id and the
  // turn's prompt as promptTitle, decided once at capture (evidence-store.mjs).
  const groupedRows = rows;
  // The store already scopes the live view to the newest session; keep the
  // filter so captures made before session tracking behave as they always did.
  const exchangeRows = includeHistory ? groupedRows : (latestSessionRows(groupedRows).length ? latestSessionRows(groupedRows) : groupedRows);
  // A tool call proposed in one captured exchange comes back as evidence (its
  // result) in a later one. Index call_id -> the exchange that first proposed it
  // so the UI can jump from "this evidence" to "the decision that produced it".
  const origins = new Map();
  for (const row of exchangeRows) {
    const output = row.response?.payload?.output;
    if (!Array.isArray(output)) continue;
    for (const [outputIndex, item] of output.entries()) {
      if (item?.call_id && /function_call|tool_use|tool_call/i.test(item?.type || '') && !origins.has(item.call_id)) {
        origins.set(item.call_id, { call_id: item.call_id, trace_id: row.trace_id, exchange_id: row.span_id, output_index: outputIndex, name: item.name,
          proposed: proposedCommand(item.arguments ?? item.input ?? item.function?.arguments ?? '') });
      }
    }
  }
  const grouped = new Map();
  const shownResultsByTrace = new Map(); // trace_id -> Set(call_id) already rendered once
  for (const row of exchangeRows) {
    const trace = grouped.get(row.trace_id) || { id: row.trace_id, provider: row.provider, model: row.request?.payload?.model || 'unknown model', title: row.promptTitle, startedAt: row.timestamp, status: 'complete', events: [], evidence: [], requests: [] };
    const shownResults = shownResultsByTrace.get(row.trace_id) || new Set();
    if (/^rtp-[a-f0-9]{32}$/.test(row.session_id || '')) trace.sandboxId = row.session_id;
    shownResultsByTrace.set(row.trace_id, shownResults);
    trace.requests.push({ id: row.span_id, model: row.request?.payload?.model || 'unknown', startedAt: row.timestamp, completedAt: row.completed_at || null, ...(row.metrics || requestMetrics(row)) });
    // Rows are oldest-first, so the last request that produced text is the
    // turn's final answer, and the last completion is when the turn ended.
    trace.endedAt = row.completed_at || row.timestamp;
    try { const text = outcome(row.response?.payload || {}).text; if (text) trace.answer = text; } catch { /* incomplete capture */ }
    trace.events.push(...splitExchange(row).map((step) => {
      if (!step.title.startsWith('Tool result:')) return step;
      const raw = JSON.parse(step.raw); const origin = origins.get(raw.call_id);
      // The tool result carries only a call_id and output, never the tool's
      // name — fall back to the exchange that originally proposed the call,
      // where the real name is known, instead of showing the raw id.
      const label = origin?.name ? `Tool result: ${origin.name}` : step.title;
      // The icon was classified from the same fallback name (usually the raw
      // call_id, which never matches any category) — reclassify once the real
      // tool name is known so the icon matches what the tool actually did.
      const kind = origin?.name ? toolKind(origin.name) : step.kind;
      // Clicking a result investigates the earlier decision to call that tool,
      // using its pre-action context rather than its newly returned contents.
      return { ...step, title: label, kind, ...(origin ? { exchange_id: origin.exchange_id, output_index: origin.output_index } : {}) };
    }).filter((step) => {
      if (!step.title.startsWith('Tool result:')) return true;
      // Full conversation history is resent on every turn, so the same result
      // would otherwise appear again in every later request's input — once is
      // enough; the repeats carry no new information.
      const raw = JSON.parse(step.raw);
      if (!raw.call_id || !shownResults.has(raw.call_id)) { if (raw.call_id) shownResults.add(raw.call_id); return true; }
      return false;
    }));
    for (const item of evidenceFor(row.request?.payload, row.span_id)) {
      const origin = item.call_id ? origins.get(item.call_id) : null;
      trace.evidence.push({ ...item, origin: origin && origin.exchange_id !== row.span_id ? origin : null });
    }
    grouped.set(row.trace_id, trace);
  }
  // Overlay observed sandbox execution (runtime_processes + attributions,
  // via db.divergence) onto each tool-result evidence item, keyed by call_id —
  // the one field both sides share. Falls back to evidenceFor's regex
  // heuristic (succeeded, based on scanning the result text) wherever no
  // process was tied to the call, e.g. a session run outside the sandbox.
  for (const trace of grouped.values()) {
    const spanIds = trace.requests.map((request) => request.id);
    const divergenceRows = db.divergence(spanIds).filter((row) => row.call_id);
    const byCallId = new Map(divergenceRows.map((row) => [row.call_id, row]));
    // Processes that ran underneath each call. divergence() joins on call_id
    // and a descendant's is null by definition, so these need their own query
    // (inherited attributions; see db.descendants in evidence-store.mjs).
    const descendantsByCall = new Map();
    for (const row of db.descendants(spanIds)) {
      if (!descendantsByCall.has(row.parent_call_id)) descendantsByCall.set(row.parent_call_id, []);
      descendantsByCall.get(row.parent_call_id).push({
        id: row.id, tier: row.tier, pid: row.pid, ppid: row.ppid, start_time_ns: row.start_time_ns ?? null, argv: row.argv,
        status: row.status ?? null, error: row.error ?? null,
        started_at: row.started_at ?? null, ended_at: row.ended_at ?? null,
      });
    }
    trace.evidence = trace.evidence.map((item) => {
      const real = item.call_id ? byCallId.get(item.call_id) : null;
      if (!real) return item;
      // 'not_executed' means no execution row was correlated — this could be
      // a call that genuinely never ran, or one the (deliberately
      // conservative) matcher failed to correlate. Either way, there is no
      // real ground truth to show yet, so this stays "unverified" and keeps
      // the regex-heuristic succeeded value rather than asserting a fact we
      // don't actually have.
      const verified = real.outcome !== 'not_executed';
      return {
        ...item,
        real_outcome: real.outcome,
        real_status: real.status ?? null,
        real_error: real.error ?? null,
        match_score: real.match_score ?? null,
        match_basis: real.match_basis ?? null,
        // Which witness observed it (only 'gvisor' now), and whether the
        // runtime layer saw it start. Both drive the badge.
        source: real.source ?? null,
        kernel_confirmed: real.kernel_confirmed === 1,
        // How this call's execution was attributed, recorded at capture (see
        // migration 005). The UI badges this directly instead of re-deriving
        // confidence from kernel_confirmed + match_basis, which is how a
        // text-similarity guess ended up wearing the same badge as an exact
        // join. Null for rows written before 005.
        tier: real.tier ?? null,
        // The call's own process, so the decision chain can say which pid
        // this call ran as and jump to it in the sandbox tree.
        ...executionFields(real),
        descendants: descendantsByCall.get(item.call_id) ?? [],
        descendant_count: real.descendant_count ?? 0,
        verified,
        // Whether the agent's own report of the result (exit code, wall
        // time) agrees with what the runtime observed. See migration 007.
        reported_check: real.reported_check ?? null,
        // Real ground truth overrides the text-scanning heuristic once we
        // have it -- except while a sandbox command is still 'running'
        // (gVisor has seen it start but not exit yet) or its outcome is
        // 'unknown' (the evidence that would say was lost): asserting success
        // or failure there would be a fact we don't have, so keep the heuristic.
        succeeded: verified && real.status !== 'running' && real.status !== 'unknown' ? real.status === 'completed' : item.succeeded,
      };
    });

    // Flat, per-call verification list for the graph view: unlike `evidence`
    // above, this isn't limited to calls whose result got resent as later
    // input — it covers every call this trace ever proposed, including one
    // in the very last response with no later request to resend it into.
    // `origins` already has one entry per call_id with the exchange that
    // proposed it, so this is just that, decorated with whatever real
    // execution data (if any) `divergence()` found for the same call_id.
    trace.callVerifications = [...origins.values()].filter((origin) => origin.trace_id === trace.id).map((origin) => {
      const real = byCallId.get(origin.call_id);
      return {
        call_id: origin.call_id,
        exchange_id: origin.exchange_id,
        name: origin.name,
        verified: real ? real.outcome !== 'not_executed' : false,
        status: real?.status ?? null,
        error: real?.error ?? null,
        match_score: real?.match_score ?? null,
        match_basis: real?.match_basis ?? null,
        source: real?.source ?? null,
        kernel_confirmed: real?.kernel_confirmed === 1,
        tier: real?.tier ?? null,
        reported_check: real?.reported_check ?? null,
        descendant_count: real?.descendant_count ?? 0,
        // Everything the "proposed vs observed" table needs for this row:
        // what the model asked for, and the process that actually ran.
        output_index: origin.output_index,
        proposed: origin.proposed ?? null,
        ...executionFields(real),
        descendants: descendantsByCall.get(origin.call_id) ?? [],
      };
    });
  }

  // Codex requests include a large tool schema. Return recent traces only so the
  // live dashboard stays responsive instead of repeatedly transferring history.
  return [...grouped.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, includeHistory ? 100 : 10);
}


async function savedOrLive(exchangeId) {
  return liveExchanges.get(exchangeId) || db.findExchange(exchangeId);
}
const pendingExplanations = new Map();
const pendingSummaries = new Map();
const MAX_CONCURRENT_SUMMARIES = 4; // cheap+budget-capped calls; safe to run several at once instead of one at a time

/**
 * Records sandbox processes the gVisor forwarder observed and ties each to
 * the proposed tool call it ran for, when one can be identified. Every
 * process is recorded whether or not it matches: a process with no
 * attribution is what "ran, but no tool call accounts for it" means.
 *
 * Candidates are the session's proposed calls not yet tied to a process,
 * each with its causal window (proposal -> result sent back). A process
 * carrying RAYTRACE_CALL_ID needs no matching: the call id travelled with
 * it, so that join is exact and overrides the text match. It is still
 * checked against this session's own candidates, so a forged or stale
 * marker cannot attach a process to a call in another session.
 * Returns exec id -> match for whatever matched; see
 * execution-correlation.mjs for why this is not a plain id lookup.
 */
function ingestExecutions(events, { sessionId = null } = {}) {
  const matches = new Map();
  if (!Array.isArray(events) || !events.length) return matches;
  const recorded = new Map(events.map((event) => [event.id, db.recordProcessStart({
    containerId: event.container_id, projectId: sessionId, raw: event.raw, startedMs: event.timestamp })]));
  const timestamps = events.map((e) => e.timestamp).filter(Number.isFinite);
  if (!sessionId || !timestamps.length) return matches;
  // The pool reaches back as far as an open window may stay open, plus the
  // clock margin between the proxy and the sandbox.
  const margin = Math.max(0, ...events.map((e) => e.margin).filter(Number.isFinite));
  const candidates = db.candidatesInWindow(Math.min(...timestamps) - OPEN_WINDOW_CAP_MS - margin, Math.max(...timestamps) + margin, { sessionId });
  const found = matchBatch(events, candidates);
  const byExternalId = new Map(candidates.map((c) => [c.external_call_id, c.call_id]));
  for (const event of events) {
    const eventId = recorded.get(event.id)?.eventId;
    const markedCall = event.call_marker ? byExternalId.get(event.call_marker) : null;
    const match = markedCall ? { call_id: markedCall, score: 1, basis: 'marker' } : found.get(event.id);
    if (!match || !eventId) continue; // no confident match: the process stays recorded, unattributed -- never a guess
    db.attribute({ toolCallId: match.call_id, eventId, method: match.basis === 'id' ? 'marker' : match.basis,
      // A marker join is exact; a text match that gVisor itself observed is
      // corroborated. Recorded at capture, never promoted later.
      confidence: markedCall ? 'exact' : 'corroborated', score: match.score,
      windowStartMs: match.window_start ?? null, windowEndMs: match.window_end ?? null });
    matches.set(event.id, match);
  }
  return matches;
}

const server = createServer(async (req, res) => {
  const localApi = req.url?.startsWith('/raytace/');
  // Paid replay endpoints require a preflighted custom header and trusted origin.
  if (localApi && (!trustedOrigin(req.headers.origin) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || ''))) {
    res.writeHead(403); return res.end('Untrusted dashboard origin or host.');
  }
  const corsHeaders = { ...(req.headers.origin && trustedOrigin(req.headers.origin) ? { 'access-control-allow-origin': req.headers.origin } : {}), vary: 'Origin', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-raytace-experiment', 'access-control-allow-private-network': 'true' };
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders, 'cache-control': 'no-store' }); res.end(JSON.stringify(redact(omitToolChunkIds(value)))); };
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
  if (req.method === 'GET' && req.url?.startsWith('/raytace/runtime?')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const sandbox = query.get('sandbox');
    const before = query.get('before') || '0';
    // `since`/`until` scope the page to one agent turn (the prompt through the
    // answer). Without them this returns the whole sandbox's history, which is
    // every prompt ever run in it.
    const since = query.get('since') || '0';
    const until = query.get('until') || '0';
    const raw = query.get('raw') === '1';
    const ok = (value) => /^\d{1,16}$/.test(value);
    if (!/^rtp-[a-f0-9]{32}$/.test(sandbox || '') || ![before, since, until].every(ok)) return json(400, { error: 'Invalid sandbox or cursor' });
    try {
      const manager = await fetch('http://127.0.0.1:8799/api/projects', { signal: AbortSignal.timeout(10000) });
      if (!manager.ok) throw new Error('Sandbox manager unavailable');
      const project = (await manager.json()).find(p => p.id === sandbox);
      if (!project?.container_id || !/^[a-f0-9]{64}$/.test(project.container_id)) return json(404, { error: 'Sandbox mapping unavailable' });
      const window = `${since !== '0' ? `&since=${since}` : ''}${until !== '0' ? `&until=${until}` : ''}`;
      // A windowed page wants everything in the window, not the newest 100:
      // folding turns hundreds of raw events into a handful of commands.
      const limit = since !== '0' || until !== '0' ? 500 : 100;
      const evidence = await fetch(`http://127.0.0.1:8798/events?container=${project.container_id}&before=${before}${window}&limit=${limit}&processes=1`, { signal: AbortSignal.timeout(10000) });
      if (!evidence.ok) throw new Error('Runtime collector unavailable');
      const page = await evidence.json();
      const base = { ...page, sandbox, container_id: project.container_id };
      // `raw=1` is the "show everything" escape hatch: the folded view must
      // always be auditable against what the collector actually recorded.
      if (raw) return json(200, base);

      const { commands, folded } = foldEvents(page.events);
      // Which call each process belongs to, by the process's own identity
      // (pid + start time) within this sandbox. `attribution` stays null when
      // the process was not recorded yet -- not the same as unattributed,
      // which is a recorded process that matched no call.
      const known = new Map(db.attributionsForProcesses({ containerId: project.container_id, pids: commands.map((c) => c.pid) })
        .map((row) => [`${row.pid}:${row.start_time_ns}`, row]));
      for (const command of commands) {
        const row = command.process_start_ns ? known.get(`${command.pid}:${command.process_start_ns}`) : null;
        command.attribution = row ? { call_id: row.call_id ?? null, parent_call_id: row.parent_call_id ?? null, tier: row.tier ?? null } : null;
      }
      // Cache first, so a repeat view of the same turn costs nothing. Only
      // commands no rule can describe are ever sent to a model.
      describeAll(commands, (command) => db.getCommandDescription(command));
      const missing = undescribed(commands);
      if (missing.length && routing.mode === 'openrouter') {
        try {
          const request = describeRequest(missing, summaryModel);
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const text = (response.output || []).filter((item) => item.type === 'message')
            .map((item) => (item.content || []).map((part) => part.text || '').join('')).join(' ');
          for (const [command, description] of parseDescriptions(text, request.commands)) {
            db.putCommandDescription(command, description, summaryModel);
          }
          describeAll(commands, (command) => db.getCommandDescription(command));
        } catch (error) {
          // A failed description must never cost us the evidence: the commands
          // still render, just verbatim.
          console.error('[raytace] command descriptions unavailable:', error.message);
        }
      }
      let call_labels = {};
      try { call_labels = await assessCommands(commands); }
      catch (error) { console.error('[raytace] command severity unavailable:', error.message); }
      return json(200, { ...base, commands, folded, call_labels, severity_source: typesafe.enabled ? 'jev' : 'rules', events: undefined });
    } catch { return json(503, { error: 'Runtime evidence unavailable. Keep the manager and evidence viewer running. Missing evidence is not proof of non-execution.' }); }
  }
  if (req.method === 'GET' && (req.url === '/raytace/traces' || req.url === '/raytace/traces?scope=history')) {
    try { const traces = await readTraces(req.url === '/raytace/traces?scope=history'); res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders, 'cache-control': 'no-store' }); return res.end(JSON.stringify({ traces })); }
    catch (error) { res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders }); return res.end(JSON.stringify({ error: String(error) })); }
  }
  if (req.method === 'GET' && req.url === '/raytace/models') return json(200, { models: routing.mode === 'openrouter' ? Object.entries(routing.models).map(([alias, id]) => ({ alias, id })) : [], execution_available: routing.mode === 'openrouter' });
  const stepRoute = req.url?.match(/^\/raytace\/steps\/([a-f0-9-]+)\/(\d+)$/);
  if (req.method === 'GET' && stepRoute) {
    const live = liveExchanges.get(stepRoute[1]);
    try {
      const entry = await savedOrLive(stepRoute[1]);
      if (!entry) return json(404, { error: 'This step was not found in the saved captures.' });
      if (!entry.payload || !entry.response) return json(409, { error: 'This capture contains only metadata; its full request or response was not saved.' });
      const step = inspectStep(omitToolChunkIds(entry), stepRoute[1], Number(stepRoute[2]));
      if (!live) step.replay_reason = 'Saved log — available to inspect. Rerunning requires a fresh capture: the live snapshot expired after 30 minutes, a proxy restart, or eviction from the latest 10 exchanges.';
      const request = explanationRequest(step, routing.defaultModel);
      const explanation = db.getExplanation(request.key);
      return json(200, { ...step, hypotheses: explanation?.hypotheses || [], explanation_generated: !!explanation, explanation_model: routing.defaultModel });
    }
    catch (error) { return json(400, { error: error.message }); }
  }
  const summaryRoute = req.url?.match(/^\/raytace\/summaries\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && summaryRoute) return json(200, { summary: db.summaryForSpan(summaryRoute[1]), model: summaryModel });
  if (req.method === 'GET' && req.url === '/raytace/experiments') return json(200, { experiments: [...jobs.values()].slice(-30).reverse() });
  const jobRoute = req.url?.match(/^\/raytace\/experiments\/([a-f0-9-]+)(\/cancel)?$/);
  if (jobRoute) {
    const job = jobs.get(jobRoute[1]); if (!job) return json(404, { error: 'Experiment not found.' });
    if (req.method === 'GET' && !jobRoute[2]) return json(200, job);
    if (req.method === 'POST' && jobRoute[2] && req.headers['x-raytace-experiment'] === '1') { jobControllers.get(job.id)?.abort(); return json(200, job); }
    return json(405, { error: 'Unsupported experiment operation.' });
  }
  if (localApi && (req.method !== 'POST' || !['/raytace/experiments', '/raytace/step-runs', '/raytace/explanations', '/raytace/summaries'].includes(req.url))) return json(404, { error: 'Unknown local endpoint.' });
  if (localApi && (req.headers['x-raytace-experiment'] !== '1' || !req.headers['content-type']?.includes('application/json'))) return json(403, { error: 'Use the experiment control in the dashboard.' });
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > (localApi ? 600_000 : 20_000_000)) return json(413, { error: 'Request too large.' }); parts.push(part); }
  const requestBody = Buffer.concat(parts);
  if (req.method === 'POST' && req.url === '/raytace/explanations') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Enable OpenRouter to generate explanations.' });
      const config = JSON.parse(requestBody);
      const entry = await savedOrLive(config.exchange_id);
      if (!entry) return json(404, { error: 'Saved step not found.' });
      const step = inspectStep(omitToolChunkIds(entry), config.exchange_id, config.output_index);
      const request = explanationRequest(step, routing.defaultModel);
      const cached = db.getExplanation(request.key);
      if (cached) return json(200, cached);
      if (!pendingExplanations.has(request.key)) {
        if (pendingExplanations.size) return json(409, { error: 'Another explanation is being generated. Try again shortly.' });
        const task = (async () => {
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const result = { ...parseExplanations(response, request.sources), model: routing.defaultModel };
          db.putExplanation(request.key, result);
          return result;
        })();
        pendingExplanations.set(request.key, task);
      }
      try { return json(200, await pendingExplanations.get(request.key)); } finally { pendingExplanations.delete(request.key); }
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/summaries') {
    try {
      if (routing.mode !== 'openrouter') return json(400, { error: 'Enable OpenRouter to generate summaries.' });
      const config = JSON.parse(requestBody);
      const entry = await savedOrLive(config.exchange_id);
      if (!entry) return json(404, { error: 'Saved step not found.' });
      const request = summaryRequest(entry, config.exchange_id, summaryModel);
      const cached = db.getSummary(request.key);
      if (cached) return json(200, cached);
      if (!pendingSummaries.has(request.key)) {
        if (pendingSummaries.size >= MAX_CONCURRENT_SUMMARIES) return json(409, { error: 'Too many summaries in flight. Try again shortly.' });
        const task = (async () => {
          const routed = routeRequest(routing, { method: 'POST', url: '/v1/responses', headers: {} }, Buffer.from(JSON.stringify(request.payload)));
          const response = await invokeReplay({ headers: routed.headers, upstreamUrl: routed.url }, request.payload, new AbortController().signal);
          const result = { ...parseSummary(response), model: summaryModel };
          db.putSummary(request.key, config.exchange_id, result);
          return result;
        })();
        pendingSummaries.set(request.key, task);
      }
      try { return json(200, await pendingSummaries.get(request.key)); } finally { pendingSummaries.delete(request.key); }
    } catch (error) { console.error('Summary generation failed:', error); return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/step-runs') {
    try {
      if (jobControllers.size) return json(409, { error: 'Wait for the active run or cancel it first.' });
      const config = JSON.parse(requestBody); const entry = liveExchanges.get(config.exchange_id);
      if (!entry) return json(409, { error: 'Snapshot expired. Capture a fresh request.' });
      const model = routing.mode === 'openrouter' ? selectModel(routing, config.model) : entry.payload.model;
      if (config.mode === 'execute' && routing.mode !== 'openrouter') return json(400, { error: 'Full execution requires OpenRouter routing.' });
      const { job, baseline, variant } = createStepRun(entry, config, model);
      const controller = new AbortController();
      jobControllers.set(job.id, controller);
      try { await persistExperiment(job); } catch (error) { jobControllers.delete(job.id); throw error; }
      jobs.set(job.id, job); json(202, job);
      const task = job.mode === 'execute'
        ? executeSequence(job, variant, routing, process.cwd(), join(dirname(store), 'runs'), controller.signal)
        : runDecision(job, baseline, variant, (payload, signal) => invokeReplay(entry, payload, signal), controller.signal);
      void task.catch((error) => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; })
        .then(() => { job.completed_at = new Date().toISOString(); return persistExperiment(job); })
        .catch(() => { job.persistence_error = 'Could not save this result.'; })
        .finally(() => jobControllers.delete(job.id));
      return;
    } catch (error) { return json(400, { error: error.message }); }
  }
  if (req.method === 'POST' && req.url === '/raytace/experiments') {
    try {
      if (jobControllers.size) return json(409, { error: 'Another trial batch is running. Wait or cancel it first.' });
      const config = JSON.parse(requestBody); const entry = liveExchanges.get(config.exchange_id);
      if (!entry) return json(409, { error: 'Snapshot expired. Capture a new request through this proxy.' });
      const job = createExperiment(entry, config); const controller = new AbortController();
      // Persist the declared target and hashes before sending any paid requests.
      jobControllers.set(job.id, controller);
      try { await persistExperiment(job); } catch (error) { jobControllers.delete(job.id); throw error; }
      jobs.set(job.id, job);
      while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
      json(202, job);
      void runExperiment(job, entry, { invoke: (payload, signal) => invokeReplay(entry, payload, signal), signal: controller.signal })
        .catch(() => { job.status = 'failed'; })
        .then(() => persistExperiment(job))
        .catch(() => { job.persistence_error = 'The result could not be saved to disk.'; })
        .finally(() => jobControllers.delete(job.id));
      return;
    } catch (error) { return json(400, { error: error.message }); }
  }
  let routed;
  try { routed = routeRequest(routing, req, requestBody); }
  catch (error) { return json(400, { error: error.message }); }
  const traceId = req.headers['x-raytace-trace-id'] || req.headers['x-request-id'] || randomUUID(); const started = new Date().toISOString(); const selectedProvider = routed.provider;
  const spanId = randomUUID();
  const sessionId = req.headers['x-raytace-session-id'];
  const sessionStartedAt = req.headers['x-raytace-session-started-at'];
  const session = typeof sessionId === 'string' && /^(?:[a-f0-9-]{36}|rtp-[a-f0-9]{32})$/.test(sessionId) && typeof sessionStartedAt === 'string' && Number.isFinite(Date.parse(sessionStartedAt))
    ? { session_id: sessionId, session_started_at: new Date(sessionStartedAt).toISOString() } : fallbackSession;
  const requestPayload = routed.payload;
  try {
    const response = await fetch(routed.url, { method: req.method, headers: routed.headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : routed.body, duplex: 'half' });
    const responseBody = Buffer.from(await response.arrayBuffer()); let responsePayload = null;
    const contentType = response.headers.get('content-type') || '';
    if (responseBody.length <= maxBodyBytes) {
      if (contentType.includes('application/json')) try { responsePayload = JSON.parse(responseBody); } catch { /* record hash */ }
      else if (contentType.includes('text/event-stream')) responsePayload = parseSseResponse(responseBody);
    }
    const replayHeaders = routed.headers;
    if (requestPayload && responsePayload && req.url.endsWith('/responses') && response.ok) {
      liveExchanges.set(spanId, { payload: requestPayload, response: responsePayload, provider: selectedProvider, route: req.url, upstreamUrl: routed.url, headers: replayHeaders });
      while (liveExchanges.size > 10) liveExchanges.delete(liveExchanges.keys().next().value);
      setTimeout(() => liveExchanges.delete(spanId), 30 * 60 * 1000).unref();
    }
    const completedAt = new Date().toISOString();
    const metrics = requestMetrics({ timestamp: started, completed_at: completedAt, provider: selectedProvider, response: { payload: responsePayload } });
    await record({ ...session, metrics, event_type: 'model.exchange', trace_id: traceId, span_id: spanId, parent_span_id: req.headers['x-raytace-parent-span-id'] || null, timestamp: started, completed_at: completedAt, provider: selectedProvider, route: req.url, method: req.method, request: { headers: safeHeaders(routed.headers), bytes: routed.body.length, sha256: hash(routed.body), payload: requestPayload && redact(requestPayload) }, response: { status: response.status, headers: safeHeaders(Object.fromEntries(response.headers)), bytes: responseBody.length, sha256: hash(responseBody), payload: responsePayload && redact(responsePayload) } });
    // fetch decodes compressed bodies; original encoding/length no longer apply.
    const downstreamHeaders = Object.fromEntries(response.headers);
    delete downstreamHeaders['content-encoding'];
    delete downstreamHeaders['transfer-encoding'];
    downstreamHeaders['content-length'] = String(responseBody.length);
    res.writeHead(response.status, downstreamHeaders); res.end(responseBody);
  } catch (error) { await record({ event_type: 'proxy.error', trace_id: traceId, timestamp: started, provider: selectedProvider, route: req.url, error: String(error), cause: error.cause ? { name: error.cause.name, message: error.cause.message, code: error.cause.code } : null }); res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'raytace_proxy_upstream_error', trace_id: traceId })); }
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`RayTrace proxy could not start: port ${port} is already in use. Stop the existing proxy, then try again.`);
  else console.error(`RayTrace proxy could not start: ${error.message}`);
  process.exitCode = 1;
});
try {
  for (const job of db.loadExperiments(200).reverse()) {
    if (['queued', 'running'].includes(job.status)) job.status = 'interrupted';
    jobs.set(job.id, job);
  }
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
} catch (error) { console.error(`Experiment history could not be read: ${error.message}`); }
server.listen(port, '127.0.0.1', () => {
  const stats = db.stats();
  console.log(`RayTrace proxy listening on http://127.0.0.1:${server.address().port}`);
  console.log(`Store: ${dbFile} (journal=${db.journal}, ${stats.sessions} sessions, ${stats.turns} turns, ${stats.exchanges} exchanges, ${stats.processes} sandbox processes)`);
});
// gVisor sandbox evidence (worker/gvisor/): discovers sandboxes from the
// Mac-side manager (:8799) and tails each one's process events from the
// evidence viewer (:8798), recording matched execs as the primary witness
// for those sessions. Best-effort: with neither service running it logs
// once and idles. RAYTACE_GVISOR_FORWARDER=0 turns it off entirely.
const gvisorForwarder = process.env.RAYTACE_GVISOR_FORWARDER === '0' ? null : startGvisorForwarder({
  managerBase: process.env.RAYTACE_SANDBOX_MANAGER || 'http://127.0.0.1:8799',
  viewerBase: process.env.RAYTACE_EVIDENCE_VIEWER || 'http://127.0.0.1:8798',
  ingest: (events, { sessionId }) => ingestExecutions(events, { sessionId }),
  // Exits, found by the process's own identity (pid + start time), so an
  // exit closes its process even after a proxy restart or for a process the
  // forwarder never tracked.
  finish: (row) => recordExit(row),
  finishByProcess: (row) => recordExit(row),
  // A sandbox whose remaining exits can no longer arrive.
  lose: (row) => db.loseOpenProcesses({ containerId: row.container_id, reason: row.reason, raw: row.raw ?? null, ended: row.ended === true }),
  // Processes that ran underneath a matched call, and ones that matched
  // nothing at all (parent_call_id null): recorded either way.
  descend: ({ exec, parent_call_id, session_id }) => {
    const started = db.recordProcessStart({ containerId: exec.container_id, projectId: session_id ?? null, raw: exec.raw, startedMs: exec.timestamp });
    if (parent_call_id && started?.eventId) db.attribute({ toolCallId: parent_call_id, eventId: started.eventId, method: 'inherited', confidence: 'corroborated' });
  },
});
function recordExit(row) {
  return db.recordProcessExit({ containerId: row.container_id, projectId: row.session_id ?? null, raw: row.raw,
    endedMs: row.ended_ms ?? null, exit_code: row.exit_code ?? null, signal: row.signal ?? null });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { gvisorForwarder?.stop(); db.close(); } finally { process.exit(0); } });
