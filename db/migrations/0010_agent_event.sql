-- Operator-observable agent events. This is the join between an audience
-- trace, a goal task, a decision, and the body's terminal outcome. Free-text
-- columns are written only after the control-plane redaction boundary.

CREATE TABLE agent_event (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  stage       TEXT NOT NULL CHECK (
                stage IN (
                  'ingress_received', 'gated', 'dropped', 'arbitrated', 'planned',
                  'task_queued', 'task_running', 'progress', 'task_settled',
                  'failed', 'voice_started', 'voice_settled', 'settings_applied',
                  'connection_changed'
                )
              ),
  status      TEXT NOT NULL CHECK (
                status IN ('ok', 'waiting', 'degraded', 'failed', 'skipped', 'unknown')
              ),
  trace_id    TEXT,
  task_id     TEXT,
  decision_id TEXT,
  goal_id     TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  summary     TEXT NOT NULL DEFAULT '',
  error_code  TEXT,
  source      TEXT NOT NULL CHECK (
                source IN ('ingress', 'agent', 'goal', 'voice', 'bridge', 'control')
              ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX agent_event_recent ON agent_event (created_at_ms DESC);
CREATE INDEX agent_event_trace ON agent_event (trace_id, created_at_ms);
CREATE INDEX agent_event_task ON agent_event (task_id, created_at_ms);
CREATE INDEX agent_event_decision ON agent_event (decision_id, created_at_ms);

