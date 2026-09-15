-- The correlation matcher (proxy/execution-correlation.mjs) already computes
-- a confidence score and a basis ('id' for an exact call_id match, 'text'
-- for fuzzy content matching) for every execution it correlates, but that
-- was being thrown away before this migration. Persisting it lets the UI
-- show a real confidence indicator instead of just a binary executed/not.
ALTER TABLE tool_executions ADD COLUMN match_score REAL;
ALTER TABLE tool_executions ADD COLUMN match_basis TEXT;
