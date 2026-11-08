-- phase: expand
-- Owner-readable session command timeline. Content is deliberately limited to metadata, never command values.
CREATE TABLE IF NOT EXISTS run_session_actions (
    id bigserial PRIMARY KEY,
    session_id text NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
    command_id text NOT NULL,
    kind text NOT NULL,
    action text,
    actor_kind text NOT NULL,
    actor_subject text NOT NULL,
    result text NOT NULL,
    code text,
    created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS run_session_actions_newest ON run_session_actions (session_id, id DESC);
