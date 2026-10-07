# Changelog

Notable changes to OpenVibe.Run. The service is unreleased; everything below is `0.1.0` in progress.

## Unreleased

### Added

- The repository skeleton (plan T14 step 4, R1a): `server/config.js` on port 4920, `server/db.js`,
  `server/app.js`, `server/index.js`, `server/observability.js` (`/api/health`, `/api/ready`, `/release.json`,
  loopback-only `/metrics`), `server/api/auth.js`, `server/events/outbox.js`, `migrations/0001_jobs.sql`
  (`run_jobs`, `run_events_outbox`), `STATUS.json`, the nginx vhost and the systemd unit.
- The job API (plan T14 step 5, R1b): `POST /api/v1/jobs` (`run.job.submit`), `GET /api/v1/jobs/:id`
  (`run.job.read`), `GET /api/v1/jobs` (`run.job.list`), `POST /api/v1/jobs/:id/cancel` (`run.job.cancel`),
  `POST /api/v1/jobs/:id/stream/ticket` and `GET /api/v1/jobs/:id/stream` (`run.job.stream`) and
  `GET /api/v1/admin/jobs` (`run.job.admin`) — each validated against its released contract, with the project and
  the requester taken from the token alone.
- `run.job.queued|started|succeeded|failed|cancelled|expired` through `run_events_outbox`, written in the same
  transaction as the state change, and the two-minute single-use stream ticket with the SSE stream (replay,
  monotonic `seq`, `Last-Event-ID`).
- `server/dispatch/index.js`: the dispatcher-bridge seam (plan T14 step 6) as a no-op, so every job stays `queued`.

- The dispatcher bridge to OpenVibe.Bot (plan T14 step 6, R1c) and placement (step 7, R3): `server/dispatch/bot.js`
  (the client — `send`/`cancel`/`state` with Run's Network client-credentials token for audience `openvibe.bot`
  holding `bot.job.dispatch`, cached until 60 s before expiry), `server/dispatch/placement.js` (the Fabric offers
  plus `openvibe-sdk/placement` `plan()`, with `user-owned` eligible only when the job's requirements name it) and
  `server/jobs/poller.js` (`RUN_POLL_MS`, default 1000 ms): the ttl sweep, the send, the mirror of Bot's state with
  one `run.job.*` event per state change, the node's stdout as stream `output` events, and the job_cancel.
- `GET /api/v1/jobs/:id/stream` also opens with a Bearer service token holding `run.job.stream` for the job's
  project, beside the ticket.

### Changed

- Cancelling a `placed` job no longer settles it at once: a job Run has handed to Bot is marked `cancel_requested`,
  Bot is asked for `job_cancel` and the job ends when Bot reports it — Run never says `cancelled` for work a node may
  still be doing. A `queued` job (sent nowhere) is still cancelled at once.
- `POST /api/v1/jobs` no longer places eagerly: the poller sends each queued job, so a submit never waits on Network
  or Bot and a job whose lifetime ran out is never sent.
- `RUN_JOBS_INTERVAL_MS`/`RUN_DISPATCH_INTERVAL_MS` are replaced by `RUN_POLL_MS` (the poller's own interval).
- `usage.wall_ms`/`usage.seconds` are Bot's metered wall clock: 0 until the job's `job_exit` (Bot is the meter).

### Notes

- Run holds no Billing token: OpenVibe.Bot owns the node link and the per-second metering (plan T14 L1).
- The repo is not deployed; the first deploy needs `ovhost`'s inventory, the `ov_run` database,
  `/etc/openvibe/run.env` and `openvibe.run` DNS (see STATUS.json).
