-- phase: expand
-- A session may be a whole desktop (contracts 0.433.0; the owner, 2026-11-14: machines lend desktops to other people's
-- agents, not only browsers). A desktop is placed only on a host that lends desktops (OpenVibe.Link v0.65.0 keeps each
-- one in its own sandbox) and is driven with screen and input only.
ALTER TABLE run_sessions DROP CONSTRAINT IF EXISTS run_sessions_kind_check;
ALTER TABLE run_sessions ADD CONSTRAINT run_sessions_kind_check CHECK (kind IN ('browser', 'desktop'));
