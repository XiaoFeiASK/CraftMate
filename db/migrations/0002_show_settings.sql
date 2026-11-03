-- Operator-editable show configuration.
-- One row per live session: editing settings never rewrites evidence history.

CREATE TABLE show_settings (
  session_id    TEXT PRIMARY KEY REFERENCES show_session(id) ON DELETE RESTRICT,
  content_json  TEXT NOT NULL CHECK (json_valid(content_json)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE app_preference (
  key           TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
