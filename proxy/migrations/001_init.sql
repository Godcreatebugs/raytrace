-- Raytace storage schema, v1.
-- Design notes:
--  * Every large payload is content-addressed in `blobs` and referenced by hash.
--    Agent conversations resend the whole history plus a large tool schema on
--    every turn, so per-item deduplication is where the space actually goes.
--  * ISO timestamps are kept for wire compatibility with the existing UI;
--    `*_ms` integer twins exist for indexing and range queries.

CREATE TABLE blobs (
  sha     TEXT PRIMARY KEY,
  size    INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE exchanges (
  span_id            TEXT PRIMARY KEY,
  trace_id           TEXT,
  parent_span_id     TEXT,
  session_id         TEXT,
  session_started_at TEXT,
  provider           TEXT,
  route              TEXT,
  method             TEXT,
  model              TEXT,
  started_at         TEXT NOT NULL,
  started_ms         INTEGER NOT NULL,
  completed_at       TEXT,
  http_status        INTEGER,
  input_key          TEXT,              -- 'input' (Responses) or 'messages' (Chat)
  envelope_sha       TEXT REFERENCES blobs(sha),   -- request minus input/tools
  tools_sha          TEXT REFERENCES blobs(sha),   -- repeats every turn; dedupes to one row
  response_sha       TEXT REFERENCES blobs(sha),
  request_headers    TEXT,
  response_headers   TEXT,
  request_bytes      INTEGER,
  response_bytes     INTEGER,
  request_sha256     TEXT,
  response_sha256    TEXT,
  metrics            TEXT
);
CREATE INDEX idx_exchanges_time    ON exchanges(started_ms DESC);
CREATE INDEX idx_exchanges_session ON exchanges(session_id, started_ms);

-- One row per context item sent into a model request. This is the table that
-- makes ablation queryable, and the one that dedupes the history.
CREATE TABLE context_items (
  span_id  TEXT NOT NULL REFERENCES exchanges(span_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  role     TEXT,
  kind     TEXT,
  call_id  TEXT,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha),
  preview  TEXT,
  PRIMARY KEY (span_id, position)
);
CREATE INDEX idx_context_call ON context_items(call_id) WHERE call_id IS NOT NULL;

-- What the model PROPOSED. Populated at capture time.
CREATE TABLE tool_calls (
  call_id      TEXT PRIMARY KEY,
  span_id      TEXT NOT NULL REFERENCES exchanges(span_id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL,
  name         TEXT NOT NULL,
  args_sha     TEXT REFERENCES blobs(sha)
);
CREATE INDEX idx_tool_calls_span ON tool_calls(span_id, output_index);

-- What ACTUALLY HAPPENED. Empty until the execution SDK reports in; a missing
-- row for a proposed call is itself the "never executed" signal.
CREATE TABLE tool_executions (
  id                TEXT PRIMARY KEY,
  call_id           TEXT NOT NULL REFERENCES tool_calls(call_id),
  started_at        TEXT,
  ended_at          TEXT,
  status            TEXT,
  divergence        TEXT,
  resolved_args_sha TEXT REFERENCES blobs(sha),
  error             TEXT,
  source            TEXT
);
CREATE INDEX idx_exec_call ON tool_executions(call_id);

CREATE TABLE experiments (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  status     TEXT,
  kind       TEXT,
  span_id    TEXT,
  model      TEXT,
  body       TEXT NOT NULL          -- full job document, still the source of truth
);
CREATE INDEX idx_experiments_time ON experiments(created_ms DESC);

CREATE TABLE explanations (
  key        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  body       TEXT NOT NULL
);

CREATE TABLE proxy_errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id   TEXT,
  timestamp  TEXT,
  provider   TEXT,
  route      TEXT,
  error      TEXT,
  cause      TEXT
);
