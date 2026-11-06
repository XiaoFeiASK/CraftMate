-- Token usage is billable evidence even when the operator has not configured
-- a per-million price. Without these columns a successful provider call with
-- price 0 produced no row at all, so the local ledger looked unused forever.
ALTER TABLE model_cost ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (prompt_tokens >= 0);
ALTER TABLE model_cost ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (completion_tokens >= 0);
