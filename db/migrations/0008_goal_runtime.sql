-- Operator-owned end goal and the audience proposal inbox.
-- Goal progress is evidence: milestones are stored explicitly and never
-- reconstructed as a display-only percentage.

CREATE TABLE goal_runtime (
  session_id             TEXT PRIMARY KEY REFERENCES show_session(id) ON DELETE RESTRICT,
  goal_json              TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)),
  enabled                INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  progress_json          TEXT CHECK (progress_json IS NULL OR json_valid(progress_json)),
  current_decision_id    TEXT,
  current_strategy_key   TEXT,
  last_failure           TEXT,
  last_failure_strategy  TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  retry_at_ms            INTEGER NOT NULL DEFAULT 0 CHECK (retry_at_ms >= 0),
  updated_at_ms          INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  failures_json          TEXT NOT NULL DEFAULT '[]'
                         CHECK (json_valid(failures_json) AND json_type(failures_json) = 'array')
) STRICT;

CREATE TABLE proposal (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  audience_ref   TEXT NOT NULL,
  text           TEXT NOT NULL CHECK (length(trim(text)) > 0),
  normalized_text TEXT NOT NULL,
  votes          INTEGER NOT NULL CHECK (votes > 0),
  intent         TEXT NOT NULL CHECK (
                   intent IN (
                     'move', 'mine', 'build', 'craft', 'eat', 'follow',
                     'chat', 'danger', 'spam', 'unknown'
                   )
                 ),
  status         TEXT NOT NULL CHECK (
                   status IN ('pending', 'accepted', 'deferred', 'rejected', 'clarify')
                 ),
  reason         TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  risk           TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'blocked')),
  goal_alignment TEXT NOT NULL CHECK (
                   goal_alignment IN ('aligned', 'neutral', 'off_goal', 'unknown')
                 ),
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  decided_at_ms  INTEGER CHECK (decided_at_ms >= 0),
  CHECK (decided_at_ms IS NULL OR decided_at_ms >= created_at_ms),
  UNIQUE (session_id, source_event_id)
) STRICT;

CREATE INDEX proposal_session_status
  ON proposal (session_id, status, created_at_ms DESC);
CREATE INDEX proposal_pending_text
  ON proposal (session_id, normalized_text, created_at_ms DESC)
  WHERE status = 'pending';

CREATE TABLE proposal_vote (
  proposal_id     TEXT NOT NULL REFERENCES proposal(id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  audience_ref    TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (proposal_id, source_event_id)
) STRICT;
