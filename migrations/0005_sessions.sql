-- phase: expand
-- Run sessions (contracts 0.223.0 run.session@1, the Desks plan's D6): a browser desk Run places for one person, on
-- one of their own machines or on a desk host that serves other people, and leases through OpenVibe.Bot
-- (bot.desk.session). One row per session; its desk time is metered a minute at a time into run_usage_outbox
-- (run:<session>:<minute>) and its start and end are run.session.* events in run_events_outbox.
CREATE TABLE IF NOT EXISTS run_sessions (
    id              text PRIMARY KEY,                       -- ses_<ULID>
    owner           text NOT NULL,                          -- user:usr_…
    via             text,                                   -- service:actor, or null
    kind            text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser')),
    state           text NOT NULL CHECK (state IN ('placing', 'starting', 'running', 'ended')),
    width           integer NOT NULL,
    height          integer NOT NULL,
    ttl_s           integer NOT NULL,
    idle_s          integer NOT NULL,
    machine_asked   text,                                   -- the person's own machine the request named
    requirements    jsonb,
    idempotency_key text,
    request_digest  text NOT NULL,
    machine         text,                                   -- where it runs (placement)
    desk            text,
    trust           text,
    offer_id        text,
    reasons         jsonb NOT NULL DEFAULT '[]',
    created_at      bigint NOT NULL,
    started_at      bigint,
    last_used_at    bigint,
    ended_at        bigint,
    end_reason      text CHECK (end_reason IS NULL OR end_reason IN ('ended', 'ttl', 'idle', 'host_lost', 'unplaceable', 'failed')),
    end_detail      text,
    metered_minutes integer NOT NULL DEFAULT 0,             -- whole minutes of desk time already queued for Billing
    lease_checked_at bigint,
    updated_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_sessions_idem ON run_sessions (owner, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_sessions_owner ON run_sessions (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS run_sessions_open ON run_sessions (state) WHERE state <> 'ended';
