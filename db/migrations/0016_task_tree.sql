-- Agent task-tree cursor and checkpoint projection. The tree is durable so a
-- restart can explain where the run stopped; it is re-observed before any
-- branch is resumed. Evidence remains a bounded reference list, not a copy of
-- world snapshots (world_memory/action_attempt own the full records).
ALTER TABLE goal_runtime
  ADD COLUMN task_tree_json TEXT
  CHECK (task_tree_json IS NULL OR json_valid(task_tree_json));

ALTER TABLE goal_runtime
  ADD COLUMN task_node_json TEXT
  CHECK (task_node_json IS NULL OR json_valid(task_node_json));

ALTER TABLE goal_runtime
  ADD COLUMN target_family TEXT
  CHECK (target_family IS NULL OR length(trim(target_family)) > 0);

ALTER TABLE goal_runtime
  ADD COLUMN evidence_refs_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(evidence_refs_json) AND json_type(evidence_refs_json) = 'array');

ALTER TABLE goal_runtime
  ADD COLUMN failure_record_json TEXT
  CHECK (failure_record_json IS NULL OR json_valid(failure_record_json));
