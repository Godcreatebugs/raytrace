-- Runtime evidence: schema definitions only. Load through init-evidence-db.mjs.
CREATE TABLE runtime_sandboxes (
 id TEXT NOT NULL PRIMARY KEY,
 external_container_id TEXT NOT NULL,
 -- The sandbox manager's rtp-<id>: the same id the agent's session carries
 -- (agent_sessions.external_session_id), which is how the two domains join.
 project_id TEXT,
 runtime_name TEXT NOT NULL,
 -- Unknown until the runtime reports them; null rather than guessed.
 runtime_version TEXT,
 runtime_build_digest TEXT,
 architecture TEXT CHECK (architecture IS NULL OR architecture IN ('aarch64','x86_64')),
 started_at_ms INTEGER CHECK (started_at_ms IS NULL OR (typeof(started_at_ms) = 'integer')),
 ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR (typeof(ended_at_ms) = 'integer')),
 capture_config_json TEXT CHECK (capture_config_json IS NULL OR json_valid(capture_config_json)),
 CHECK (started_at_ms IS NULL OR ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
);
CREATE TABLE runtime_processes (
 id TEXT NOT NULL PRIMARY KEY,
 sandbox_id TEXT NOT NULL REFERENCES runtime_sandboxes(id),
 pid INTEGER NOT NULL CHECK (pid IS NULL OR (typeof(pid) = 'integer' AND pid >= 1)),
 start_time_ns TEXT CHECK (start_time_ns IS NULL OR (start_time_ns = '0' OR (start_time_ns GLOB '[1-9]*' AND start_time_ns NOT GLOB '*[^0-9]*'))),
 parent_process_id TEXT,
 observed_ppid INTEGER CHECK (observed_ppid IS NULL OR (typeof(observed_ppid) = 'integer' AND observed_ppid >= 0)),
 first_seen_ns TEXT NOT NULL CHECK (first_seen_ns IS NULL OR (first_seen_ns = '0' OR (first_seen_ns GLOB '[1-9]*' AND first_seen_ns NOT GLOB '*[^0-9]*'))),
 exited_at_ns TEXT CHECK (exited_at_ns IS NULL OR (exited_at_ns = '0' OR (exited_at_ns GLOB '[1-9]*' AND exited_at_ns NOT GLOB '*[^0-9]*'))),
 exit_code INTEGER CHECK (exit_code IS NULL OR (typeof(exit_code) = 'integer' AND exit_code >= 0)),
 exit_signal INTEGER CHECK (exit_signal IS NULL OR (typeof(exit_signal) = 'integer' AND exit_signal >= 1)),
 identity_basis TEXT NOT NULL CHECK (length(trim(identity_basis)) > 0),
 -- first_seen_ns/exited_at_ns are the sandbox clock; these are the same
 -- instants on the proxy's clock (offset measured when observed), so they
 -- compare directly with agent_exchanges times.
 first_seen_ms INTEGER CHECK (first_seen_ms IS NULL OR typeof(first_seen_ms) = 'integer'),
 exited_at_ms INTEGER CHECK (exited_at_ms IS NULL OR typeof(exited_at_ms) = 'integer'),
 -- Set when the evidence that would report this process's exit can no
 -- longer arrive (collector disconnected, sandbox removed). Cleared if a
 -- real exit arrives after all. Never implies failure.
 evidence_lost TEXT,
 UNIQUE(id, sandbox_id),
 FOREIGN KEY(parent_process_id, sandbox_id) REFERENCES runtime_processes(id, sandbox_id),
 CHECK (parent_process_id IS NULL OR parent_process_id != id),
 CHECK (start_time_ns IS NULL OR (length(first_seen_ns) > length(start_time_ns) OR (length(first_seen_ns) = length(start_time_ns) AND first_seen_ns COLLATE BINARY >= start_time_ns COLLATE BINARY))),
 CHECK (exited_at_ns IS NULL OR (length(exited_at_ns) > length(first_seen_ns) OR (length(exited_at_ns) = length(first_seen_ns) AND exited_at_ns COLLATE BINARY >= first_seen_ns COLLATE BINARY))),
 CHECK (exit_code IS NULL OR exit_signal IS NULL),
 CHECK ((exit_code IS NULL AND exit_signal IS NULL) OR exited_at_ns IS NOT NULL)
);
CREATE TABLE runtime_events (
 id TEXT NOT NULL PRIMARY KEY,
 sandbox_id TEXT REFERENCES runtime_sandboxes(id),
 process_id TEXT,
 stream_id TEXT NOT NULL,
 stream_sequence INTEGER NOT NULL CHECK (stream_sequence IS NULL OR (typeof(stream_sequence) = 'integer' AND stream_sequence >= 0)),
 event_kind TEXT NOT NULL CHECK (length(trim(event_kind)) > 0),
 observed_at_ns TEXT CHECK (observed_at_ns IS NULL OR (observed_at_ns = '0' OR (observed_at_ns GLOB '[1-9]*' AND observed_at_ns NOT GLOB '*[^0-9]*'))),
 received_at_ms INTEGER NOT NULL CHECK (received_at_ms IS NULL OR (typeof(received_at_ms) = 'integer')),
 tid INTEGER CHECK (tid IS NULL OR (typeof(tid) = 'integer' AND tid >= 1)),
 payload_json TEXT NOT NULL CHECK (payload_json IS NULL OR json_valid(payload_json)),
 retained_packet BLOB CHECK (retained_packet IS NULL OR typeof(retained_packet) = 'blob'),
 decoder_version TEXT NOT NULL,
 UNIQUE(stream_id, stream_sequence),
 UNIQUE(id, sandbox_id),
 FOREIGN KEY(process_id, sandbox_id) REFERENCES runtime_processes(id, sandbox_id),
 CHECK (process_id IS NULL OR sandbox_id IS NOT NULL),
 CHECK (json_type(payload_json) = 'object')
);
CREATE TABLE runtime_syscall_calls (
 id TEXT NOT NULL PRIMARY KEY,
 sandbox_id TEXT NOT NULL REFERENCES runtime_sandboxes(id),
 process_id TEXT,
 tid INTEGER CHECK (tid IS NULL OR (typeof(tid) = 'integer' AND tid >= 1)),
 syscall_name TEXT,
 syscall_number INTEGER NOT NULL CHECK (syscall_number IS NULL OR (typeof(syscall_number) = 'integer' AND syscall_number >= 0)),
 entry_event_id TEXT,
 exit_event_id TEXT,
 arguments_json TEXT NOT NULL CHECK (arguments_json IS NULL OR json_valid(arguments_json)),
 return_value TEXT CHECK (return_value IS NULL OR ((return_value = '0' OR (return_value GLOB '[1-9]*' AND return_value NOT GLOB '*[^0-9]*')) OR (return_value GLOB '-[1-9]*' AND substr(return_value, 2) NOT GLOB '*[^0-9]*'))),
 errno INTEGER CHECK (errno IS NULL OR (typeof(errno) = 'integer' AND errno >= 0)),
 outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('succeeded','failed','unknown')),
 correlation_status TEXT NOT NULL CHECK (correlation_status IN ('paired','entry_only','exit_only','uncertain')),
 normalizer_version TEXT NOT NULL,
 UNIQUE(id, sandbox_id),
 FOREIGN KEY(process_id, sandbox_id) REFERENCES runtime_processes(id, sandbox_id),
 FOREIGN KEY(entry_event_id, sandbox_id) REFERENCES runtime_events(id, sandbox_id),
 FOREIGN KEY(exit_event_id, sandbox_id) REFERENCES runtime_events(id, sandbox_id),
 CHECK (entry_event_id IS NOT NULL OR exit_event_id IS NOT NULL),
 CHECK (entry_event_id IS NULL OR exit_event_id IS NULL OR entry_event_id != exit_event_id),
 CHECK (json_type(arguments_json) = 'object'),
 CHECK ((correlation_status = 'paired' AND entry_event_id IS NOT NULL AND exit_event_id IS NOT NULL)
     OR (correlation_status = 'entry_only' AND entry_event_id IS NOT NULL AND exit_event_id IS NULL)
     OR (correlation_status = 'exit_only' AND entry_event_id IS NULL AND exit_event_id IS NOT NULL)
     OR correlation_status = 'uncertain'),
 CHECK (outcome = 'unknown' OR (exit_event_id IS NOT NULL AND return_value IS NOT NULL AND errno IS NOT NULL)),
 CHECK (outcome != 'succeeded' OR errno = 0),
 CHECK (outcome != 'failed' OR errno > 0),
 CHECK (correlation_status NOT IN ('entry_only','uncertain') OR outcome = 'unknown'),
 CHECK (exit_event_id IS NOT NULL OR (return_value IS NULL AND errno IS NULL))
);
CREATE TABLE runtime_attributions (
 id TEXT NOT NULL PRIMARY KEY,
 tool_call_id TEXT NOT NULL REFERENCES agent_tool_calls(id),
 -- The exec event of the attributed process.
 event_id TEXT NOT NULL REFERENCES runtime_events(id),
 -- marker: the call id travelled with the process (RAYTRACE_CALL_ID)
 -- window: command text matched inside the call's causal window
 -- text:   command text matched within a fixed window (no causal bounds)
 -- inherited: started by a process already attributed to the call
 method TEXT NOT NULL CHECK (length(trim(method)) > 0),
 score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
 -- The causal window that justified a 'window' match, proxy-clock ms;
 -- window_end_ms is null when no result had been sent yet.
 window_start_ms INTEGER CHECK (window_start_ms IS NULL OR typeof(window_start_ms) = 'integer'),
 window_end_ms INTEGER CHECK (window_end_ms IS NULL OR typeof(window_end_ms) = 'integer'),
 -- The agent's own report of the call's result (exit code, wall time from
 -- agent_tool_calls.reported_result_sha) against this process's observed
 -- exit. Null until both exist and are comparable.
 reported_check TEXT CHECK (reported_check IS NULL OR reported_check IN ('agrees','exit_code_differs','duration_differs')),
 confidence TEXT NOT NULL CHECK (confidence IN ('exact','corroborated','inferred')),
 status TEXT NOT NULL CHECK (status IN ('candidate','accepted','rejected')),
 basis_json TEXT NOT NULL CHECK (basis_json IS NULL OR json_valid(basis_json)),
 attributor_version TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL CHECK (created_at_ms IS NULL OR (typeof(created_at_ms) = 'integer'))
);
CREATE INDEX runtime_processes_identity ON runtime_processes(sandbox_id, pid, start_time_ns);
CREATE INDEX runtime_processes_parent ON runtime_processes(parent_process_id);
CREATE INDEX runtime_events_time ON runtime_events(sandbox_id, received_at_ms, id);
CREATE INDEX runtime_events_process ON runtime_events(process_id, received_at_ms, id);
CREATE INDEX runtime_syscalls_process ON runtime_syscall_calls(sandbox_id, process_id, id);
CREATE INDEX runtime_syscalls_entry ON runtime_syscall_calls(entry_event_id);
CREATE INDEX runtime_syscalls_exit ON runtime_syscall_calls(exit_event_id);
CREATE INDEX runtime_attributions_call ON runtime_attributions(tool_call_id, status);
CREATE INDEX runtime_attributions_event ON runtime_attributions(event_id, status);
CREATE INDEX runtime_sandboxes_project ON runtime_sandboxes(project_id);
CREATE TRIGGER runtime_sandbox_config_fixed BEFORE UPDATE OF capture_config_json ON runtime_sandboxes
WHEN NEW.capture_config_json IS NOT OLD.capture_config_json
BEGIN SELECT RAISE(ABORT, 'capture configuration is fixed for a sandbox lifetime'); END;
CREATE TRIGGER runtime_process_identity_fixed BEFORE UPDATE OF id, sandbox_id, pid, start_time_ns ON runtime_processes
WHEN NEW.id IS NOT OLD.id OR NEW.sandbox_id IS NOT OLD.sandbox_id OR NEW.pid IS NOT OLD.pid OR NEW.start_time_ns IS NOT OLD.start_time_ns
BEGIN SELECT RAISE(ABORT, 'process identity is immutable; retain unresolved identity when unknown'); END;
CREATE TRIGGER runtime_syscall_evidence BEFORE INSERT ON runtime_syscall_calls
BEGIN
 SELECT CASE WHEN EXISTS (
   SELECT 1 FROM runtime_events e WHERE e.id=NEW.exit_event_id AND (
     (NEW.return_value IS NOT NULL AND json_type(e.payload_json, '$.return_value') IS NOT NULL AND
       (json_type(e.payload_json, '$.return_value') != 'text' OR json_extract(e.payload_json, '$.return_value') != NEW.return_value))
     OR (NEW.errno IS NOT NULL AND json_type(e.payload_json, '$.errno') IS NOT NULL AND
       (json_type(e.payload_json, '$.errno') != 'integer' OR json_extract(e.payload_json, '$.errno') != NEW.errno))
   )
 ) THEN RAISE(ABORT, 'decoded result disagrees with exit evidence') END;
 SELECT CASE WHEN EXISTS (
   SELECT 1 FROM runtime_events e WHERE e.id IN (NEW.entry_event_id, NEW.exit_event_id)
   AND (
     (e.id = NEW.entry_event_id AND e.event_kind != 'syscall_enter')
     OR (e.id = NEW.exit_event_id AND e.event_kind != 'syscall_exit')
     OR (e.process_id IS NOT NULL AND NEW.process_id IS NOT NULL AND e.process_id != NEW.process_id)
     OR (e.tid IS NOT NULL AND NEW.tid IS NOT NULL AND e.tid != NEW.tid)
     OR (json_type(e.payload_json, '$.syscall_number') IS NOT NULL AND
         (json_type(e.payload_json, '$.syscall_number') != 'integer' OR json_extract(e.payload_json, '$.syscall_number') != NEW.syscall_number))
     OR (json_type(e.payload_json, '$.syscall_name') IS NOT NULL AND json_type(e.payload_json, '$.syscall_name') != 'null' AND
         (json_type(e.payload_json, '$.syscall_name') != 'text' OR
          (NEW.syscall_name IS NOT NULL AND json_extract(e.payload_json, '$.syscall_name') != NEW.syscall_name)))
   )
 ) THEN RAISE(ABORT, 'syscall phase or identity disagrees with evidence') END;
 SELECT CASE WHEN EXISTS (
   SELECT 1 FROM runtime_events a JOIN runtime_events b
   ON a.id = NEW.entry_event_id AND b.id = NEW.exit_event_id
   WHERE (a.process_id IS NOT NULL AND b.process_id IS NOT NULL AND a.process_id != b.process_id)
      OR (a.tid IS NOT NULL AND b.tid IS NOT NULL AND a.tid != b.tid)
      OR (json_extract(a.payload_json, '$.syscall_name') IS NOT NULL AND
          json_extract(b.payload_json, '$.syscall_name') IS NOT NULL AND
          json_extract(a.payload_json, '$.syscall_name') != json_extract(b.payload_json, '$.syscall_name'))
      OR (a.observed_at_ns IS NOT NULL AND b.observed_at_ns IS NOT NULL AND NOT (length(b.observed_at_ns) > length(a.observed_at_ns) OR (length(b.observed_at_ns) = length(a.observed_at_ns) AND b.observed_at_ns COLLATE BINARY >= a.observed_at_ns COLLATE BINARY)))
 ) THEN RAISE(ABORT, 'entry and exit observations disagree') END;
 SELECT CASE WHEN NEW.outcome != 'unknown' AND NOT EXISTS (
   SELECT 1 FROM runtime_events e WHERE e.id = NEW.exit_event_id
   AND json_type(e.payload_json, '$.return_value') = 'text'
   AND json_extract(e.payload_json, '$.return_value') = NEW.return_value
   AND json_type(e.payload_json, '$.errno') = 'integer'
   AND json_extract(e.payload_json, '$.errno') = NEW.errno
 ) THEN RAISE(ABORT, 'known outcome requires matching decoded exit result') END;
