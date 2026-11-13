-- Durable refusals for terrain targets that repeatedly failed reachability.
-- The body returns the structured reason; the orchestrator owns the TTL.

CREATE TABLE route_blacklist (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  dimension       TEXT NOT NULL CHECK (length(trim(dimension)) > 0),
  kind            TEXT NOT NULL CHECK (kind IN ('entity', 'point', 'region', 'hazard')),
  x               REAL NOT NULL,
  y               REAL NOT NULL,
  z               REAL NOT NULL,
  radius          REAL NOT NULL CHECK (radius >= 0.0 AND radius <= 128.0),
  target_ref      TEXT,
  reason_code     TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  reason_detail   TEXT,
  source          TEXT NOT NULL CHECK (source IN ('body', 'agent', 'operator')),
  expires_at_ms   INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
  created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms   INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE UNIQUE INDEX route_blacklist_target
  ON route_blacklist (session_id, kind, dimension, x, y, z, ifnull(target_ref, ''));
CREATE INDEX route_blacklist_active
  ON route_blacklist (session_id, dimension, expires_at_ms, updated_at_ms DESC);

ALTER TABLE agent_event ADD COLUMN route_mode TEXT;
ALTER TABLE agent_event ADD COLUMN blocked_reason TEXT;
ALTER TABLE agent_event ADD COLUMN blacklist_id TEXT;
ALTER TABLE agent_event ADD COLUMN target_lock_json TEXT
  CHECK (target_lock_json IS NULL OR json_valid(target_lock_json));
