-- Stage C output and replay support. Speech is stored because a commitment is
-- only allowed to exist for text the show actually intended to say.

ALTER TABLE decision_log ADD COLUMN speech_text TEXT NOT NULL DEFAULT '';
ALTER TABLE decision_log ADD COLUMN skill_json TEXT CHECK (skill_json IS NULL OR json_valid(skill_json));

CREATE INDEX decision_log_trace ON decision_log (session_id, trace_id);
CREATE INDEX commitment_source ON commitment (source_id);
