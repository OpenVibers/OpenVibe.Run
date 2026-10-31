-- phase: expand
-- Placement A1 (agent plan 2026-10-30): Run places each job with openvibe-sdk/placement's place(), answers the one
-- line saying why with the job, and learns from the job's end.
--
-- run_jobs grows the placement's line, the option key and step kind it chose, the ranked/rejected answer for the API,
-- and placement_recorded, so one ended job is learned exactly once however many times its end is delivered. None of
-- these holds a job argument, a key or a path.
--
-- placement_outcomes is the learned count, one row per (person, option key, step kind): two weights and a time. It
-- holds no text and no payload. Global counts are a SUM over the rows, read through a five-minute cache. The rows are
-- exported and erased with the person (server/account-data.js).

ALTER TABLE run_jobs
    ADD COLUMN IF NOT EXISTS placement_line text,
    ADD COLUMN IF NOT EXISTS placement_option_key text,
    ADD COLUMN IF NOT EXISTS placement_step_kind text,
    ADD COLUMN IF NOT EXISTS placement_explain jsonb,
    ADD COLUMN IF NOT EXISTS placement_recorded boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS placement_outcomes (
    person_id  text NOT NULL,                    -- usr_<ULID>
    option_key text NOT NULL,                    -- the SDK's optionKey(offer)
    step_kind  text NOT NULL,                    -- the job's runtime class
    ok_w       double precision NOT NULL DEFAULT 0,   -- decayed successes
    n_w        double precision NOT NULL DEFAULT 0,   -- decayed tries
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, option_key, step_kind)
);
CREATE INDEX IF NOT EXISTS placement_outcomes_updated ON placement_outcomes (updated_at);
