-- Agent-intent domain, schema version 2.
-- Written by proxy/evidence-store.mjs as each model request is captured.
-- Import outside an existing transaction; enable foreign_keys on every writer.
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS agent_payloads (
    sha TEXT NOT NULL PRIMARY KEY,
    content TEXT NOT NULL CHECK (json_valid(content))
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT NOT NULL PRIMARY KEY,
    external_session_id TEXT,
    agent_name TEXT,
    started_at_ms INTEGER NOT NULL CHECK (typeof(started_at_ms) = 'integer'),
    ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR
        (typeof(ended_at_ms) = 'integer' AND ended_at_ms >= started_at_ms)),
    metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS agent_turns (
    id TEXT NOT NULL PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    sequence_number INTEGER NOT NULL CHECK
        (typeof(sequence_number) = 'integer' AND sequence_number >= 0),
    user_prompt_sha TEXT REFERENCES agent_payloads(sha),
    final_response_sha TEXT REFERENCES agent_payloads(sha),
    started_at_ms INTEGER NOT NULL CHECK (typeof(started_at_ms) = 'integer'),
    ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR
        (typeof(ended_at_ms) = 'integer' AND ended_at_ms >= started_at_ms)),
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'active', 'completed', 'failed', 'cancelled')),
    -- Digest of the conversation up to and including the user message that
    -- opened this turn. A later request carrying the same prefix plus more
    -- items is the agent still working on this turn, not a new one.
    prompt_key TEXT,
    UNIQUE (session_id, sequence_number),
    -- Parent key for an exchange's session-scoped turn reference.
    UNIQUE (id, session_id)
);

CREATE TABLE IF NOT EXISTS agent_exchanges (
    id TEXT NOT NULL PRIMARY KEY,
    turn_id TEXT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    provider TEXT NOT NULL,
    model TEXT,
    started_at_ms INTEGER NOT NULL CHECK (typeof(started_at_ms) = 'integer'),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR
        (typeof(completed_at_ms) = 'integer' AND completed_at_ms >= started_at_ms)),
    http_status INTEGER,
    request_sha TEXT REFERENCES agent_payloads(sha),
    response_sha TEXT REFERENCES agent_payloads(sha),
    metrics_json TEXT CHECK (metrics_json IS NULL OR json_valid(metrics_json)),
    -- The HTTP route and method the agent called, e.g. POST /v1/responses.
    route TEXT,
    method TEXT,
    -- request_sha holds the request minus its input items and tool list:
    -- items go to agent_context_items and the tool list here, because both
    -- repeat verbatim on every request and would otherwise be stored again
    -- each time. input_key says which field held the items (input|messages).
    tools_sha TEXT REFERENCES agent_payloads(sha),
    input_key TEXT CHECK (input_key IS NULL OR input_key IN ('input', 'messages')),
    -- Allowlisted headers, byte counts and body digests for each direction.
    transport_json TEXT CHECK (transport_json IS NULL OR json_valid(transport_json)),
    FOREIGN KEY (turn_id, session_id) REFERENCES agent_turns(id, session_id)
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id TEXT NOT NULL PRIMARY KEY,
    exchange_id TEXT NOT NULL REFERENCES agent_exchanges(id),
    external_call_id TEXT,
    output_index INTEGER NOT NULL CHECK
        (typeof(output_index) = 'integer' AND output_index >= 0),
    tool_name TEXT NOT NULL,
    arguments_sha TEXT REFERENCES agent_payloads(sha),
    reported_result_sha TEXT REFERENCES agent_payloads(sha),
    proposed_at_ms INTEGER CHECK
        (proposed_at_ms IS NULL OR typeof(proposed_at_ms) = 'integer'),
    UNIQUE (exchange_id, output_index)
);

CREATE INDEX IF NOT EXISTS agent_sessions_chronology
    ON agent_sessions(started_at_ms, id);
CREATE INDEX IF NOT EXISTS agent_turns_session_chronology
    ON agent_turns(session_id, started_at_ms, id);
CREATE INDEX IF NOT EXISTS agent_exchanges_turn_chronology
    ON agent_exchanges(turn_id, started_at_ms, id);
CREATE INDEX IF NOT EXISTS agent_exchanges_session_chronology
    ON agent_exchanges(session_id, started_at_ms, id);
CREATE INDEX IF NOT EXISTS agent_tool_calls_external_lookup
    ON agent_tool_calls(exchange_id, external_call_id);
CREATE INDEX IF NOT EXISTS agent_tool_calls_external_call
    ON agent_tool_calls(external_call_id);
CREATE INDEX IF NOT EXISTS agent_sessions_external
    ON agent_sessions(external_session_id);
CREATE INDEX IF NOT EXISTS agent_turns_prompt
    ON agent_turns(session_id, prompt_key);

COMMIT;
