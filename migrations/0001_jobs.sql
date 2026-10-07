-- phase: expand
-- OpenVibe.Run's own record of a job (plan T14 R1; run.job.*). Bot owns the node link and the
-- per-second metering (OpenVibe.Bot/server/jobs); Run owns the API, the placement and the project scope.
CREATE TABLE IF NOT EXISTS run_jobs (
    id              text PRIMARY KEY CHECK (id ~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id      text NOT NULL,
    requester       text NOT NULL,               -- the token principal that submitted it
    idempotency_key text NOT NULL,
    class           text NOT NULL,
    job             jsonb NOT NULL,              -- the platform.job@1 body sent to the node
    ttl_ms          bigint NOT NULL,
    state           text NOT NULL CHECK (state IN ('queued','placed','running','succeeded','failed','cancelled','expired')),
    node_id         text,
    provider        text,
    region          text,
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL,
    started_ms      bigint,
    finished_ms     bigint,
    exit_reason     text,
    exit_code       integer,
    result          jsonb,
    wall_ms         bigint NOT NULL DEFAULT 0,
    usage_read      integer NOT NULL DEFAULT 0,
    error_code      text,
    error_detail    text
);
CREATE UNIQUE INDEX IF NOT EXISTS run_jobs_idem ON run_jobs (project_id, idempotency_key);
CREATE INDEX IF NOT EXISTS run_jobs_project_state ON run_jobs (project_id, created_at DESC);
-- run.job.* events waiting for the bus: the openvibe-sdk outbox shape (outboxSchema('run_events_outbox')).
CREATE TABLE IF NOT EXISTS run_events_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
