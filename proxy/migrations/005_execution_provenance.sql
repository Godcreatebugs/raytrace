-- Makes three kinds of execution representable instead of one.
--
-- Until now `tool_executions.call_id` was NOT NULL REFERENCES tool_calls,
-- which meant the table could only hold executions that the model had
-- proposed. Two things that really happen had nowhere to go:
--
--   * a process started BY a proposed command (npm test -> sh -> node). The
--     gVisor forwarder sees these, recognises them as descendants, and drops
--     them, so a file deleted by a pretest hook is captured at kernel level
--     and then discarded.
--   * a process that matches no proposed call at all -- either the
--     correlator failed, or something ran that nobody asked for. Discarded
--     for the same reason, which is exactly the case worth surfacing.
--
-- After this migration a row is one of three shapes:
--   call_id set,  parent_call_id NULL  -> a proposed call that ran
--   call_id NULL, parent_call_id set   -> ran underneath that call
--   both NULL                          -> ran, attributed to nothing
--
-- SQLite cannot drop a NOT NULL constraint in place, so this rebuilds the
-- table. Column order and every existing column are preserved so nothing
-- downstream that SELECTs by name changes behaviour.

-- `tier` is the confidence in an execution's attribution, recorded at
-- capture and never recomputed by a later join (a join cannot make its own
-- evidence stronger). Backfilled from what the existing columns already
-- imply: an exact call_id match is mediated; a kernel-confirmed text match
-- is corroborated; anything else is inferred.
CREATE TABLE tool_executions_new (
  id                 TEXT PRIMARY KEY,
  call_id            TEXT REFERENCES tool_calls(call_id),
  parent_call_id     TEXT REFERENCES tool_calls(call_id),
  tier               TEXT NOT NULL DEFAULT 'inferred',
  pid                INTEGER,
  ppid               INTEGER,
  start_time_ns      TEXT,
  argv               TEXT,
  started_at         TEXT,
  ended_at           TEXT,
  status             TEXT,
  divergence         TEXT,
  resolved_args_sha  TEXT REFERENCES blobs(sha),
  error              TEXT,
  source             TEXT,
  match_score        REAL,
  match_basis        TEXT,
  -- NOT NULL DEFAULT 0 is carried over from 004 deliberately: kernelCandidates
  -- filters on `kernel_confirmed = 0`, and a NULL there matches nothing, so
  -- dropping the default silently empties the kernel confirmation pool.
  kernel_confirmed   INTEGER NOT NULL DEFAULT 0,
  kernel_match_score REAL,
  kernel_pid         INTEGER
);

INSERT INTO tool_executions_new
  (id, call_id, parent_call_id, tier, pid, ppid, start_time_ns, argv,
   started_at, ended_at, status, divergence, resolved_args_sha, error, source,
   match_score, match_basis, kernel_confirmed, kernel_match_score, kernel_pid)
SELECT id, call_id, NULL,
       CASE WHEN match_basis = 'id'    THEN 'mediated'
            WHEN kernel_confirmed = 1  THEN 'corroborated'
            ELSE 'inferred' END,
       kernel_pid, NULL, NULL, NULL,
       started_at, ended_at, status, divergence, resolved_args_sha, error, source,
       match_score, match_basis, COALESCE(kernel_confirmed, 0), kernel_match_score, kernel_pid
FROM tool_executions;

DROP TABLE tool_executions;
ALTER TABLE tool_executions_new RENAME TO tool_executions;

CREATE INDEX idx_exec_call   ON tool_executions(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX idx_exec_parent ON tool_executions(parent_call_id) WHERE parent_call_id IS NOT NULL;
-- The interesting one: everything that ran and belongs to nothing.
CREATE INDEX idx_exec_orphan ON tool_executions(started_at) WHERE call_id IS NULL AND parent_call_id IS NULL;
