-- Independent, kernel-level confirmation of a tool_executions row already
-- written from Codex's own rollout log (see recordExecution in store.mjs).
-- Originally fed by macOS's `eslogger` (retired: an unfilterable,
-- whole-machine firehose never meant for programmatic use -- see
-- raytace-execution-reporting.md project doc for that history); now fed by
-- proxy/container-tracer.mjs, a cgroup-scoped bpftrace sidecar watching the
-- Codex Docker container's own process tree at the kernel level. Same three
-- columns serve either source, and this never adds a second row per call_id
-- -- see db.confirmKernelExecution, which UPDATEs the existing row in place.
ALTER TABLE tool_executions ADD COLUMN kernel_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool_executions ADD COLUMN kernel_match_score REAL;
ALTER TABLE tool_executions ADD COLUMN kernel_pid INTEGER;
