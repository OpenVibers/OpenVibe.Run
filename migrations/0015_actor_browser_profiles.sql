-- phase: expand
CREATE TABLE run_actor_profiles (
    owner TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    sealed TEXT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (owner, actor_id)
);
ALTER TABLE run_sessions ADD COLUMN actor_id TEXT;
CREATE UNIQUE INDEX run_one_actor_browser ON run_sessions(owner, actor_id) WHERE actor_id IS NOT NULL AND state <> 'ended';
