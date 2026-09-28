/**
 * RayTrace storage layer over the evidence database (proxy/schema/*.sql,
 * created and verified by init-evidence-db.mjs). This module is the only
 * place that knows about tables.
 *
 * Two writers feed it:
 *   - the proxy, once per captured model request: session -> turn ->
 *     exchange -> proposed tool calls, with payloads stored once by digest;
 *   - the gVisor forwarder, once per sandbox process event: sandbox ->
 *     process -> event, plus an attribution when a process is tied to a call.
 *
 * Readers (the dashboard) get the row shapes they always had -- hydrated
 * exchanges, per-call execution summaries -- so the evidence model can stay
 * normalized without every consumer learning it. Tool calls are identified
 * internally by their own ids; reads that the dashboard joins on use the
 * provider's call id, always scoped to specific exchanges.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeEvidenceDatabase } from './init-evidence-db.mjs';
import { promptInfo } from './prompt-traces.mjs';
import { TOOL_RESULT_KINDS, toolResultFacts } from './tool-metadata.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const toMs = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };
const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const asJson = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const fromJson = (value) => { if (value === null || value === undefined) return null; try { return JSON.parse(value); } catch { return null; } };
const nsText = (value) => (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? value : null);
const intOrNull = (value) => (Number.isInteger(Number(value)) && value !== null && value !== '' ? Number(value) : null);
const marks = (list) => list.map(() => '?').join(',');
const CALL_TYPES = /function_call|tool_use|tool_call/i;
const ROUTES = `(e.route LIKE '%/responses' OR e.route LIKE '%/messages' OR e.route LIKE '%/chat/completions')`;
const DECODER_VERSION = 'gvisor-collector-1';
const ATTRIBUTOR_VERSION = 'causal-window-1';

// Attribution confidence in the schema's terms, and the dashboard's older
// name for the same idea (see app/types.ts Tier).
const TIER = { exact: 'mediated', corroborated: 'corroborated', inferred: 'inferred' };

function previewOf(item) {
  const content = item?.content ?? item?.text ?? item?.output ?? item;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((part) => part?.text || part?.content || '').filter(Boolean).join(' ')
    : JSON.stringify(content ?? '');
  return (text || '').slice(0, 240);
}

/** What a process's row says about how it ended, in the dashboard's terms.
 * Never upgrades missing evidence into an outcome. */
function processOutcome(row) {
  if (!row?.process_id) return { status: null, error: null };
  if (!row.exec_ok && row.failed_errno != null) return { status: 'failed', error: `exec failed: errno ${row.failed_errno}` };
  if (row.exited_at_ns != null) {
    if (row.exit_signal) return { status: 'failed', error: `killed by signal ${row.exit_signal}` };
    if (row.exit_code === 0) return { status: 'completed', error: null };
    if (row.exit_code != null) return { status: 'failed', error: `exit ${row.exit_code}` };
    return { status: 'unknown', error: null };
  }
  if (row.evidence_lost) return { status: 'unknown', error: `evidence lost: ${row.evidence_lost}` };
  return { status: 'running', error: null };
}

// Per-process facts derived from its events: the command it first ran, and
// whether its only exec attempts failed.
const PROCESS_FACTS = `
  (SELECT json_extract(ev.payload_json, '$.argv') FROM runtime_events ev
    WHERE ev.process_id = p.id AND ev.event_kind IN ('exec_succeeded','exec_failed') ORDER BY ev.stream_sequence LIMIT 1) AS argv_json,
  (SELECT json_extract(ev.payload_json, '$.errno') FROM runtime_events ev
    WHERE ev.process_id = p.id AND ev.event_kind = 'exec_failed' ORDER BY ev.stream_sequence DESC LIMIT 1) AS failed_errno,
  EXISTS (SELECT 1 FROM runtime_events ev WHERE ev.process_id = p.id AND ev.event_kind = 'exec_succeeded') AS exec_ok`;

