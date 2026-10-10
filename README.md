# OpenVibe.Run

The job service of the network (openvibe.run). Design: OpenVibe.Contracts docs/adr/ADR-034-platform-north-star.md;
plan track T14.

## Purpose

OpenVibe.Run accepts jobs, places each one on a node that advertises the runtime class it needs, and follows it to
its end. A job belongs to a **project**, is billed per wall-clock second it runs, and is visible only to the token
that project presents. Run owns the API, the project scope and the placement; OpenVibe.Bot owns the node link and the
per-second metering, so Run holds no Billing token at all (plan T14 L1).

This repository is at plan **T14 steps 5 (R1b), 6 (R1c) and 7 (R3)**: the API is complete, and a queued job is
placed from the Fabric's offers and actually runs — the poller in `server/jobs/poller.js` (started by
`server/index.js`) sends it to OpenVibe.Bot, mirrors Bot's state and the node's stdout back, and settles it. Without
`OV_OAUTH_CLIENT_SECRET` Run cannot mint the Network token Bot requires, so the bridge is off and every job stays
`queued`.

## How a job runs

1. **Submit** — `POST /api/v1/jobs` (capability `run.job.submit`). Run validates the request against
   `run.job-create-request@1`, mints the `job_<ULID>` id, stores the row `queued` and writes `run.job.queued` in the
   same transaction. Nothing leaves the process here: a submit never waits on Network or Bot.
2. **Place** — the poller (`RUN_POLL_MS`, default 1000 ms) reads the Fabric's offers for the job's class
   (`GET {OV_NETWORK_URL}/api/v1/offers?kind=node`), and `openvibe-sdk/placement`'s `plan()` chooses the node the
   job's own `requirements` allow. Run records the node, provider and region on its row (`placed_at` included).
   No eligible offer: the job waits queued (a node may be briefly offline) and every tick tries again; if its
   `ttl_ms` runs out first it ends `expired` with `run.job.unplaceable` (ADR-036 section 2).
3. **Send** — Run hands the `platform.job@1` body to Bot (`POST {RUN_BOT_URL}/api/v1/jobs`, capability
   `bot.job.dispatch`, audience `openvibe.bot`) and Bot gives it to the node over its device link. Bot's dispatch is
   idempotent by job id, so a retry after a crash or a timeout is safe.
4. **Mirror** — every tick mirrors each `placed` or `running` job from `GET {RUN_BOT_URL}/api/v1/jobs/{id}`: state,
   timings, exit, result and the metered wall clock (Bot is the meter; Run never posts a usage record). The state
   change and its `run.job.started|succeeded|failed|cancelled|expired` event are one transaction, and the job's
   stdout is carried into its SSE stream as `output` events. A job Bot answers 404 for after Run sent it fails
   `run.job.worker_failed` after `RUN_DISPATCH_UNKNOWN_POLLS` polls — it is never mirrored forever.
5. **End** — `succeeded`, `failed`, `cancelled` or `expired`, from Bot's `job_exit` (or from the cancel request and
   the ttl sweep). An end state never changes. Bot's answer is never trusted over Run's own row: it can neither
   rename the node nor the project of a job Run placed.

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
- Placement (plan T14 R3, `server/dispatch/placement.js`): the job's requirements are stated by Run and the choice
  among offers is `openvibe-sdk/placement` `plan()` — Run writes no placer of its own (ADR-036). The job's
  `worker:<class>` capability is what a candidate must advertise, and a user-owned offer is eligible only when the
  job's requirements name `user-owned` (the contract's own rule; the SDK's fallback trust list would otherwise
  admit it).
- The poller (`server/jobs/poller.js`): the ttl sweep, the send, the mirror, the cancel-on-Bot and the job's stdout
  into the stream.

## Does not own

- The node link, the device credentials and the per-second metering: OpenVibe.Bot (`bot.job.dispatch`), which gives
  the job to a node advertising `worker:<class>` and meters every wall-clock second into `platform.usage-sample@1`
  readings keyed `run:<job id>:<n>`.
- Identity, tokens and projects (OpenVibe.Network); Run only verifies the tokens it is the audience of.
- The artifacts a job runs and the media its inputs come from (OpenVibe.Media; Run never fetches a caller-chosen
  URL).
- Money: Run writes no usage record and holds no Billing token.

## Depends on

- PostgreSQL 18: `run_jobs` and the `run_events_outbox`; `migrations/` applies on boot.
- Valkey (`VALKEY_URL`, optional): shared state between processes; unset, nothing is shared.
- OpenVibe.Network: the RS256 signing key (JWKS) every token is verified against; the offers Run places from
  (`GET /api/v1/offers`, public); Run's client `run` mints the events relay's service token and its Bot token.
- OpenVibe.Events: `run.job.*` events go to `events.event.publish`; unset, they wait in `run_events_outbox`.
- OpenVibe.Bot (`RUN_BOT_URL`, `RUN_POLL_MS`): the node link and the meter. Run sends each job to it
  (`bot.job.dispatch`, audience `openvibe.bot`, minted from `OV_OAUTH_CLIENT_ID`/`OV_OAUTH_CLIENT_SECRET` against
  `OV_NETWORK_INTERNAL_URL` and cached until 60 s before expiry) and mirrors its answer. Unset the client secret and
  the bridge is off: `/api/ready` skips the `bot` check and every job stays `queued`.