END;
CREATE TRIGGER runtime_events_no_update BEFORE UPDATE ON runtime_events
BEGIN SELECT RAISE(ABORT, 'runtime_events is append-only'); END;
CREATE TRIGGER runtime_events_no_delete BEFORE DELETE ON runtime_events
BEGIN SELECT RAISE(ABORT, 'runtime_events is append-only'); END;
CREATE TRIGGER runtime_syscall_calls_no_update BEFORE UPDATE ON runtime_syscall_calls
BEGIN SELECT RAISE(ABORT, 'runtime_syscall_calls is append-only'); END;
CREATE TRIGGER runtime_syscall_calls_no_delete BEFORE DELETE ON runtime_syscall_calls
BEGIN SELECT RAISE(ABORT, 'runtime_syscall_calls is append-only'); END;
CREATE TRIGGER runtime_events_no_replace BEFORE INSERT ON runtime_events
WHEN EXISTS (SELECT 1 FROM runtime_events WHERE id=NEW.id OR
 (stream_id=NEW.stream_id AND stream_sequence=NEW.stream_sequence))
BEGIN SELECT RAISE(ABORT, 'runtime event identity cannot be replaced'); END;
CREATE TRIGGER runtime_syscalls_no_replace BEFORE INSERT ON runtime_syscall_calls
WHEN EXISTS (SELECT 1 FROM runtime_syscall_calls WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'syscall identity cannot be replaced'); END;
CREATE TRIGGER runtime_sandboxes_no_replace BEFORE INSERT ON runtime_sandboxes
WHEN EXISTS (SELECT 1 FROM runtime_sandboxes WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'sandbox lifetime cannot be replaced'); END;
CREATE TRIGGER runtime_processes_no_replace BEFORE INSERT ON runtime_processes
WHEN EXISTS (SELECT 1 FROM runtime_processes WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'process lifetime cannot be replaced'); END;
