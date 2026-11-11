-- phase: expand
-- Null keeps older sessions unrestricted; an empty array permits no browser origin.
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS task_origins JSONB;
