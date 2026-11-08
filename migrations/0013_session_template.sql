-- phase: expand
-- Record the named start preset chosen for each browser desk.
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS template text NOT NULL DEFAULT 'browser';