- `openvibe-contracts` v0.106.0, `openvibe-sdk` v0.35.0 and `openvibe-shared` v2.20.3 (package.json).

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
| `GET /api/v1/jobs/:id/stream?ticket=` | `run.job.stream` | a ticket in the query, **or** a Bearer service token with the grant → `text/event-stream` of `run.job-stream-event@1` |
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
- **States.** `queued → placed → running → succeeded | failed | cancelled | expired`. Run stores `queued` and, once
  the job is on a node, records `placed` itself; `running` and the end states arrive from Bot. An end state never
  changes, so a replay of a cancel is a no-op rather than a second event.
- **Events.** `run.job.queued|started|succeeded|failed|cancelled|expired`, payloads being the
  `run.job-read-result@1` projection their contracts describe. The outbox row is keyed `run:<job id>:<state>` (one
  row per job and state, so a replay is one row); the published envelope carries a contract-valid `evt_<ULID>`
  document id, because `events.event-envelope@1` pins that pattern and OpenVibe.Events validates it on publish.
- **Stream.** `POST /jobs/:id/stream/ticket` mints a two-minute single-use RS256 ticket for that one job (audience
  `openvibe.run`, `typ run-stream`, its own key — never Network's signing key, so it is never a session anywhere).
  `GET /jobs/:id/stream?ticket=…` replays what is kept (the last 1 MiB) and follows; a service that can send a header
  opens the same stream with a Bearer token holding `run.job.stream` for the job's project (the manifest allows
  both). `Last-Event-ID` resumes after the last `seq` seen; an ended job replays what is kept and closes with
  `type: 'end'`. Reconnecting never re-runs a job. The `output` events are the node's `job_stdout` chunks as Bot
  holds them (best effort: a chunk lost with the node's link is never resent, and a gap Bot dropped is dropped here
  rather than streamed twice). The ring is this process's memory (reclaimed once it ended or went idle, and rebuilt from the job's row when
  a stream opens again), so `seq` is this process's counter: a resume across a restart gets the current state rather
  than a gap, and output is best effort either way.
- **The `job` record.** `run_jobs.job` holds the `platform.job@1` body Run will send (id, class, artifact, args,
  ttl_ms, limits, net, inputs) plus the fields `platform.job@1` has no place for and `0001_jobs.sql` has no column
  for: `requirements` (required by `run.job-read-result@1` and by placement), `placed_at` (`timings.placed_at`) and
  `cancel_requested` (a cancel of a placed or running job). `store.frameOf(record)` builds the frame body from the
  `platform.job@1` keys alone, and the dispatcher bridge validates it before anything is sent.
- **Cancelling.** A **queued** job was never sent anywhere: cancelled at once (`exit` stays null, usage stays 0). A
  **placed or running** job may be on a node this instant, so it is marked `cancel_requested`, Bot is asked for its
  `job_cancel` (once per job — Bot repeats it on every reconnect until the job ends — and the poller retries the
  request until it lands), and the job reaches `cancelled` when Bot says so. Run never answers `cancelled` for work a
  node may still be doing. Cancelling an ended job answers it as it is.
- **Usage.** `usage.wall_ms` and `usage.seconds` are Bot's metered wall clock (Bot writes the
  `run:<job id>:<n>` readings; Run holds no Billing token and never posts one). A running job therefore shows 0
  until its `job_exit` carries the wall clock: Run does not estimate a number it cannot back.
- **Placement.** The node is chosen per tick from the offers Network publishes
  (`GET {OV_NETWORK_URL}/api/v1/offers?kind=node`) by `openvibe-sdk/placement` `plan()`, on the job's own
  `requirements`; `node_id`, `provider` and `region` are recorded on Run's row. A class no node offers keeps the job
  queued until an offer appears or its `ttl_ms` ends it `expired` with `run.job.unplaceable`. Offers are cached for `RUN_OFFERS_TTL_MS`; a Network that does not answer
  is retried, never a reason to fail a job.

## Tests

```
npm test              # every file in test/, PGlite (in-process PostgreSQL)
npm run test:pg       # the same on the production-shaped containers (openvibe-sdk scripts/test-services.sh up)
node test/jobs.test.js      # the job API against the released contracts
node test/dispatch.test.js  # the dispatcher bridge: offers → placement → Bot → mirror → stream, cancel, ttl
node test/app.test.js       # the skeleton: health, readiness, release.json, /metrics, the bridge's off state
```

`test/helpers/app.js` boots Run against an in-process OpenVibe.Network stub (its JWKS, its tokens, the token
endpoint Run mints from and the offers registry), so nothing needs the network, OpenVibe.Bot or a running service.
`test/dispatch.test.js` runs a fake OpenVibe.Bot as a real HTTP server that verifies the Network service token Run
mints for it (audience `openvibe.bot`, capability `bot.job.dispatch`), so the bridge is exercised over the wire
rather than through a fetch stub.

## Security

- Every route checks one capability; the project and the requester come from the token, never the body.
- Another project's job is `404 run.job_not_found`, never `403`: an id's existence is never confirmed.
- The stream route accepts a valid, unexpired, unused ticket for that job, or a Bearer service token holding
  `run.job.stream` for the job's project — a token in the query string is refused like any other non-ticket.
- Bot is a trusted peer but never an authority: its answer cannot rename the node or the project of a job Run
  placed, cannot move a job's state backwards, and cannot make Run carry out work the caller did not ask for. Run's
  own row, its offers and the job's requirements decide.
- Run's Bot token is minted from OV_OAUTH_CLIENT_ID/SECRET, cached until 60 s before expiry, never logged and never
  put in an error; the job body is validated against `platform.job@1` before it is sent.
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

<!-- versions:start -->
- openvibe-contracts: v0.126.0
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.20.3
<!-- versions:end -->
