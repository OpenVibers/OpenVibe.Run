# OpenVibe.Run

The job service of the network (openvibe.run). Design: OpenVibe.Contracts docs/adr/ADR-034-platform-north-star.md;
plan track T14.

## Purpose

OpenVibe.Run accepts jobs, places each one on a node that advertises the runtime class it needs, and follows it to
its end. A job belongs to a **project**, is billed per wall-clock second it runs, and is visible only to the token
that project presents. Run owns the API, the project scope and the placement; OpenVibe.Bot owns the node link and the
per-second metering, so Run holds no Billing token at all (plan T14 L1).

This repository is at plan **T14 step 5 (R1b)**: the API is complete and every job stays `queued`. The dispatcher
bridge to Bot is plan T14 step 6 (R1c) and lives behind the seam in `server/dispatch/index.js`.

## Owns

- The job API (`server/api/v1.js`, one capability per route — the table below) and the job's lifecycle record
  (`run_jobs`, `migrations/0001_jobs.sql`): state, placement, timings, exit, result and the metered wall clock.
- The project scope: a job's `project_id` and `requester` come from the caller's Network token
  (`claims.project_id`, `claims.sub`) and never from a request body; another project's job is `404`, never `403`.
- The `job_<ULID>` id (minted here, passed unchanged to Bot as `platform.job@1` `id`, so every metering reading of
  the job is `run:<id>:<n>`).
- Idempotent submit: one row per `(project_id, idempotency_key)`, a repeat answering the first job, a different body
  with the same key refused `409 run.idempotency.conflict`.
- The `run.job.*` events (`server/jobs/events.js`, `run_events_outbox`), written in the same transaction as the
  state change they describe.
- The job stream (`server/jobs/stream.js`): one ring buffer per open job, the SSE `id` being the job's own monotonic
  `seq`, plus the two-minute single-use stream ticket (`server/jobs/ticket.js`).
