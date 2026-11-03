-- Per-call model spend. A rolling sum over an hour replaces a counter that
-- would silently reset on every restart.

CREATE TABLE model_cost (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  cost           REAL NOT NULL CHECK (cost >= 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX model_cost_time ON model_cost (occurred_at_ms DESC);
CREATE INDEX model_cost_provider ON model_cost (provider, occurred_at_ms DESC);