export function openEvidenceStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  // Creates a fresh v2 database, or verifies an existing one; refuses
  // anything else (an old-format database, a changed schema) untouched.
  initializeEvidenceDatabase(file);
  const db = new DatabaseSync(file);
  // WAL lets the dashboard read while the proxy writes, but needs shared
  // memory network mounts cannot provide. Fall back rather than refuse.
  let journal = 'wal';
  try { db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA synchronous = NORMAL'); }
  catch { db.exec('PRAGMA journal_mode = DELETE'); db.exec('PRAGMA synchronous = FULL'); journal = 'delete'; }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const q = (sql) => db.prepare(sql);
  const insertPayload = q('INSERT OR IGNORE INTO agent_payloads (sha, content) VALUES (?, ?)');
  const selectPayload = q('SELECT content FROM agent_payloads WHERE sha = ?');

  function putPayload(value) {
    if (value === undefined) return null;
    const text = JSON.stringify(value);
    const sha = sha256(text);
    insertPayload.run(sha, text);
    return sha;
  }
  const getPayload = (sha) => (sha ? fromJson(selectPayload.get(sha)?.content ?? null) : null);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // ------------------------------------------------------------ agent intent

  const selectSession = q('SELECT id FROM agent_sessions WHERE external_session_id = ? ORDER BY started_at_ms LIMIT 1');
  const insertSession = q('INSERT INTO agent_sessions (id, external_session_id, agent_name, started_at_ms) VALUES (?, ?, ?, ?)');
  const selectContinuedTurn = q('SELECT id FROM agent_turns WHERE session_id = ? AND prompt_key = ? ORDER BY sequence_number DESC LIMIT 1');
  const nextSequence = q('SELECT COALESCE(MAX(sequence_number) + 1, 0) AS n FROM agent_turns WHERE session_id = ?');
  const insertTurn = q(`INSERT INTO agent_turns (id, session_id, sequence_number, user_prompt_sha, started_at_ms, status, prompt_key)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`);
  const updateTurn = q(`UPDATE agent_turns SET status = ?, ended_at_ms = MAX(COALESCE(ended_at_ms, started_at_ms), ?),
    final_response_sha = COALESCE(?, final_response_sha) WHERE id = ?`);
  const selectExchangeId = q('SELECT id FROM agent_exchanges WHERE id = ?');
  const insertExchange = q(`INSERT INTO agent_exchanges (id, turn_id, session_id, provider, model, started_at_ms, completed_at_ms,
    http_status, request_sha, response_sha, metrics_json, route, method, tools_sha, input_key, transport_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertContext = q(`INSERT INTO agent_context_items (exchange_id, position, role, kind, external_call_id, payload_sha, preview)
    VALUES (?,?,?,?,?,?,?)`);
  const insertToolCall = q(`INSERT INTO agent_tool_calls (id, exchange_id, external_call_id, output_index, tool_name, arguments_sha, proposed_at_ms)
    VALUES (?,?,?,?,?,?,?)`);
  // The call a result answers: same session, proposed no later than the
  // request carrying the result, not already answered.
  const selectAnsweredCall = q(`SELECT c.id FROM agent_tool_calls c JOIN agent_exchanges e ON e.id = c.exchange_id
    WHERE c.external_call_id = ? AND e.session_id = ? AND c.reported_result_sha IS NULL AND e.started_at_ms <= ?
    ORDER BY e.started_at_ms DESC LIMIT 1`);
  const setReportedResult = q('UPDATE agent_tool_calls SET reported_result_sha = ? WHERE id = ?');

  function ensureSession(row, startedMs) {
    const external = typeof row.session_id === 'string' && row.session_id ? row.session_id : null;
    const found = external ? selectSession.get(external) : null;
    if (found) return found.id;
    const id = randomUUID();
    insertSession.run(id, external, null, toMs(row.session_started_at) ?? startedMs);
    return id;
  }

  /** Which turn a request belongs to. A turn opens on a request whose last
   * real user message is the last input item (the user just asked); later
   * requests that carry the same conversation prefix plus the agent's own
   * work continue it. Background jobs (title generation, catch-ups) and
   * requests with no user message belong to no turn. */
  function resolveTurn(sessionId, row, request, startedMs) {
    const prompt = promptInfo(request);
    if (!prompt) return null;
    const key = sha256(JSON.stringify([row.provider ?? null, request?.model ?? null, prompt.prefix]));
    if (prompt.continuation) {
      const turn = selectContinuedTurn.get(sessionId, key);
      if (turn) return turn.id;
    }
    const id = randomUUID();
    insertTurn.run(id, sessionId, nextSequence.get(sessionId).n, putPayload(prompt.title), startedMs, key);
    return id;
  }

  function recordExchange(row) {
    if (!row?.span_id) return;
    const request = row.request?.payload ?? null;
    const response = row.response?.payload ?? null;
    const inputKey = Array.isArray(request?.input) ? 'input' : Array.isArray(request?.messages) ? 'messages' : null;
    const items = inputKey ? request[inputKey] : [];
    const envelope = request ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== inputKey && key !== 'tools')) : null;
    const startedMs = toMs(row.timestamp) ?? Date.now();
    const completedMs = Math.max(startedMs, toMs(row.completed_at) ?? startedMs);
    const output = Array.isArray(response?.output) ? response.output : [];
    const proposals = output.map((item, index) => [item, index]).filter(([item]) => item?.call_id && CALL_TYPES.test(item?.type || ''));

    const answered = transaction(() => {
      if (selectExchangeId.get(row.span_id)) return [];
      const sessionId = ensureSession(row, startedMs);
      const turnId = resolveTurn(sessionId, row, request, startedMs);
      const responseSha = putPayload(response);
      insertExchange.run(row.span_id, turnId, sessionId, row.provider ?? 'unknown', request?.model ?? null, startedMs, completedMs,
        row.response?.status ?? null, putPayload(envelope), responseSha, asJson(row.metrics), row.route ?? null, row.method ?? null,
        request?.tools === undefined ? null : putPayload(request.tools), inputKey,
        asJson({ trace_id: row.trace_id ?? null, parent_span_id: row.parent_span_id ?? null,
          request: { headers: row.request?.headers ?? null, bytes: row.request?.bytes ?? null, sha256: row.request?.sha256 ?? null },
          response: { headers: row.response?.headers ?? null, bytes: row.response?.bytes ?? null, sha256: row.response?.sha256 ?? null } }));

      const answeredCalls = [];
      for (const [position, item] of items.entries()) {
        const payloadSha = putPayload(item);
        insertContext.run(row.span_id, position, item?.role ?? null, item?.type ?? null, item?.call_id ?? null, payloadSha, previewOf(item));
        // A tool result the agent sends back is its report of what the call
        // did -- recorded on the call as a report, never as evidence.
        if (item?.call_id && TOOL_RESULT_KINDS.includes(item?.type)) {
          const call = selectAnsweredCall.get(item.call_id, sessionId, startedMs);
          if (call) { setReportedResult.run(payloadSha, call.id); answeredCalls.push(call.id); }
        }
      }
      for (const [item, outputIndex] of proposals) {
        insertToolCall.run(randomUUID(), row.span_id, item.call_id, outputIndex, item.name ?? item.function?.name ?? 'tool',
          putPayload(item.arguments ?? item.input ?? item.function?.arguments ?? null), completedMs);
      }
      if (turnId) {
        // A response that proposes nothing more is the agent's answer. This
        // closes the turn for the agent; processes it started may still run.
        const failed = Number(row.response?.status) >= 400;
        const status = failed ? 'failed' : proposals.length ? 'active' : 'completed';
        updateTurn.run(status, completedMs, status === 'completed' ? responseSha : null, turnId);
      }
      return answeredCalls;
    });
    for (const callId of answered) checkReported({ toolCallId: callId });
  }

  // Rebuild the capture-time row shape the dashboard and lab consume.
  const selectContextPayloads = q('SELECT payload_sha FROM agent_context_items WHERE exchange_id = ? ORDER BY position');
  const EXCHANGE_COLUMNS = `e.*, s.external_session_id, s.started_at_ms AS session_started_ms, t.user_prompt_sha`;
  function hydrate(record) {
    const payload = { ...getPayload(record.request_sha) };
    const tools = getPayload(record.tools_sha);
    if (tools !== null) payload.tools = tools;
    if (record.input_key) payload[record.input_key] = selectContextPayloads.all(record.id).map((item) => getPayload(item.payload_sha));
    const transport = fromJson(record.transport_json) ?? {};
    return {
      event_type: 'model.exchange',
      session_id: record.external_session_id, session_started_at: toIso(record.session_started_ms),
      // A trace is a turn: one prompt and everything the agent did for it.
      trace_id: record.turn_id, promptTitle: record.user_prompt_sha ? getPayload(record.user_prompt_sha) : null,
      span_id: record.id, parent_span_id: transport.parent_span_id ?? null,
      timestamp: toIso(record.started_at_ms), completed_at: toIso(record.completed_at_ms),
      provider: record.provider, route: record.route, method: record.method,
      metrics: fromJson(record.metrics_json),
      request: { headers: transport.request?.headers ?? null, bytes: transport.request?.bytes ?? null, sha256: transport.request?.sha256 ?? null, payload },
      response: { status: record.http_status, headers: transport.response?.headers ?? null, bytes: transport.response?.bytes ?? null,
        sha256: transport.response?.sha256 ?? null, payload: getPayload(record.response_sha) },
    };
  }
  const latestSession = q(`SELECT e.session_id FROM agent_exchanges e JOIN agent_sessions s ON s.id = e.session_id
    WHERE e.turn_id IS NOT NULL AND ${ROUTES} ORDER BY s.started_at_ms DESC, e.started_at_ms DESC LIMIT 1`);
  const turnExchanges = (scoped) => q(`SELECT ${EXCHANGE_COLUMNS} FROM agent_exchanges e
    JOIN agent_sessions s ON s.id = e.session_id JOIN agent_turns t ON t.id = e.turn_id
    WHERE ${ROUTES} ${scoped ? 'AND e.session_id = ?' : ''} ORDER BY e.started_at_ms DESC LIMIT ?`);
  const recentAll = turnExchanges(false);
  const recentBySession = turnExchanges(true);
  const selectExchange = q(`SELECT ${EXCHANGE_COLUMNS} FROM agent_exchanges e
    JOIN agent_sessions s ON s.id = e.session_id LEFT JOIN agent_turns t ON t.id = e.turn_id WHERE e.id = ?`);

  // --------------------------------------------------------- runtime evidence

  const selectSandbox = q('SELECT id, project_id FROM runtime_sandboxes WHERE id = ?');
  const insertSandbox = q(`INSERT INTO runtime_sandboxes (id, external_container_id, project_id, runtime_name, started_at_ms)
    VALUES (?, ?, ?, 'gvisor', ?)`);
  const setSandboxProject = q('UPDATE runtime_sandboxes SET project_id = ? WHERE id = ? AND project_id IS NULL');
  const selectEventId = q('SELECT id FROM runtime_events WHERE stream_id = ? AND stream_sequence = ?');
  const insertEvent = q(`INSERT INTO runtime_events (id, sandbox_id, process_id, stream_id, stream_sequence, event_kind,
    observed_at_ns, received_at_ms, tid, payload_json, decoder_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const selectProcess = q('SELECT * FROM runtime_processes WHERE sandbox_id = ? AND pid = ? AND start_time_ns IS ? ORDER BY first_seen_ms DESC LIMIT 1');
  const selectLiveParent = q(`SELECT id FROM runtime_processes WHERE sandbox_id = ? AND pid = ? AND exited_at_ns IS NULL
    ORDER BY first_seen_ms DESC LIMIT 1`);
  const insertProcess = q(`INSERT INTO runtime_processes (id, sandbox_id, pid, start_time_ns, parent_process_id, observed_ppid,
    first_seen_ns, identity_basis, first_seen_ms) VALUES (?,?,?,?,?,?,?,?,?)`);
  const closeProcess = q(`UPDATE runtime_processes SET exited_at_ns = ?, exited_at_ms = ?, exit_code = ?, exit_signal = ?, evidence_lost = NULL
    WHERE id = ? AND exited_at_ns IS NULL`);
  const loseProcesses = q(`UPDATE runtime_processes SET evidence_lost = ?
    WHERE sandbox_id = ? AND exited_at_ns IS NULL AND evidence_lost IS NULL`);
  const endSandboxStmt = q(`UPDATE runtime_sandboxes SET ended_at_ms = MAX(COALESCE(started_at_ms, ?), ?) WHERE id = ? AND ended_at_ms IS NULL`);
  const selectAcceptedAttribution = q(`SELECT id FROM runtime_attributions WHERE tool_call_id = ? AND event_id = ? AND status = 'accepted'`);
  const insertAttribution = q(`INSERT INTO runtime_attributions (id, tool_call_id, event_id, method, confidence, status, basis_json,
    attributor_version, created_at_ms, score, window_start_ms, window_end_ms) VALUES (?,?,?,?,?,'accepted',?,?,?,?,?,?)`);

  /** One sandbox lifetime per container. Process identity (pid + start
   * time) keeps a restarted container's reused pids apart regardless. */
  function ensureSandbox(containerId, projectId = null) {
    const found = selectSandbox.get(containerId);
    if (found) { if (projectId && !found.project_id) setSandboxProject.run(projectId, containerId); return containerId; }
    insertSandbox.run(containerId, containerId, projectId, Date.now());
    return containerId;
  }

  /** Appends one collector event, once: the stream is the container and the
   * sequence is the collector's own event id, so a replayed event is a no-op. */
  function recordEvent({ sandboxId, processId = null, raw }) {
    const streamId = `gvisor:${sandboxId}`;
    const sequence = Number(raw?.event_id);
    if (!Number.isInteger(sequence) || sequence < 0) return null;
    const existing = selectEventId.get(streamId, sequence);
    if (existing) return existing.id;
    const id = `${streamId}:${sequence}`;
    const tid = intOrNull(raw.tid);
    insertEvent.run(id, sandboxId, processId, streamId, sequence, String(raw.kind || 'unknown'), nsText(raw.timestamp_ns), Date.now(),
      tid && tid >= 1 ? tid : null, JSON.stringify(raw), DECODER_VERSION);
    return id;
  }

  function findProcess(sandboxId, pid, startNs) { return selectProcess.get(sandboxId, pid, startNs); }

  return {
    db, journal, recordExchange,

    /** Captured exchanges that belong to a turn, newest-first bounded,
     * returned oldest-first. Scoped to the latest session unless `history`. */
    exchangeRows({ history = false, limit = history ? 2000 : 400 } = {}) {
      const session = history ? null : latestSession.get()?.session_id ?? null;
      const rows = session ? recentBySession.all(session, limit) : recentAll.all(limit);
      return rows.map(hydrate).reverse();
    },

    findExchange(exchangeId) {
      const record = selectExchange.get(exchangeId);
      if (!record) return undefined;
      const row = hydrate(record);
      return { payload: row.request.payload, response: row.response.payload, provider: row.provider, route: row.route };
    },

    // ---- runtime evidence writers (the gVisor forwarder)

    /** A process began running a program (exec_succeeded), or tried to and
     * failed (exec_failed). Records the process once, by pid + start time,
     * and the event every time. Returns ids for attributing it. */
    recordProcessStart({ containerId, projectId = null, raw, startedMs = null }) {
      if (!containerId || !raw) return null;
      return transaction(() => {
        const sandboxId = ensureSandbox(containerId, projectId);
        const pid = intOrNull(raw.pid);
        if (pid == null || pid < 1) return { processId: null, eventId: recordEvent({ sandboxId, raw }) };
        const startNs = nsText(raw.process_start_ns);
        let process = findProcess(sandboxId, pid, startNs);
        if (!process) {
          const ppid = intOrNull(raw.ppid);
          const parent = ppid != null ? selectLiveParent.get(sandboxId, ppid) : null;
          const observed = nsText(raw.timestamp_ns) ?? startNs ?? '0';
          const id = `${sandboxId}:${pid}:${startNs ?? `event-${raw.event_id}`}`;
          insertProcess.run(id, sandboxId, pid, startNs, parent?.id ?? null, ppid != null && ppid >= 0 ? ppid : null, observed,
            startNs ? 'pid+start_time' : 'pid+first_event (start time not reported)', Number.isFinite(startedMs) ? Math.round(startedMs) : null);
          process = { id };
        }
        return { processId: process.id, eventId: recordEvent({ sandboxId, processId: process.id, raw }) };
      });
    },

    /** Ties an observed process (its exec event) to the tool call it ran
     * for. `method` is how: marker | window | text | inherited. */
    attribute({ toolCallId, eventId, method, confidence = 'corroborated', score = null, windowStartMs = null, windowEndMs = null }) {
      if (!toolCallId || !eventId || selectAcceptedAttribution.get(toolCallId, eventId)) return false;
      insertAttribution.run(randomUUID(), toolCallId, eventId, method, confidence,
        JSON.stringify({ method, score, window_start_ms: windowStartMs, window_end_ms: windowEndMs }), ATTRIBUTOR_VERSION, Date.now(),
        score ?? null, windowStartMs ?? null, windowEndMs ?? null);
      return true;
    },

    /** A process exited. Found by pid + start time within its sandbox, so an
     * exit still closes its process after a proxy restart. A process with no
     * row (one that forked but never exec'd) is not recorded. */
    recordProcessExit({ containerId, projectId = null, raw, endedMs = null, exit_code = null, signal = null }) {
      if (!containerId || !raw) return false;
      const closed = transaction(() => {
        const sandboxId = ensureSandbox(containerId, projectId);
        const pid = intOrNull(raw.pid);
        const process = pid != null ? findProcess(sandboxId, pid, nsText(raw.process_start_ns)) : null;
        if (!process || process.exited_at_ns != null) return null;
        const exitSignal = Number.isInteger(signal) && signal > 0 ? signal : null;
        const exitCode = exitSignal ? null : (Number.isInteger(exit_code) && exit_code >= 0 ? exit_code : null);
        closeProcess.run(nsText(raw.timestamp_ns) ?? process.first_seen_ns, Number.isFinite(endedMs) ? Math.round(endedMs) : null,
          exitCode, exitSignal, process.id);
        recordEvent({ sandboxId, processId: process.id, raw });
        return process.id;
      });
      if (!closed) return false;
      checkReported({ processId: closed });
      return true;
    },

    /** The evidence that would close a sandbox's open processes can no
     * longer arrive. Marks them (never as failed) and records why. */
    loseOpenProcesses({ containerId, reason, raw = null, ended = false }) {
      if (!containerId) return 0;
      return transaction(() => {
        const sandboxId = ensureSandbox(containerId);
        if (raw) recordEvent({ sandboxId, raw });
        const changes = Number(loseProcesses.run(String(reason || 'unknown'), sandboxId).changes);
        if (ended) endSandboxStmt.run(Date.now(), Date.now(), sandboxId);
        return changes;
      });
    },

    /** The session's proposed calls that no process has been tied to yet,
     * each with its causal window: from the request that proposed it to the
     * first later request in the session that carried its result back (null
     * while none has). `call_id` is the internal tool-call id. */
    candidatesInWindow(startMs, endMs, { sessionId = null } = {}) {
      if (!sessionId) return [];
      const rows = q(`SELECT c.id, c.external_call_id, c.arguments_sha, e.started_at_ms,
          (SELECT MIN(r.started_at_ms) FROM agent_context_items ci JOIN agent_exchanges r ON r.id = ci.exchange_id
            WHERE ci.external_call_id = c.external_call_id AND ci.kind IN (${marks(TOOL_RESULT_KINDS)})
              AND r.session_id = e.session_id AND r.started_at_ms >= e.started_at_ms AND r.id != e.id) AS window_end
        FROM agent_tool_calls c
        JOIN agent_exchanges e ON e.id = c.exchange_id
        JOIN agent_sessions s ON s.id = e.session_id
        WHERE e.started_at_ms BETWEEN ? AND ? AND s.external_session_id = ?
          AND NOT EXISTS (SELECT 1 FROM runtime_attributions a
            WHERE a.tool_call_id = c.id AND a.status = 'accepted' AND a.method != 'inherited')
        ORDER BY e.started_at_ms, c.output_index`).all(...TOOL_RESULT_KINDS, startMs, endMs, sessionId);
      return rows.map((row) => ({ call_id: row.id, external_call_id: row.external_call_id, timestamp: row.started_at_ms,
        args: getPayload(row.arguments_sha), window_start: row.started_at_ms, window_end: row.window_end ?? null }));
    },

    // ---- readers (the dashboard)

    /** Proposed vs observed for every call in these exchanges: the call, and
     * the process it ran as (its accepted, non-inherited attribution). */
    divergence(exchangeIds) {
      if (!exchangeIds.length) return [];
      return q(`SELECT c.external_call_id AS call_id, c.exchange_id AS span_id, c.output_index, c.tool_name AS name,
          a.method, a.confidence, a.score, a.window_start_ms, a.window_end_ms, a.reported_check, a.event_id,
          json_extract(ev.payload_json, '$.argv') AS attributed_argv_json,
          p.id AS process_id, p.pid, p.start_time_ns, p.first_seen_ms, p.exited_at_ms, p.exited_at_ns, p.exit_code, p.exit_signal, p.evidence_lost,
          ${PROCESS_FACTS},
          (SELECT COUNT(*) FROM runtime_attributions d WHERE d.tool_call_id = c.id AND d.status = 'accepted' AND d.method = 'inherited') AS descendant_count
        FROM agent_tool_calls c
        LEFT JOIN runtime_attributions a ON a.id = (SELECT a2.id FROM runtime_attributions a2
          WHERE a2.tool_call_id = c.id AND a2.status = 'accepted' AND a2.method != 'inherited' ORDER BY a2.created_at_ms LIMIT 1)
        LEFT JOIN runtime_events ev ON ev.id = a.event_id
        LEFT JOIN runtime_processes p ON p.id = ev.process_id
        WHERE c.exchange_id IN (${marks(exchangeIds)}) ORDER BY c.exchange_id, c.output_index`).all(...exchangeIds)
        .map((row) => {
          const { status, error } = processOutcome(row);
          return {
            call_id: row.call_id, span_id: row.span_id, output_index: row.output_index, name: row.name,
            outcome: row.event_id ? 'as_proposed' : 'not_executed',
            status, error, source: row.event_id ? 'gvisor' : null,
            match_score: row.score, match_basis: row.method === 'marker' ? 'id' : row.method ?? null,
            kernel_confirmed: row.event_id ? 1 : 0, kernel_match_score: row.score,
            tier: row.confidence ? TIER[row.confidence] : null,
            pid: row.pid ?? null, exit_code: row.exit_code ?? null, reported_check: row.reported_check ?? null,
            exec_id: row.event_id ?? null, start_time_ns: row.start_time_ns ?? null,
            // The command that was matched to the call. A process can exec
            // more than once (Codex's environment setup, then the command it
            // was asked to run), and the matched exec is the one to show.
            started_at: toIso(row.first_seen_ms), ended_at: toIso(row.exited_at_ms), argv: fromJson(row.attributed_argv_json ?? row.argv_json),
            window_start_ms: row.window_start_ms ?? null, window_end_ms: row.window_end_ms ?? null,
            descendant_count: row.descendant_count ?? 0,
          };
        });
    },

    /** Processes that ran underneath each call in these exchanges (inherited
     * attributions), in the order they started. */
    descendants(exchangeIds) {
      if (!exchangeIds.length) return [];
      return q(`SELECT c.external_call_id AS parent_call_id, ev.id AS event_id, a.confidence,
          json_extract(ev.payload_json, '$.argv') AS attributed_argv_json,
          p.id AS process_id, p.pid, p.observed_ppid, p.start_time_ns, p.first_seen_ms, p.exited_at_ms, p.exited_at_ns,
          p.exit_code, p.exit_signal, p.evidence_lost, ${PROCESS_FACTS}
        FROM runtime_attributions a
        JOIN agent_tool_calls c ON c.id = a.tool_call_id
        JOIN runtime_events ev ON ev.id = a.event_id
        JOIN runtime_processes p ON p.id = ev.process_id
        WHERE a.status = 'accepted' AND a.method = 'inherited' AND c.exchange_id IN (${marks(exchangeIds)})
        ORDER BY c.external_call_id, p.first_seen_ms, p.pid`).all(...exchangeIds)
        .map((row) => ({ parent_call_id: row.parent_call_id, id: row.event_id, tier: TIER[row.confidence] ?? 'corroborated',
          pid: row.pid, ppid: row.observed_ppid, start_time_ns: row.start_time_ns, argv: fromJson(row.attributed_argv_json ?? row.argv_json) ?? [],
          ...processOutcome(row), started_at: toIso(row.first_seen_ms), ended_at: toIso(row.exited_at_ms) }));
    },

    /** Which call each of a sandbox's processes belongs to, for annotating
     * its process tree. A process with no accepted attribution comes back
     * with both call ids null: it ran, and nothing accounts for it. */
    attributionsForProcesses({ containerId, pids }) {
      const list = [...new Set((pids ?? []).filter(Number.isInteger))];
      if (!containerId || !list.length) return [];
      return q(`SELECT p.pid, p.start_time_ns,
          (SELECT c.external_call_id FROM runtime_attributions a JOIN runtime_events ev ON ev.id = a.event_id
            JOIN agent_tool_calls c ON c.id = a.tool_call_id
            WHERE ev.process_id = p.id AND a.status = 'accepted' AND a.method != 'inherited' LIMIT 1) AS call_id,
          (SELECT c.external_call_id FROM runtime_attributions a JOIN runtime_events ev ON ev.id = a.event_id
            JOIN agent_tool_calls c ON c.id = a.tool_call_id
            WHERE ev.process_id = p.id AND a.status = 'accepted' AND a.method = 'inherited' LIMIT 1) AS parent_call_id,
          (SELECT a.confidence FROM runtime_attributions a JOIN runtime_events ev ON ev.id = a.event_id
            WHERE ev.process_id = p.id AND a.status = 'accepted' LIMIT 1) AS confidence,
          (SELECT a.method FROM runtime_attributions a JOIN runtime_events ev ON ev.id = a.event_id
            WHERE ev.process_id = p.id AND a.status = 'accepted' AND a.method != 'inherited' LIMIT 1) AS method
        FROM runtime_processes p WHERE p.sandbox_id = ? AND p.pid IN (${marks(list)})`).all(containerId, ...list)
        .map((row) => ({ pid: row.pid, start_time_ns: row.start_time_ns, call_id: row.call_id ?? null, parent_call_id: row.parent_call_id ?? null,
          tier: row.confidence ? TIER[row.confidence] : 'unverified', match_basis: row.method === 'marker' ? 'id' : row.method ?? null }));
    },

    // ---- auxiliary features

    recordProxyError(row) {
      q('INSERT INTO proxy_errors (trace_id, occurred_at_ms, provider, route, error, cause_json) VALUES (?,?,?,?,?,?)')
        .run(row.trace_id ?? null, toMs(row.timestamp), row.provider ?? null, row.route ?? null, row.error ?? null, asJson(row.cause));
    },
    saveExperiment(job) {
      q(`INSERT OR REPLACE INTO lab_experiments (id, exchange_id, created_at_ms, status, kind, model, body_json) VALUES (?,?,?,?,?,?,?)`)
        .run(job.id, job.exchange_id ?? null, toMs(job.created_at) ?? Date.now(), job.status ?? null, job.kind ?? 'experiment', job.model ?? null, JSON.stringify(job));
    },
    loadExperiments(limit = 200) {
      return q('SELECT body_json FROM lab_experiments ORDER BY created_at_ms DESC LIMIT ?').all(limit)
        .map((record) => fromJson(record.body_json)).filter(Boolean);
    },
    getExplanation(key) { return fromJson(q('SELECT body_json FROM step_explanations WHERE key = ?').get(key)?.body_json ?? null); },
    putExplanation(key, value) { q('INSERT OR REPLACE INTO step_explanations (key, created_at_ms, body_json) VALUES (?,?,?)').run(key, Date.now(), JSON.stringify(value)); },
    getSummary(key) { return fromJson(q('SELECT body_json FROM exchange_summaries WHERE key = ?').get(key)?.body_json ?? null); },
    putSummary(key, exchangeId, value) {
      q('INSERT OR REPLACE INTO exchange_summaries (key, exchange_id, created_at_ms, body_json) VALUES (?,?,?,?)').run(key, exchangeId ?? null, Date.now(), JSON.stringify(value));
    },
    summaryForSpan(exchangeId) {
      return fromJson(q('SELECT body_json FROM exchange_summaries WHERE exchange_id = ? ORDER BY created_at_ms DESC LIMIT 1').get(exchangeId)?.body_json ?? null);
    },
    /** Model-written sentence for a sandbox command no rule could describe,
     * keyed by the command so the same command is never paid for twice. */
    getCommandDescription(command) {
      return q('SELECT description FROM command_descriptions WHERE key = ?').get(sha256(String(command)))?.description ?? null;
    },
    putCommandDescription(command, description, model = null) {
      q('INSERT OR REPLACE INTO command_descriptions (key, command, description, model, created_at_ms) VALUES (?,?,?,?,?)')
        .run(sha256(String(command)), String(command), String(description), model, Date.now());
    },
    /** What each tool call asked for and what the agent was told back, keyed
     * by the external call id the attribution rows carry. The raw material for
     * a Jev assessment; call-assessment.mjs decides how much of it to send. */
    toolCallContexts(externalCallIds) {
      const list = [...new Set((externalCallIds ?? []).filter((id) => typeof id === 'string' && id))];
      if (!list.length) return new Map();
      const rows = q(`SELECT c.external_call_id, c.tool_name, c.arguments_sha, c.reported_result_sha
        FROM agent_tool_calls c JOIN agent_exchanges e ON e.id = c.exchange_id
        WHERE c.external_call_id IN (${marks(list)}) ORDER BY e.started_at_ms`).all(...list);
      // Later rows win: a replayed call keeps the newest arguments and result.
      return new Map(rows.map((row) => [row.external_call_id, {
        tool_name: row.tool_name, args: getPayload(row.arguments_sha), result: getPayload(row.reported_result_sha) }]));
    },
    getCallAssessment(key) { return fromJson(q('SELECT body_json FROM call_assessments WHERE key = ?').get(key)?.body_json ?? null); },
    putCallAssessment(key, callId, model, value) {
      q('INSERT OR REPLACE INTO call_assessments (key, call_id, model, created_at_ms, body_json) VALUES (?,?,?,?,?)')
        .run(key, callId ?? null, model ?? null, Date.now(), JSON.stringify(value));
    },

    stats() {
      const one = (sql) => db.prepare(sql).get();
      return {
        sessions: one('SELECT COUNT(*) AS n FROM agent_sessions').n,
        turns: one('SELECT COUNT(*) AS n FROM agent_turns').n,
        exchanges: one('SELECT COUNT(*) AS n FROM agent_exchanges').n,
        payloads: one('SELECT COUNT(*) AS n, COALESCE(SUM(length(content)),0) AS bytes FROM agent_payloads'),
        processes: one('SELECT COUNT(*) AS n FROM runtime_processes').n,
      };
    },

    close() { db.close(); },
  };

  /** Compares the agent's own report of a finished call (the runner's exit
   * code and wall time) with the observed exit of the process the call ran
   * as. Runs whenever either side arrives. Duration is exec-to-exit on the
   * proxy clock with one offset, so clock skew between the proxy and the
   * sandbox cannot distort it. Leaves the check null when nothing comparable
   * was reported (a command still running, no runner header). */
  function checkReported({ toolCallId = null, processId = null }) {
    const rows = q(`SELECT a.id, c.reported_result_sha, p.exit_code, p.exit_signal, p.exited_at_ns, p.first_seen_ms, p.exited_at_ms
      FROM runtime_attributions a
      JOIN runtime_events ev ON ev.id = a.event_id
      JOIN runtime_processes p ON p.id = ev.process_id
      JOIN agent_tool_calls c ON c.id = a.tool_call_id
      WHERE a.status = 'accepted' AND a.method != 'inherited' AND a.reported_check IS NULL
        AND ${toolCallId ? 'c.id = ?' : 'p.id = ?'}`).all(toolCallId ?? processId);
    for (const row of rows) {
      if (!row.reported_result_sha || row.exited_at_ns == null || row.exit_code == null) continue;
      const reported = toolResultFacts(getPayload(row.reported_result_sha));
      if (reported.exitCode === null) continue;
      let verdict = reported.exitCode === row.exit_code ? 'agrees' : 'exit_code_differs';
      const observedMs = Number.isFinite(row.first_seen_ms) && Number.isFinite(row.exited_at_ms) ? row.exited_at_ms - row.first_seen_ms : null;
      if (verdict === 'agrees' && reported.wallMs !== null && observedMs !== null && observedMs >= 0) {
        // Generous on purpose: the runner starts its clock before the spawn
        // the runtime sees, and a false "differs" costs more trust than it earns.
        const tolerance = 0.2 * Math.max(observedMs, reported.wallMs) + 250;
        if (Math.abs(observedMs - reported.wallMs) > tolerance) verdict = 'duration_differs';
      }
      q('UPDATE runtime_attributions SET reported_check = ? WHERE id = ?').run(verdict, row.id);
    }
  }
}
