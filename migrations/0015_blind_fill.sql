-- phase: expand
-- Blind fill stores request metadata and a credential-free result; envelopes are single-use in transit only.
CREATE TABLE IF NOT EXISTS run_session_fill_requests (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
    machine_node_id text NOT NULL,
    agent_subject text NOT NULL,
    origin text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'running', 'ok', 'failed', 'expired')),
    decision text CHECK (decision IS NULL OR decision IN ('approved', 'declined', 'expired')),
    outcome text CHECK (outcome IS NULL OR outcome IN ('ok', 'failed')),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    finished_at bigint,
    resumed_at bigint
);
CREATE INDEX IF NOT EXISTS run_fill_pending ON run_session_fill_requests (session_id, state, expires_at);
