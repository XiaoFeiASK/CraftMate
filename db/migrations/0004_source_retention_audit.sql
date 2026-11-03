-- Row-level proof that an expired raw comment was purged, while its hash and
-- structured payload remain for deduplication and audit.

CREATE TABLE source_retention_audit (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  source_id     TEXT NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('raw_text_expired')),
  content_hash  TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE UNIQUE INDEX source_retention_audit_source
  ON source_retention_audit (source_id, action);

CREATE INDEX source_retention_audit_session
  ON source_retention_audit (session_id, occurred_at_ms DESC);
