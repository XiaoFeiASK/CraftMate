-- Resetting dashboard counters must not delete decisions or break action recovery.
CREATE TABLE dashboard_activity (
  session_id TEXT PRIMARY KEY REFERENCES show_session(id),
  since_ms INTEGER NOT NULL CHECK (since_ms >= 0)
);
