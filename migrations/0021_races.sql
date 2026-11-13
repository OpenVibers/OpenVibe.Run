-- phase: expand
-- The Arena's race (compare-arena-ecosystem.md §3, 2026-11-13): one parent record per round, its sides in
-- the shown order, the entrant each side ran and the child job that answers it, the person who started it,
-- and the one human judgement that ends the round. The parent itself is Run's record; the child runs stay
-- run_jobs rows (one per side), so placement, metering and the job stream are unchanged.
--
-- SIDES is [{ slot, entrant, job_id }] in the order the sides are shown (a, b, …); ENTRANT is a
-- bench.entrant@1 id and is never answered before JUDGEMENT is written. MATCH_ID is the bench.match@1 id
-- minted with the race, so a retry after a lost answer records the same match at Bench rather than a second
-- one. JUDGEMENT is { winner, judge, at, match_id, by_hash } once Bench accepted the match.
CREATE TABLE IF NOT EXISTS run_races (
    id              text PRIMARY KEY CHECK (id ~ '^rac_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id      text NOT NULL,
    requester       text NOT NULL,               -- the person who started it: user:<subject>
    via             text NOT NULL,               -- the first-party service they started it through
    kind            text NOT NULL CHECK (kind IN ('chat', 'code', 'design')),
    prompt          text NOT NULL,
    prompt_hash     text NOT NULL CHECK (prompt_hash ~ '^[a-f0-9]{64}$'),
    sides           jsonb NOT NULL,
    budget          jsonb NOT NULL,              -- { total: {...}, per_side: {...} }; the same share for every side
    play            jsonb NOT NULL,              -- the race's agents.play@1 document, with the sides that ran
    match_id        text NOT NULL CHECK (match_id ~ '^mat_[0-9A-HJKMNP-TV-Z]{26}$'),
    blind           boolean NOT NULL DEFAULT true,
    judgement       jsonb,
    judged_at       bigint,
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS run_races_owner ON run_races (project_id, requester, via, created_at DESC);
