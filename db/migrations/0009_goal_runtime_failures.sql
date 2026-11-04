-- #50 shipped 0008 before its failure history was persisted. A database that
-- ran that earlier 0008 must gain the column without re-running or editing the
-- original migration; changing an applied script aborts startup on checksum.
ALTER TABLE goal_runtime
  ADD COLUMN failures_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(failures_json) AND json_type(failures_json) = 'array');
