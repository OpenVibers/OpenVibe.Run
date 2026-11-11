-- phase: expand
CREATE TABLE IF NOT EXISTS config_snapshots (
    namespace            text COLLATE "C" NOT NULL,
    revision             bigint NOT NULL,
    service              text COLLATE "C" NOT NULL,
    previous_revision    bigint,
    state                text COLLATE "C" NOT NULL CHECK (state IN ('proposed', 'active', 'superseded', 'rejected', 'rolled_back')),
    values_json          text COLLATE "C" NOT NULL,              -- the full values; secret-class values are envelopes (never their plaintext)
    classification_json  text COLLATE "C" NOT NULL,
    values_checksum      text COLLATE "C" NOT NULL,              -- sha256 of the values as served (secrets as markers)
    created_at           text COLLATE "C" NOT NULL,
    created_by           text COLLATE "C" NOT NULL,
    activated_at         text COLLATE "C",
    activated_by         text COLLATE "C",
    reason               text COLLATE "C",
    error                text COLLATE "C",
    copied_from          bigint,
    good                 bigint NOT NULL DEFAULT 0,             -- 1 once it activated successfully (last-known-good)
    PRIMARY KEY (namespace, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS config_snapshots_one_active ON config_snapshots (namespace) WHERE state = 'active';
-- The fingerprint key of each namespace. Never served, never logged.
CREATE TABLE IF NOT EXISTS config_keys (
    namespace   text COLLATE "C" PRIMARY KEY,
    hmac_key    bytea NOT NULL,                                -- the 32-byte fingerprint key, or that key wrapped under the current KEK
    created_at  text COLLATE "C" NOT NULL
);