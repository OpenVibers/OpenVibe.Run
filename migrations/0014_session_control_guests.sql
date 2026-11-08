-- phase: expand
-- People explicitly named as session controllers may use the session control endpoints.
CREATE TABLE IF NOT EXISTS run_session_control_guests (
    session_id text NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
    subject text NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (session_id, subject)
);
