-- phase: expand
-- Expand only. Operator budgets are configuration; all financial commitments survive process restarts.
CREATE TABLE IF NOT EXISTS run_compute_budget_locks (provider text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS run_compute_rentals (
 id text PRIMARY KEY, pool text NOT NULL, provider text NOT NULL, remote_id text, machine text,
 state text NOT NULL, month text NOT NULL, currency text NOT NULL, hourly_micros numeric(30,0) NOT NULL,
 reserved_micros numeric(30,0) NOT NULL, spent_micros numeric(30,0) NOT NULL DEFAULT 0,
 quote jsonb NOT NULL, created_at bigint NOT NULL, deadline bigint NOT NULL, released_at bigint,
 idle_since bigint, last_error text
);
CREATE INDEX IF NOT EXISTS run_compute_rentals_live ON run_compute_rentals(state, provider);
CREATE TABLE IF NOT EXISTS run_compute_journal (
 id bigserial PRIMARY KEY, at bigint NOT NULL, event text NOT NULL, rental text, pool text, detail jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS run_compute_pools (id text PRIMARY KEY, strategy text NOT NULL, last_machine text, last_tier text);
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS compute_pool text;
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS compute_strategy text;
ALTER TABLE run_sessions ADD COLUMN IF NOT EXISTS compute_decision jsonb;
CREATE TABLE IF NOT EXISTS run_compute_charges (
 rental text NOT NULL REFERENCES run_compute_rentals(id), month text NOT NULL,
 amount_micros numeric(30,0) NOT NULL, PRIMARY KEY (rental, month)
);
