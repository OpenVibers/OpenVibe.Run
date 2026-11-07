-- phase: expand
-- One Computer across Surf, Actor and the Dock (plan 2026-11-07): a session now names the Actor task that asked for it,
-- and it can be behind Curtain now, in which case its still never shows the screen.
--
-- task_id is the task the session is the Computer of (contracts 0.327.0, run.session@1 task_id). Null when a person
-- opened the session themselves. Not personal data: it is the id of a task the same person owns.
-- curtain is the privacy screen: while it is true the still endpoint answers the curtain picture, never the screen.
ALTER TABLE run_sessions
    ADD COLUMN IF NOT EXISTS task_id text,
    ADD COLUMN IF NOT EXISTS curtain boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS run_sessions_task ON run_sessions (task_id) WHERE task_id IS NOT NULL;
