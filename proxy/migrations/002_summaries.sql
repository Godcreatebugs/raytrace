-- Cache for per-model-call summaries (see proxy/summaries.mjs). Mirrors the
-- explanations table: keyed by a content digest so identical compacted
-- input+model never gets summarized twice.
CREATE TABLE summaries (
  key        TEXT PRIMARY KEY,
  span_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body       TEXT NOT NULL
);

CREATE INDEX idx_summaries_span_id ON summaries (span_id);
