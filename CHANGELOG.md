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

### Notes

- Run holds no Billing token: OpenVibe.Bot owns the node link and the per-second metering (plan T14 L1).
- The repo is not deployed; the first deploy needs `ovhost`'s inventory, the `ov_run` database,
  `/etc/openvibe/run.env` and `openvibe.run` DNS (see STATUS.json).
