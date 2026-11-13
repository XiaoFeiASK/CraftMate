-- Cross-session landmarks and strategy outcomes for long autonomous runs.
-- Landmarks are facts observed by the body or corrected by the operator; the
-- planner treats low-confidence/expired rows as context, never as hard proof.

CREATE TABLE world_memory (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  kind           TEXT NOT NULL CHECK (
                   kind IN (
                     'home', 'mine', 'resource', 'hazard', 'container',
                     'bed', 'furnace', 'crafting_table', 'portal'
                   )
                 ),
  label          TEXT NOT NULL CHECK (length(trim(label)) > 0),
  dimension      TEXT NOT NULL CHECK (length(trim(dimension)) > 0),
  x              REAL NOT NULL,
  y              REAL NOT NULL,
  z              REAL NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  confidence     REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source         TEXT NOT NULL CHECK (source IN ('body', 'agent', 'operator')),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  expires_at_ms  INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms  INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE UNIQUE INDEX world_memory_place
  ON world_memory (session_id, kind, dimension, x, y, z);
CREATE INDEX world_memory_recall
  ON world_memory (session_id, dimension, kind, observed_at_ms DESC);

CREATE TABLE strategy_memory (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  strategy_key        TEXT NOT NULL CHECK (length(trim(strategy_key)) > 0),
  stage               TEXT NOT NULL CHECK (length(trim(stage)) > 0),
  card_id             TEXT,
  success_count       INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count       INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_failure_code   TEXT,
  last_failure_detail TEXT,
  last_outcome_at_ms  INTEGER CHECK (last_outcome_at_ms IS NULL OR last_outcome_at_ms >= 0),
  confidence          REAL NOT NULL DEFAULT 0.6 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms       INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE (session_id, strategy_key)
) STRICT;

CREATE INDEX strategy_memory_stage
  ON strategy_memory (session_id, stage, updated_at_ms DESC);

-- Playbook provenance survives restart and joins telemetry to the decision.
ALTER TABLE decision_log ADD COLUMN playbook_json TEXT
  CHECK (playbook_json IS NULL OR json_valid(playbook_json));

ALTER TABLE agent_event ADD COLUMN playbook_id TEXT;
ALTER TABLE agent_event ADD COLUMN card_status TEXT;
ALTER TABLE agent_event ADD COLUMN switch_reason TEXT;
ALTER TABLE agent_event ADD COLUMN failure_code TEXT;
ALTER TABLE agent_event ADD COLUMN recovery_id TEXT;
ALTER TABLE agent_event ADD COLUMN model_choice INTEGER
  CHECK (model_choice IS NULL OR model_choice IN (0, 1));
ALTER TABLE agent_event ADD COLUMN fallback_reason TEXT;
