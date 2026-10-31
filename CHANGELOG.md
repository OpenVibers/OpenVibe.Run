# Changelog

Notable changes to OpenVibe.Run. The service is unreleased; everything below is `0.1.0` in progress.

## Unreleased

### Added

- Placement A1 (openvibe-sdk 0.76.0): `server/dispatch/placement.js` calls `place()` — Bench priors (an hour's
  cache), the person's learned counts and one plain line — and the same answer is stored on the job. `GET
  /api/v1/jobs/:id?explain=1` answers the line beside the contract body. `placement_outcomes` (migration 0007) learns
  one outcome per ended job: exit 0 is ok, a failure or a timeout is not; a cancelled job is not counted.
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
- The managed-browser provider adapter (plan T14 R4a, `server/dispatch/browser-provider.js`): class `browser` jobs
  placed on a `kind=provider` offer named `browser-provider` are sent to the provider's API
  (`browser-provider.job-create-request@1`, the frame alone: no project, subject or requester), mirrored, cancelled
  and expired there; every answer is validated against `job-create-result@1` / `job-state@1` and a malformed one is
  never adopted. Configured by `RUN_BROWSER_PROVIDER_URL`, `RUN_BROWSER_PROVIDER_API_KEY` (Run's env only, never
  logged) and `RUN_BROWSER_PROVIDER_TIMEOUT_MS` (8000); off while the URL or the key is unset.
- Run's own metering of those jobs: the provider's claimed wall time is clamped to Run's observed duration + 5 s
  (a larger claim is logged and never billed), queued as `platform.usage-sample@1` readings in `run_usage_outbox`
  (`migrations/0003_usage_outbox.sql`) with the end state, and relayed to Billing (`RUN_BILLING_URL`) with a Run
  token for audience `openvibe.billing` holding `billing.usage.record` — used for nothing else.

### Changed

- Cancelling a `placed` job no longer settles it at once: a job Run has handed to Bot is marked `cancel_requested`,
  Bot is asked for `job_cancel` and the job ends when Bot reports it — Run never says `cancelled` for work a node may
  still be doing. A `queued` job (sent nowhere) is still cancelled at once.
- `POST /api/v1/jobs` no longer places eagerly: the poller sends each queued job, so a submit never waits on Network
  or Bot and a job whose lifetime ran out is never sent.
- `RUN_JOBS_INTERVAL_MS`/`RUN_DISPATCH_INTERVAL_MS` are replaced by `RUN_POLL_MS` (the poller's own interval).
- `usage.wall_ms`/`usage.seconds` are Bot's metered wall clock: 0 until the job's `job_exit` (Bot is the meter).

### Notes

- OpenVibe.Bot owns the node link and the per-second metering of the jobs it carries (plan T14 L1); Run's Billing
  token is for the external provider's jobs only.
- The repo is not deployed; the first deploy needs `ovhost`'s inventory, the `ov_run` database,
  `/etc/openvibe/run.env` and `openvibe.run` DNS (see STATUS.json).
