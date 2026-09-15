/**
 * RayTrace storage layer (SQLite via node:sqlite — no native dependency).
 *
 * The proxy and the engine modules keep speaking the original "exchange row"
 * shape; this module is the only place that knows about tables. That keeps
 * splitExchange/evidenceFor/prompt-traces untouched while lookups become
 * indexed instead of full-file scans.
 *
 * To move to better-sqlite3 or Postgres later, reimplement `openStore` — the
 * exported surface is deliberately small.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const ms = (value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
const asJson = (value) => value === undefined || value === null ? null : JSON.stringify(value);
const fromJson = (value) => { if (value === null || value === undefined) return null; try { return JSON.parse(value); } catch { return null; } };

function previewOf(item) {
  const content = item?.content ?? item?.text ?? item?.output ?? item;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((part) => part?.text || part?.content || '').filter(Boolean).join(' ')
    : JSON.stringify(content ?? '');
  return (text || '').slice(0, 240);
}

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL is what lets the dashboard read while the proxy writes, but it needs
  // shared memory the OS cannot provide on network mounts (SMB/NFS, some cloud
  // sync folders). Fall back rather than refusing to start.
  let journal = 'wal';
  try { db.exec('PRAGMA journal_mode = WAL'); db.exec('PRAGMA synchronous = NORMAL'); }
  catch { db.exec('PRAGMA journal_mode = DELETE'); db.exec('PRAGMA synchronous = FULL'); journal = 'delete'; }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Migrations: numbered files applied once, tracked by user_version.
  const applied = db.prepare('PRAGMA user_version').get().user_version ?? 0;
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  for (const [index, name] of files.entries()) {
    const version = index + 1;
    if (version <= applied) continue;
    db.exec('BEGIN');
    try { db.exec(readFileSync(join(migrationsDir, name), 'utf8')); db.exec(`PRAGMA user_version = ${version}`); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw new Error(`Migration ${name} failed: ${error.message}`); }
  }

  const insertBlob = db.prepare('INSERT OR IGNORE INTO blobs (sha, size, content) VALUES (?, ?, ?)');
  const selectBlob = db.prepare('SELECT content FROM blobs WHERE sha = ?');
  const insertExchange = db.prepare(`INSERT OR REPLACE INTO exchanges
    (span_id, trace_id, parent_span_id, session_id, session_started_at, provider, route, method, model,
     started_at, started_ms, completed_at, http_status, input_key, envelope_sha, tools_sha, response_sha,
     request_headers, response_headers, request_bytes, response_bytes, request_sha256, response_sha256, metrics)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertContext = db.prepare('INSERT OR REPLACE INTO context_items (span_id, position, role, kind, call_id, blob_sha, preview) VALUES (?,?,?,?,?,?,?)');
  const insertToolCall = db.prepare('INSERT OR IGNORE INTO tool_calls (call_id, span_id, output_index, name, args_sha) VALUES (?,?,?,?,?)');
  const insertExperiment = db.prepare('INSERT OR REPLACE INTO experiments (id, created_at, created_ms, status, kind, span_id, model, body) VALUES (?,?,?,?,?,?,?,?)');
  const insertExplanation = db.prepare('INSERT OR REPLACE INTO explanations (key, created_at, body) VALUES (?,?,?)');
  const insertSummary = db.prepare('INSERT OR REPLACE INTO summaries (key, span_id, created_at, body) VALUES (?,?,?,?)');
  const insertExecution = db.prepare('INSERT OR REPLACE INTO tool_executions (id, call_id, started_at, ended_at, status, divergence, resolved_args_sha, error, source, match_score, match_basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const confirmKernel = db.prepare('UPDATE tool_executions SET kernel_confirmed = 1, kernel_match_score = ?, kernel_pid = ? WHERE call_id = ?');
  const finishExecutionStmt = db.prepare('UPDATE tool_executions SET ended_at = ?, status = ?, error = ? WHERE id = ?');
  const insertProxyError = db.prepare('INSERT INTO proxy_errors (trace_id, timestamp, provider, route, error, cause) VALUES (?,?,?,?,?,?)');
  const selectContext = db.prepare('SELECT position, blob_sha FROM context_items WHERE span_id = ? ORDER BY position');

  function putBlob(value) {
    if (value === undefined) return null;
    const text = JSON.stringify(value);
    const sha = sha256(text);
    insertBlob.run(sha, text.length, text);
    return sha;
  }
  const getBlob = (sha) => sha ? fromJson(selectBlob.get(sha)?.content ?? null) : null;

  function recordExchange(row) {
    const request = row.request?.payload ?? null;
    const response = row.response?.payload ?? null;
    const inputKey = Array.isArray(request?.input) ? 'input' : Array.isArray(request?.messages) ? 'messages' : null;
    const items = inputKey ? request[inputKey] : [];
    // Envelope = everything except the two parts that repeat verbatim each turn.
    const envelope = request ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== inputKey && key !== 'tools')) : null;

    db.exec('BEGIN');
    try {
      insertExchange.run(
        row.span_id, row.trace_id ?? null, row.parent_span_id ?? null, row.session_id ?? null, row.session_started_at ?? null,
        row.provider ?? null, row.route ?? null, row.method ?? null, request?.model ?? null,
        row.timestamp, ms(row.timestamp), row.completed_at ?? null, row.response?.status ?? null, inputKey,
        putBlob(envelope), putBlob(request?.tools), putBlob(response),
        asJson(row.request?.headers), asJson(row.response?.headers),
        row.request?.bytes ?? null, row.response?.bytes ?? null, row.request?.sha256 ?? null, row.response?.sha256 ?? null,
        asJson(row.metrics),
      );
      for (const [position, item] of items.entries()) {
        insertContext.run(row.span_id, position, item?.role ?? null, item?.type ?? null,
          item?.call_id ?? null, putBlob(item), previewOf(item));
      }
      for (const [outputIndex, item] of (Array.isArray(response?.output) ? response.output : []).entries()) {
        if (!item?.call_id || !/function_call|tool_use|tool_call/i.test(item?.type || '')) continue;
        insertToolCall.run(item.call_id, row.span_id, outputIndex, item.name ?? item.function?.name ?? 'tool',
          putBlob(item.arguments ?? item.input ?? item.function?.arguments ?? null));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Rebuild the legacy row shape so downstream modules need no changes. */
  function hydrate(record) {
    const envelope = getBlob(record.envelope_sha) ?? {};
    const tools = getBlob(record.tools_sha);
    const payload = { ...envelope };
    if (tools !== null) payload.tools = tools;
    if (record.input_key) payload[record.input_key] = selectContext.all(record.span_id).map((item) => getBlob(item.blob_sha));
    return {
      event_type: 'model.exchange',
      session_id: record.session_id, session_started_at: record.session_started_at,
      trace_id: record.trace_id, span_id: record.span_id, parent_span_id: record.parent_span_id,
      timestamp: record.started_at, completed_at: record.completed_at,
      provider: record.provider, route: record.route, method: record.method,
      metrics: fromJson(record.metrics),
      request: { headers: fromJson(record.request_headers), bytes: record.request_bytes, sha256: record.request_sha256, payload },
      response: { status: record.http_status, headers: fromJson(record.response_headers), bytes: record.response_bytes, sha256: record.response_sha256, payload: getBlob(record.response_sha) },
    };
  }

  const routeFilter = `(route LIKE '%/responses' OR route LIKE '%/messages' OR route LIKE '%/chat/completions')`;
  const latestSession = db.prepare(`SELECT session_id FROM exchanges WHERE session_id IS NOT NULL AND ${routeFilter} ORDER BY session_started_at DESC, started_ms DESC LIMIT 1`);
  const recentAll = db.prepare(`SELECT * FROM exchanges WHERE ${routeFilter} ORDER BY started_ms DESC LIMIT ?`);
  const recentBySession = db.prepare(`SELECT * FROM exchanges WHERE session_id = ? AND ${routeFilter} ORDER BY started_ms DESC LIMIT ?`);
  // Windowed against the ACTUAL execution time (tool_executions.ended_at,
  // falling back to started_at), not e.started_ms -- e.started_ms is when the
  // model's API call began, which can easily be tens of seconds (or, in a
  // long tool-call loop, much more) before the command the kernel tracer
  // observed actually ran. Using e.started_ms here was why kernel batches
  // consistently confirmed 0/N: nearly every real execution timestamp fell
  // outside the +-30s window measured from the wrong anchor. ended_at is the
  // same timestamp recordExecution derived from Codex's own rollout event,
  // i.e. the same clock the kernel tracer's near-instant observation should
  // line up against.
  // Falls back to e.started_ms (the model-call time) only when the execution
  // row itself has neither timestamp yet -- e.g. a rollout event ingested
  // before Codex reported timing. When real execution timestamps ARE known
  // they take priority; see the comment on kernelCandidates below for why.
  const EXEC_MS_EXPR = `COALESCE(
      CAST((julianday(x.ended_at) - 2440587.5) * 86400000 AS INTEGER),
      CAST((julianday(x.started_at) - 2440587.5) * 86400000 AS INTEGER),
      e.started_ms
    )`;
  const kernelCandidates = db.prepare(`SELECT c.call_id, c.args_sha, ${EXEC_MS_EXPR} AS exec_ms
    FROM tool_calls c
    JOIN exchanges e ON e.span_id = c.span_id
    JOIN tool_executions x ON x.call_id = c.call_id
    WHERE x.kernel_confirmed = 0 AND ${EXEC_MS_EXPR} BETWEEN ? AND ?
    ORDER BY exec_ms, c.output_index`);

  return {
    db, journal, putBlob, getBlob, recordExchange,

    /** Exchange rows, newest-first bounded, returned oldest-first for grouping. */
    exchangeRows({ history = false, limit = history ? 2000 : 400 } = {}) {
      const session = history ? null : latestSession.get()?.session_id ?? null;
      const rows = session ? recentBySession.all(session, limit) : recentAll.all(limit);
      return rows.map(hydrate).reverse();
    },

    findExchange(spanId) {
      const record = db.prepare('SELECT * FROM exchanges WHERE span_id = ?').get(spanId);
      if (!record) return undefined;
      const row = hydrate(record);
      return { payload: row.request.payload, response: row.response.payload, provider: row.provider, route: row.route };
    },

    recordProxyError(row) {
      insertProxyError.run(row.trace_id ?? null, row.timestamp ?? null, row.provider ?? null, row.route ?? null, row.error ?? null, asJson(row.cause));
    },

    saveExperiment(job) {
      insertExperiment.run(job.id, job.created_at ?? new Date().toISOString(), ms(job.created_at), job.status ?? null,
        job.kind ?? 'experiment', job.exchange_id ?? null, job.model ?? null, JSON.stringify(job));
    },
    loadExperiments(limit = 200) {
      return db.prepare('SELECT body FROM experiments ORDER BY created_ms DESC LIMIT ?').all(limit)
        .map((record) => fromJson(record.body)).filter(Boolean);
    },

    getExplanation(key) { return fromJson(db.prepare('SELECT body FROM explanations WHERE key = ?').get(key)?.body ?? null); },
    putExplanation(key, value) { insertExplanation.run(key, new Date().toISOString(), JSON.stringify(value)); },

    getSummary(key) { return fromJson(db.prepare('SELECT body FROM summaries WHERE key = ?').get(key)?.body ?? null); },
    putSummary(key, spanId, value) { insertSummary.run(key, spanId, new Date().toISOString(), JSON.stringify(value)); },
    summaryForSpan(spanId) {
      const record = db.prepare('SELECT body FROM summaries WHERE span_id = ? ORDER BY created_at DESC LIMIT 1').get(spanId);
      return record ? fromJson(record.body) : null;
    },

    /** tool_calls rows (with their model-proposed arguments, resolved from the
     * blob store) for exchanges started within [startMs, endMs] — the
     * candidate pool an execution-correlation pass matches a real, locally-
     * run command against. Excludes call_ids that already have a recorded
     * execution, so a batch never re-matches something already resolved. */
    candidatesInWindow(startMs, endMs, { sessionId = null } = {}) {
      // `sessionId` narrows the pool to one recorded session. The rollout
      // tailer leaves it unset (it only ever sees one Codex session's log
      // anyway); the gVisor forwarder passes the sandbox's own rtp- id so an
      // exec observed in one sandbox can never be attributed to a
      // similar-looking call proposed in a different session that happened
      // to run at the same time.
      const rows = db.prepare(`SELECT c.call_id, c.args_sha, e.started_ms
        FROM tool_calls c
        JOIN exchanges e ON e.span_id = c.span_id
        LEFT JOIN tool_executions x ON x.call_id = c.call_id
        WHERE e.started_ms BETWEEN ? AND ? AND x.id IS NULL
          ${sessionId ? 'AND e.session_id = ?' : ''}
        ORDER BY e.started_ms, c.output_index`).all(...(sessionId ? [startMs, endMs, sessionId] : [startMs, endMs]));
      return rows.map((row) => ({ call_id: row.call_id, timestamp: row.started_ms, args: getBlob(row.args_sha) }));
    },

    /** Tool calls whose rollout evidence already exists but still needs the
     * independent kernel witness. This intentionally differs from
     * candidatesInWindow(): the rollout matcher excludes executed calls,
     * while the kernel matcher must include them or it can never confirm the
     * normal ordering where the rollout row arrives first. */
    kernelCandidatesInWindow(startMs, endMs) {
      return kernelCandidates.all(startMs, endMs).map((row) => ({
        call_id: row.call_id, timestamp: row.exec_ms, args: getBlob(row.args_sha),
      }));
    },

    /** Records what actually happened to a proposed call — the other half of
     * `tool_calls`, filled in by the execution-correlation pipeline (Codex's
     * own rollout log, matched back to a call_id; see
     * proxy/execution-correlation.mjs for why that match isn't a direct ID
     * lookup). Never overwrites an already-recorded execution for the same
     * exec `id` (INSERT OR REPLACE keys on `id`, Codex's own exec UUID, which
     * is stable and unique per real run — re-ingesting the same rollout line
     * twice is a no-op, not a duplicate). */
    recordExecution({ id, call_id, started_at, ended_at, status, divergence = null, error = null, source = 'codex_rollout', match_score = null, match_basis = null }) {
      insertExecution.run(id, call_id, started_at ?? null, ended_at ?? null, status ?? null, divergence, null, error, source, match_score, match_basis);
    },

    /** Independent, kernel-level confirmation of a row `recordExecution`
     * already wrote from Codex's own rollout log (see
     * proxy/migrations/004_kernel_verification.sql and
     * proxy/container-tracer.mjs for why this updates in place rather than
     * inserting a second row). Returns true if a matching row existed to
     * confirm; false means the kernel event arrived before Codex's own log
     * was tailed (a timing race, not a contradiction) — callers should
     * retry a few seconds later rather than treat false as "never ran". */
    confirmKernelExecution({ call_id, match_score, pid }) {
      const result = confirmKernel.run(match_score ?? null, pid ?? null, call_id);
      return result.changes > 0;
    },

    /** Closes out an execution row that was recorded at process *start*
     * (the gVisor forwarder records on exec_succeeded, before the outcome is
     * known, with status 'running'). Called once the matching process_exit
     * arrives. Returns false if no such row exists -- e.g. the exec was
     * never matched to a call, so there is nothing to finish. */
    finishExecution({ id, ended_at, status, error = null }) {
      const result = finishExecutionStmt.run(ended_at ?? null, status ?? null, error, id);
      return result.changes > 0;
    },


    /** Proposed vs actually executed, for one grouped trace. */
    divergence(spanIds) {
      if (!spanIds.length) return [];
      const marks = spanIds.map(() => '?').join(',');
      return db.prepare(`SELECT c.call_id, c.span_id, c.output_index, c.name,
          COALESCE(e.divergence, CASE WHEN e.id IS NULL THEN 'not_executed' ELSE 'as_proposed' END) AS outcome,
          e.status, e.error, e.source, e.match_score, e.match_basis, e.kernel_confirmed, e.kernel_match_score
        FROM tool_calls c LEFT JOIN tool_executions e ON e.call_id = c.call_id
        WHERE c.span_id IN (${marks}) ORDER BY c.span_id, c.output_index`).all(...spanIds);
    },

    stats() {
      const one = (sql) => db.prepare(sql).get();
      return {
        exchanges: one('SELECT COUNT(*) AS n FROM exchanges').n,
        contextItems: one('SELECT COUNT(*) AS n FROM context_items').n,
        blobs: one('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM blobs'),
        logicalBytes: one('SELECT COALESCE(SUM(b.size),0) AS bytes FROM context_items c JOIN blobs b ON b.sha = c.blob_sha').bytes,
      };
    },

    close() { db.close(); },
  };
}
