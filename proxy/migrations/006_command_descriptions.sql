-- Cache for model-written descriptions of sandbox commands that the
-- deterministic rules in proxy/exec-narrative.mjs could not describe.
--
-- Keyed by a digest of the command text, not by span or session: the same
-- command run in twenty turns is the same sentence every time, so it is paid
-- for once. Mirrors the summaries table (002) deliberately -- same shape, same
-- lifecycle, same reasoning.
--
-- `source` is stored so a reader can always tell a model's interpretation from
-- an observed fact. Rule-derived sentences are never cached here: they are
-- free, deterministic, and recomputed from the command each time.
CREATE TABLE command_descriptions (
  key         TEXT PRIMARY KEY,     -- sha256 of the normalized command text
  command     TEXT NOT NULL,
  description TEXT NOT NULL,
  model       TEXT,
  created_at  TEXT NOT NULL
);