- The `platform.workload-requirements@1` default (`{ kind: run.<class>, mobility: job, latency_class: background,
  objective: balanced }`, the contract's own default) and the project caps on a job's limits.

## Does not own

- The node link, the device credentials and the per-second metering: OpenVibe.Bot (`bot.job.dispatch`), which places
  the job on a node advertising `worker:<class>`.
- Identity, tokens and projects (OpenVibe.Network); Run only verifies the tokens it is the audience of.
- The artifacts a job runs and the media its inputs come from (OpenVibe.Media; Run never fetches a caller-chosen
  URL).
- Money: Run writes no usage record and holds no Billing token.

## Depends on

- PostgreSQL 18: `run_jobs` and the `run_events_outbox`; `migrations/` applies on boot.
- Valkey (`VALKEY_URL`, optional): shared state between processes; unset, nothing is shared.
- OpenVibe.Network: the RS256 signing key (JWKS) every token is verified against; Run's client `run` mints the
  events relay's service token.
- OpenVibe.Events: `run.job.*` events go to `events.event.publish`; unset, they wait in `run_events_outbox`.
- OpenVibe.Bot (plan T14 step 6): the dispatcher bridge the jobs wait for.
- `openvibe-contracts` v0.106.0, `openvibe-sdk` v0.34.0 and `openvibe-shared` v2.11.0 (package.json).

## Capabilities and routes

Every route checks exactly the capability its manifest names (`contracts/manifests/capabilities/run.job.*.json`),
from the caller's service token. A Network user token names no project and holds no capability here, so it is
refused like any other token without the grant.

| Method and path                 | Capability       | Request → answer                                       |
|---------------------------------|------------------|--------------------------------------------------------|
| `POST /api/v1/jobs`             | `run.job.submit` | `run.job-create-request@1` → `run.job-create-result@1` (201 created; 200, `created:false` on an idempotent repeat) |
| `GET /api/v1/jobs/:id`          | `run.job.read`   | `common.no-body@1` → `run.job-read-result@1`           |
| `GET /api/v1/jobs?state=&limit=&cursor=` | `run.job.list` | `run.job-list-query@1` → `run.job-list-result@1` |
| `POST /api/v1/jobs/:id/cancel`  | `run.job.cancel` | `common.no-body@1` → `run.job-read-result@1`           |
| `POST /api/v1/jobs/:id/stream/ticket` | `run.job.stream` | `common.no-body@1` → `run.job-stream-ticket-result@1` |
| `GET /api/v1/jobs/:id/stream?ticket=` | `run.job.stream` | a ticket (never a service token) → `text/event-stream` of `run.job-stream-event@1` |
| `GET /api/v1/admin/jobs`        | `run.job.admin`  | `run.job-list-query@1` (with `project_id`) → `run.job-list-result@1` |

`run.job.admin` additionally reads and cancels any project's job and is the only way to pass `project_id` to a list
(the manifest says so); it is internal, so only a first-party `svc:` token may hold it — an app, mod or agent token
with the grant is refused. Every request body and query string is validated against its released contract, and so is
every answer before it is sent; errors are RFC 9457 `application/problem+json`.

## Jobs

- **Submit.** `Idempotency-Key` (or `body.idempotency_key`) makes a retry safe; with neither, Run mints its own key
  and returns it in the read result (`auto:<ulid>`). The row is unique per `(project_id, idempotency_key)` and that
  index is permanent, so a key is spent for good: a repeat always answers the first job, and the same key with
  different work is `409` — the contract promising that "within 24 h" is answered the same way, forever, rather than
  reused. `limits` are capped by the project's (`RUN_LIMITS_*`, `422 run.limits.exceeded`) — the lifetime too, whether
  named or defaulted — `args` over 512 KiB are refused `413 run.args_too_large`, and `ttl_ms` defaults to
  `limits.wall_ms + 600000` exactly as the contract says.
- **States.** `queued → placed → running → succeeded | failed | cancelled | expired`. Run moves a job to `queued`
  and, on a cancel, to `cancelled`; the rest arrives from Bot (plan T14 step 6). An end state never changes, so a
  replay of a cancel is a no-op rather than a second event.
- **Events.** `run.job.queued|started|succeeded|failed|cancelled|expired`, payloads being the
  `run.job-read-result@1` projection their contracts describe. The outbox row is keyed `run:<job id>:<state>` (one
  row per job and state, so a replay is one row); the published envelope carries a contract-valid `evt_<ULID>`
  document id, because `events.event-envelope@1` pins that pattern and OpenVibe.Events validates it on publish.
- **Stream.** `POST /jobs/:id/stream/ticket` mints a two-minute single-use RS256 ticket for that one job (audience
  `openvibe.run`, `typ run-stream`, its own key — never Network's signing key, so it is never a session anywhere).
  `GET /jobs/:id/stream?ticket=…` replays what is kept (the last 1 MiB) and follows; `Last-Event-ID` resumes after
  the last `seq` seen; an ended job replays what is kept and closes with `type: 'end'`. Reconnecting never re-runs a
  job. The ring is this process's memory (reclaimed once it ended or went idle, and rebuilt from the job's row when
  a stream opens again), so `seq` is this process's counter: a resume across a restart gets the current state rather
  than a gap, and output is best effort either way.
- **The `job` record.** `run_jobs.job` holds the `platform.job@1` body Run will send (id, class, artifact, args,
  ttl_ms, limits, net, inputs) plus the fields `platform.job@1` has no place for and `0001_jobs.sql` has no column
  for: `requirements` (required by `run.job-read-result@1` and by placement), `placed_at` (`timings.placed_at`) and
  `cancel_requested` (a cancel of a placed or running job). `store.frameOf(record)` builds the frame body from the
  `platform.job@1` keys alone, and the dispatcher bridge validates it before anything is sent.
- **Cancelling.** A queued or placed job is cancelled at once (`exit` stays null, usage stays 0); a running job is
  marked `cancel_requested` and ends when its `job_exit` arrives (step 6). Cancelling an ended job answers it as it
  is.

## Tests

```
npm test              # every file in test/, PGlite (in-process PostgreSQL)
npm run test:pg       # the same on the production-shaped containers (openvibe-sdk scripts/test-services.sh up)
node test/jobs.test.js   # the job API against the released contracts
node test/app.test.js    # the skeleton: health, readiness, release.json, /metrics, the dispatcher seam
```

`test/helpers/app.js` boots Run against an in-process OpenVibe.Network stub (its JWKS and its tokens), so nothing
needs the network, OpenVibe.Bot or a running service.

## Security

- Every route checks one capability; the project and the requester come from the token, never the body.
- Another project's job is `404 run.job_not_found`, never `403`: an id's existence is never confirmed.
- The stream route accepts only a valid, unexpired, unused ticket for that job — a service token in the query string
  is refused like any other non-ticket.
- Limits are bounded by the contract and the project's caps; nothing is silently lowered.
- No secret is logged (no `Authorization` header, no ticket, no job output), and nothing starts at module load.
- See SECURITY.md to report a problem.

## Deploy

Not deployed yet: `openvibe.run` has no DNS, no `ovhost` inventory entry, no `ov_run` database and no
`/etc/openvibe/run.env`. The release is here ready for them:

- `deploy/nginx/openvibe.run.conf` — the vhost (TLS, www → apex, rate limits, client IP from `$remote_addr` only,
  `/internal/` and `/metrics` never proxied).
- `deploy/systemd/openvibe-run.service` — unit `openvibe-run`, `WorkingDirectory=/opt/openvibe.run`,
  `EnvironmentFile=/etc/openvibe/run.env`, `PORT=4920`.
- `/api/health` and `/api/ready` are for the loopback caller; `/metrics` refuses anything that arrived through a
  proxy.

## Deploy files

| File | What it is |
|------|------------|
| `deploy/nginx/openvibe.run.conf` | The nginx vhost for openvibe.run (reference; deployed to `/etc/nginx/sites-available/`) |
| `deploy/systemd/openvibe-run.service` | The systemd unit (release layout `/opt/openvibe.run`) |
| `.github/workflows/ci.yml` | CI: the shared test job (syntax, tests, `openvibe-contracts-check --service run`) and the shared security job |
| `migrations/0001_jobs.sql` | `run_jobs` and `run_events_outbox` |
| `STATUS.json` | What this repository is, what it does today and where it runs |
