-- CraftMate SQLite schema v1.
-- Runtime must set PRAGMA foreign_keys = ON and busy_timeout before applying.

CREATE TABLE schema_migration (
  version       INTEGER PRIMARY KEY CHECK (version > 0),
  name          TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE persona (
  id          TEXT PRIMARY KEY,
  persona_key TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE persona_version (
  id            TEXT PRIMARY KEY,
  persona_id    TEXT NOT NULL REFERENCES persona(id) ON DELETE RESTRICT,
  revision      INTEGER NOT NULL CHECK (revision > 0),
  content_json  TEXT NOT NULL CHECK (json_valid(content_json)),
  state         TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (persona_id, revision)
) STRICT;

CREATE UNIQUE INDEX persona_version_one_active
  ON persona_version (persona_id)
  WHERE state = 'active';

CREATE TABLE show_session (
  id                TEXT PRIMARY KEY,
  session_no        INTEGER NOT NULL UNIQUE CHECK (session_no > 0),
  persona_version_id TEXT NOT NULL REFERENCES persona_version(id) ON DELETE RESTRICT,
  goal_text         TEXT NOT NULL CHECK (length(trim(goal_text)) > 0),
  status            TEXT NOT NULL CHECK (status IN ('planned', 'live', 'ended', 'aborted')),
  started_at_ms     INTEGER CHECK (started_at_ms >= 0),
  ended_at_ms       INTEGER CHECK (ended_at_ms >= 0),
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (status = 'planned' OR started_at_ms IS NOT NULL),
  CHECK (status NOT IN ('ended', 'aborted') OR ended_at_ms IS NOT NULL),
  CHECK (ended_at_ms IS NULL OR started_at_ms IS NULL OR ended_at_ms >= started_at_ms)
) STRICT;

CREATE INDEX show_session_status ON show_session (status, created_at_ms);

CREATE TABLE source (
  id                TEXT PRIMARY KEY,
  -- Platform event id. NULL for locally generated sources (operator, world, system).
  external_event_id TEXT,
  session_id        TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (
                      kind IN (
                        'comment', 'gift', 'like', 'enter', 'viewer_count',
                        'operator', 'world', 'system'
                      )
                    ),
  actor_ref         TEXT,
  raw_text          TEXT,
  payload_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  content_hash      TEXT NOT NULL,
  received_at_ms    INTEGER NOT NULL CHECK (received_at_ms >= 0),
  raw_expires_at_ms INTEGER CHECK (raw_expires_at_ms >= received_at_ms)
) STRICT;

CREATE INDEX source_session_received ON source (session_id, received_at_ms);
CREATE INDEX source_actor ON source (actor_ref, received_at_ms);
CREATE UNIQUE INDEX source_platform_event
  ON source (session_id, kind, external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE TABLE decision_log (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  source_id         TEXT NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
  persona_version_id TEXT NOT NULL REFERENCES persona_version(id) ON DELETE RESTRICT,
  trace_id          TEXT NOT NULL,
  revision          INTEGER NOT NULL CHECK (revision > 0),
  stage             TEXT NOT NULL CHECK (stage IN ('rules', 'scored', 'planned')),
  intent            TEXT NOT NULL CHECK (
                      intent IN (
                        'move', 'mine', 'build', 'craft', 'eat', 'follow',
                        'chat', 'danger', 'spam', 'unknown'
                      )
                    ),
  decision          TEXT NOT NULL CHECK (
                      decision IN ('IGNORE', 'OBSERVE', 'ACK_ONLY', 'QUEUE', 'EXECUTE', 'REFUSE')
                    ),
  priority          TEXT NOT NULL CHECK (
                      priority IN (
                        'reflex', 'operator', 'safety', 'promise',
                        'plan', 'vote', 'command', 'ambient'
                      )
                    ),
  score             REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  reason            TEXT NOT NULL,
  trace_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trace_json)),
  provider          TEXT,
  model             TEXT,
  latency_ms        INTEGER CHECK (latency_ms >= 0),
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (source_id, revision)
) STRICT;

CREATE INDEX decision_log_current
  ON decision_log (source_id, revision DESC);
CREATE INDEX decision_log_session
  ON decision_log (session_id, created_at_ms DESC);

CREATE TABLE action_attempt (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  decision_id     TEXT NOT NULL REFERENCES decision_log(id) ON DELETE RESTRICT,
  skill           TEXT NOT NULL,
  args_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(args_json)),
  priority        TEXT NOT NULL CHECK (
                    priority IN (
                      'reflex', 'operator', 'safety', 'promise',
                      'plan', 'vote', 'command', 'ambient'
                    )
                  ),
  status          TEXT NOT NULL CHECK (
                    status IN (
                      'queued', 'running', 'completed', 'preempted',
                      'cancelled', 'failed', 'timeout'
                    )
                  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  deadline_tick   INTEGER CHECK (deadline_tick >= 0),
  started_at_ms   INTEGER CHECK (started_at_ms >= 0),
  finished_at_ms  INTEGER CHECK (finished_at_ms >= 0),
  error_code      TEXT,
  result_json     TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (finished_at_ms IS NULL OR started_at_ms IS NULL OR finished_at_ms >= started_at_ms),
  CHECK (
    (status IN ('completed', 'preempted', 'cancelled', 'failed', 'timeout') AND finished_at_ms IS NOT NULL)
    OR
    (status IN ('queued', 'running') AND finished_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX action_attempt_decision ON action_attempt (decision_id);
CREATE INDEX action_attempt_session_status ON action_attempt (session_id, status);

CREATE TABLE world_event (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  seq           INTEGER NOT NULL CHECK (seq >= 0),
  tick          INTEGER NOT NULL CHECK (tick >= 0),
  name          TEXT NOT NULL,
  data_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (session_id, seq)
) STRICT;

CREATE INDEX world_event_tick ON world_event (session_id, tick);

CREATE TABLE commitment (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES show_session(id) ON DELETE RESTRICT,
  source_id          TEXT REFERENCES source(id) ON DELETE RESTRICT,
  persona_version_id TEXT NOT NULL REFERENCES persona_version(id) ON DELETE RESTRICT,
  audience_ref       TEXT NOT NULL,
  utterance          TEXT NOT NULL CHECK (length(trim(utterance)) > 0),
  status             TEXT NOT NULL CHECK (
                       status IN (
                         'proposed', 'spoken', 'accepted', 'in_progress',
                         'fulfilled', 'expired', 'broken', 'cancelled'
                       )
                     ),
  revision           INTEGER NOT NULL CHECK (revision > 0),
  deadline_at_ms     INTEGER CHECK (deadline_at_ms >= 0),
  deadline_tick      INTEGER CHECK (deadline_tick >= 0),
  plan_id            TEXT,
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0),
  spoken_at_ms       INTEGER CHECK (spoken_at_ms >= 0),
  closed_at_ms       INTEGER CHECK (closed_at_ms >= 0),
  CHECK (
    (status IN ('fulfilled', 'expired', 'broken', 'cancelled') AND closed_at_ms IS NOT NULL)
    OR
    (status NOT IN ('fulfilled', 'expired', 'broken', 'cancelled') AND closed_at_ms IS NULL)
  ),
  CHECK (status <> 'proposed' OR spoken_at_ms IS NULL),
  CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms),
  CHECK (spoken_at_ms IS NULL OR spoken_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX commitment_open_deadline ON commitment (session_id, deadline_at_ms)
  WHERE status NOT IN ('fulfilled', 'expired', 'broken', 'cancelled');
CREATE INDEX commitment_audience ON commitment (audience_ref, created_at_ms);

CREATE TABLE commitment_event (
  id             TEXT PRIMARY KEY,
  commitment_id  TEXT NOT NULL REFERENCES commitment(id) ON DELETE RESTRICT,
  from_status    TEXT CHECK (
                   from_status IS NULL OR from_status IN (
                     'proposed', 'spoken', 'accepted', 'in_progress',
                     'fulfilled', 'expired', 'broken', 'cancelled'
                   )
                 ),
  to_status      TEXT NOT NULL CHECK (
                   to_status IN (
                     'proposed', 'spoken', 'accepted', 'in_progress',
                     'fulfilled', 'expired', 'broken', 'cancelled'
                   )
                 ),
  reason         TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX commitment_event_timeline
  ON commitment_event (commitment_id, occurred_at_ms);

CREATE TABLE memory (
  id                 TEXT PRIMARY KEY,
  lineage_id         TEXT NOT NULL,
  session_id         TEXT REFERENCES show_session(id) ON DELETE RESTRICT,
  persona_version_id TEXT REFERENCES persona_version(id) ON DELETE RESTRICT,
  subject_ref        TEXT NOT NULL,
  family             TEXT NOT NULL CHECK (
                       family IN ('viewer', 'world', 'experience', 'procedure', 'relationship')
                     ),
  content            TEXT NOT NULL CHECK (length(trim(content)) > 0),
  disclosure         TEXT NOT NULL CHECK (
                       disclosure IN ('full', 'paraphrase', 'hint', 'silence')
                     ),
  confidence         REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  state              TEXT NOT NULL CHECK (
                       state IN ('active', 'forgotten', 'merged', 'retired')
                     ),
  revision           INTEGER NOT NULL CHECK (revision > 0),
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (lineage_id, revision)
) STRICT;

CREATE INDEX memory_lineage_current ON memory (lineage_id, revision DESC);
CREATE INDEX memory_subject ON memory (subject_ref, family, state);

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source(id) ON DELETE RESTRICT,
  PRIMARY KEY (memory_id, source_id)
) STRICT;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts (memory_id, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER memory_fts_update AFTER UPDATE OF content ON memory BEGIN
  DELETE FROM memory_fts WHERE memory_id = OLD.id;
  INSERT INTO memory_fts (memory_id, content) VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER memory_fts_delete AFTER DELETE ON memory BEGIN
  DELETE FROM memory_fts WHERE memory_id = OLD.id;
END;

CREATE TABLE review_candidate (
  id               TEXT PRIMARY KEY,
  session_id       TEXT REFERENCES show_session(id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL CHECK (kind IN ('experience', 'skill', 'persona')),
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reviewer         TEXT,
  decision_reason  TEXT,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  created_at_ms    INTEGER NOT NULL CHECK (created_at_ms >= 0),
  decided_at_ms    INTEGER CHECK (decided_at_ms >= 0),
  CHECK (status = 'pending' OR decided_at_ms IS NOT NULL)
) STRICT;

CREATE INDEX review_candidate_pending
  ON review_candidate (status, created_at_ms)
  WHERE status = 'pending';

CREATE TABLE incident (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES show_session(id) ON DELETE RESTRICT,
  severity      TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error', 'fatal')),
  code          TEXT NOT NULL,
  detail_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  resolved_at_ms INTEGER CHECK (resolved_at_ms >= 0),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX incident_session_time ON incident (session_id, created_at_ms DESC);

CREATE VIEW decision_current AS
SELECT d.*
FROM decision_log AS d
WHERE d.revision = (
  SELECT MAX(d2.revision)
  FROM decision_log AS d2
  WHERE d2.source_id = d.source_id
);

CREATE VIEW commitment_open AS
SELECT c.*
FROM commitment AS c
WHERE c.status NOT IN ('fulfilled', 'expired', 'broken', 'cancelled');

CREATE VIEW memory_current AS
SELECT m.*
FROM memory AS m
WHERE m.revision = (
  SELECT MAX(m2.revision)
  FROM memory AS m2
  WHERE m2.lineage_id = m.lineage_id
);

CREATE VIEW memory_active AS
SELECT m.*
FROM memory_current AS m
WHERE m.state = 'active';

