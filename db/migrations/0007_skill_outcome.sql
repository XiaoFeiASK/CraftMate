-- What a skill achieved, kept beside the decision that authorised it.
-- Before this column the console could only show "decided to mine"; the
-- terminal status and evidence lived in action_attempt and were never joined
-- back onto the decision stream.

ALTER TABLE decision_log ADD COLUMN outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json));
