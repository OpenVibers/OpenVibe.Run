-- phase: expand
-- Usage readings Run meters itself (plan T14 R4a): the external managed-browser provider's jobs only, since Bot meters
-- every job it carries. platform.usage-sample@1 readings waiting for OpenVibe.Billing (billing.usage.record), the
-- openvibe-sdk outbox shape (outboxSchema('run_usage_outbox')), as OpenVibe.Bot's own run_usage_outbox. event_id is
-- the reading's idempotency_key run:<job id>:<second>, so a second is queued once however often it is written.
CREATE TABLE IF NOT EXISTS run_usage_outbox (
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
CREATE INDEX IF NOT EXISTS run_usage_outbox_due ON run_usage_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS run_usage_outbox_sent ON run_usage_outbox (sent_at) WHERE sent_at IS NOT NULL;
