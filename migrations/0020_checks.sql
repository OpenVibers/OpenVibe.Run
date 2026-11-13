-- phase: expand
-- The checks scheduler (research-2026-11-13/shared-node-checks.md, piece 2): the GitHub App made by the
-- manifest flow, the webhook deliveries, one plan per workflow run, the planned workflow jobs with their
-- check runs and Run jobs, and the shadow pair of a node conclusion beside the Actions one.
--
-- Secrets (the App private key, its webhook secret, its client secret and every installation token) are
-- only ever stored sealed by server/checks/crypto.js (AES-256-GCM, RUN_SECRETS_KEY): no column here holds
-- one in the clear, and no route, log or node input ever carries one.
CREATE TABLE IF NOT EXISTS run_checks_app (
    id                     integer PRIMARY KEY CHECK (id = 1),
    app_id                 bigint NOT NULL,
    slug                   text NOT NULL,
    name                   text NOT NULL,
    html_url               text,
    pem_enc                text NOT NULL,
    webhook_secret_enc     text NOT NULL,
    client_id              text,
    client_secret_enc      text,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);

-- The accounts the App is installed on: kept from installation webhooks and refreshed from GET /app/installations.
CREATE TABLE IF NOT EXISTS run_checks_installations (
    installation_id        bigint PRIMARY KEY,
    account_login          text NOT NULL,
    account_id             bigint,
    account_type           text,
    suspended_at           bigint,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);

-- Installation access tokens, cached until five minutes before they expire, sealed at rest.
CREATE TABLE IF NOT EXISTS run_checks_tokens (
    installation_id        bigint PRIMARY KEY,
    token_enc              text NOT NULL,
    expires_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);

-- Webhook deliveries are deduplicated by X-GitHub-Delivery and swept after seven days.
CREATE TABLE IF NOT EXISTS run_checks_deliveries (
    delivery_id            text PRIMARY KEY,
    event                  text,
    received_at            bigint NOT NULL,
    expires_at             bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS run_checks_deliveries_expiry ON run_checks_deliveries (expires_at);

-- One plan per matching workflow of one event (a push can match several workflow files).
CREATE TABLE IF NOT EXISTS run_checks_plans (
    id                     text PRIMARY KEY CHECK (id ~ '^chkplan_[0-9A-HJKMNP-TV-Z]{26}$'),
    delivery_id            text,
    repo                   text NOT NULL,
    repo_owner             text NOT NULL,
    sha                    text NOT NULL,
    event                  text NOT NULL CHECK (event IN ('push','pull_request')),
    ref                    text NOT NULL,
    branch                 text,
    installation_id        bigint,
    workflow_path          text NOT NULL,
    workflow_name          text NOT NULL,
    state                  text NOT NULL CHECK (state IN ('active','succeeded','failed','skipped')),
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS run_checks_plans_state ON run_checks_plans (state, created_at);

-- One planned workflow job (one matrix combination is one row). `check_state` is the GitHub check run's
-- status; `state` is the scheduler's: waiting (needs pending), queuing (a tick claimed it), queued,
-- running, completed.
CREATE TABLE IF NOT EXISTS run_checks_jobs (
    id                     text PRIMARY KEY CHECK (id ~ '^chkjob_[0-9A-HJKMNP-TV-Z]{26}$'),
    plan_id                text NOT NULL REFERENCES run_checks_plans(id) ON DELETE CASCADE,
    job_key                text NOT NULL,
    job_name               text NOT NULL,
    display_name           text NOT NULL,
    workflow_path          text NOT NULL,
    workflow_job_key       text NOT NULL,
    stage                  integer NOT NULL,
    needs                  jsonb NOT NULL DEFAULT '[]'::jsonb,
    matrix                 jsonb,
    matrix_group           text,
    max_parallel           integer,
    timeout_minutes        integer NOT NULL,
    check_run_id           bigint,
    check_state            text NOT NULL DEFAULT 'queued' CHECK (check_state IN ('queued','in_progress','completed')),
    state                  text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','queuing','queued','running','completed')),
    conclusion             text,
    run_job_id             text,
    attempts               integer NOT NULL DEFAULT 0,
    report_errors          integer NOT NULL DEFAULT 0,
    queued_at              bigint,
    started_at             bigint,
    finished_at            bigint,
    queue_ms               bigint,
    run_ms                 bigint,
    node_id                text,
    summary                text,
    error                  text,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL,
    UNIQUE (plan_id, job_key)
);
CREATE INDEX IF NOT EXISTS run_checks_jobs_plan_state ON run_checks_jobs (plan_id, state);
CREATE INDEX IF NOT EXISTS run_checks_jobs_run_job ON run_checks_jobs (run_job_id);

-- Shadow first: the same workflow job on a node and on Actions, one row, whichever arrives first.
CREATE TABLE IF NOT EXISTS run_checks_shadow (
    id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    repo                   text NOT NULL,
    sha                    text NOT NULL,
    workflow_name          text NOT NULL DEFAULT '',
    job_name               text NOT NULL,
    check_run_id           bigint,
    node_conclusion        text,
    actions_conclusion     text,
    queue_ms               bigint,
    run_ms                 bigint,
    node_started_at        bigint,
    node_finished_at       bigint,
    actions_started_at     bigint,
    actions_finished_at    bigint,
    created_at             bigint NOT NULL,
    updated_at             bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS run_checks_shadow_lookup ON run_checks_shadow (repo, sha, job_name);
CREATE INDEX IF NOT EXISTS run_checks_shadow_repo ON run_checks_shadow (repo, created_at);
