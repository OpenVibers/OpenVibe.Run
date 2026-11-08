-- phase: expand
-- B3 control lease: durable current controller state, validated and enforced by Run.
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS control_lease jsonb;
