# AGENTS.md — OpenVibe.Run

## Project Overview

OpenVibe.Run is the network's job service (plan T14, ADR-034): it accepts jobs, places each on a node advertising
the runtime class it needs, follows it to its end and streams its output. It also places **sessions** — browser desks
one person owns and OpenVibe.Bot leases — and it carries the operator's compute-pool view. A job belongs to a
**project**, is billed per wall-clock second it runs, and is visible only to the token that project presents.

- **Site:** `openvibe.run` · **Port:** 4920 · **Service id:** `run` · **Env prefix:** `RUN`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [docs/compute-broker.md](docs/compute-broker.md),
  [.env.example](.env.example).

**Network context:** identity, tokens, projects/offers and project membership checks are OpenVibe.Network. OpenVibe.Bot
owns the node link, sends jobs to nodes and meters their wall-clock seconds into `platform.usage-sample@1`; Run never
posts those readings. Run mints the job id (`job_<ULID>`, passed to Bot as `platform.job@1`, so metering keys are
`run:<id>:<n>`) and per-second usage for the external managed-browser provider only (Billing
`billing.usage.record`, clamped). Events are OpenVibe.Events. Media owns job artifacts and inputs; Run never fetches a
caller-chosen URL.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # http://localhost:4920, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite with mocks, no network
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- sessions           # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step. Run serves mostly machine routes; the public home in [server/web/home.js](server/web/home.js) and
[server/web/discovery.js](server/web/discovery.js) exists and is tested, but `openvibe.run` is parked (302 to
openvibe.network) until Run has a product surface — the vhost is installed then.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — migrations with the owner role and an advisory lock, then the
  listener on the pooled role; starts the key refresher, stream key, events outbox relay and dispatcher poller, and
  stops them in order. `RUN_JOBS=off` disables the background work. Nothing starts at module load.
- **App factory:** [server/app.js](server/app.js) — helmet/CSP, `/api/v1`, the compute operator routes, `/api/health`,
  `/api/ready`, `/release.json`, `/metrics` (direct loopback only), the public home/discovery, 404/error handler.
- **Config:** [server/config.js](server/config.js) — `loadConfig(env)` is pure; production `/etc/openvibe/run.env`.
- **Job API:** [server/api/v1.js](server/api/v1.js), auth/capability resolution [server/api/auth.js](server/api/auth.js),
  job store [server/jobs/store.js](server/jobs/store.js), events [server/jobs/events.js](server/jobs/events.js),
  stream ring/tickets [server/jobs/stream.js](server/jobs/stream.js), [server/jobs/ticket.js](server/jobs/ticket.js),
  usage [server/jobs/usage.js](server/jobs/usage.js), poller [server/jobs/poller.js](server/jobs/poller.js).
- **Placement/dispatch:** [server/dispatch/](server/dispatch/) — `placement.js` states requirements and calls
  `openvibe-sdk/placement plan()` (Run has no placer of its own, ADR-036), `bot.js` sends/mirrors via
  `bot.job.dispatch`, `browser-provider.js`, `outcomes.js`, `priors.js`.
- **Sessions:** [server/sessions/](server/sessions/) — `service.js`, `store.js`, `desks.js`, `curtain.js`, `profiles.js`,
  `origins.js`, `link-egress.js`; routes [server/api/sessions.js](server/api/sessions.js). A session is a person's own
  desk placed by Run and leased by Bot (`bot.desk.session`), metered once a minute.
- **Compute broker:** [server/compute/](server/compute/) — `broker.js`, `config.js`, `settings.js`,
  `sandbox-providers.js`, routes [server/compute/routes.js](server/compute/routes.js); rentals default to quote-only,
  capped per provider, and a provider API key stays in Run's environment only.
- **Events outbox:** [server/events/outbox.js](server/events/outbox.js), [server/jobs/events.js](server/jobs/events.js);
  account data [server/account-data.js](server/account-data.js).
- **Network client:** [server/network.js](server/network.js) — offers and project-membership checks.
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `run_jobs`, `run_events_outbox`,
  `run_usage_outbox`, `run_sessions`, `run_session_actions`, `run_session_control_guests`,
  `run_session_fill_requests`, `run_actor_profiles`, compute pools/rentals/journal/charges/credits/outcomes,
  `config_keys`, `config_snapshots`, `account_data_events`, `telemetry_samples`.
- **Deploy:** [deploy/systemd/openvibe-run.service](deploy/systemd/openvibe-run.service) (`/etc/openvibe/run.env`,
  `/opt/openvibe.run`, release layout, database `ov_run`) and [deploy/nginx/openvibe.run.conf](deploy/nginx/openvibe.run.conf)
  (TLS, www→apex, rate limits, client IP from `$remote_addr` only, `/internal/` and `/metrics` never proxied).
  `sudo ovhost deploy run`.

## Ownership and Boundaries

Run owns the job lifecycle record and state/timings, project scope and delegation, idempotency, the job stream and its
tickets, requirements/project caps, placement choice, sessions/desks records and control actions, the compute broker's
pools/rentals/journal, the events/usage outboxes and the public home copy. It does **not** own the node link, device
credentials or per-second metering of Bot-carried jobs (Bot), identity/tokens/projects (Network), artifacts/media
(Media), the money ledger (Billing), or event delivery (Events). Run never estimates a usage number it cannot back.

## Auth and Capabilities

One capability per route, from the caller's Network service token; a Network **user** token names no project and holds
no capability here. `run.job.admin` is internal: only a first-party `svc:` token may hold it. Run verifies only tokens
its audience names. Delegation (ADR-003 amendment): a first-party service with `X-OV-Subject` may name `X-OV-Project`;
Run asks Network (`network.project.member.read`, cached 60 s) whether the person is admin/owner of the unarchived
project, records the service as `via`, and limits the service to the jobs it started for that person. Another
project's job is **404, never 403**; undelegated list/Bearer-stream is 403 `project.not_delegated`; Network
unreachable is 503 `project.check_unavailable`.

Capabilities (STATUS.json): `run.job.submit|read|list|cancel|stream|admin`; `run.session.create|read|control`.
Outbound: `bot.job.dispatch`/`bot.desk.session` (Bot), `network.project.member.read`/`network.registry.read`,
`events.event.publish`, `billing.usage.record` (external-browser jobs only). Contract validation is applied to every
request and every answer; errors are RFC 9457 problem+json.

## API

Jobs: `POST /api/v1/jobs` (201/200 idempotent), `GET /jobs/:id`, `GET /jobs`, `POST /jobs/:id/cancel`,
`POST /jobs/:id/stream/ticket`, `GET /jobs/:id/stream?ticket=…` (SSE; Bearer with `run.job.stream` also allowed),
`GET /admin/jobs`. Sessions: `POST /api/v1/sessions`, `GET /sessions`, `GET /sessions/:id`,
`POST /sessions/:id/commands`, `POST /sessions/:id/end`. Compute (operator, signed-in user in
`RUN_COMPUTE_OPERATORS`/owner, same-origin writes): `/api/v1/compute`, `/compute/pools/:pool/quotes`,
`POST /compute/pools/:pool/strategy`, `POST /compute/rentals/:id/bind`. Machine: `/api/health`, `/api/ready`,
`/release.json`, `/metrics` (direct loopback only).

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Keep `run_` prefixes.
- Every request and answer goes through the released contract (`run.job-*@1`, `run.session*@1`,
  `platform.job@1`); an unknown field in a contract that forbids extras is a 400, never dropped silently.
- **Idempotency is permanent:** one row per `(project_id, idempotency_key)`; a repeat answers the first job, the same
  key with different work is 409 forever (the contract's 24 h is a floor, not an expiry). A missing key is minted
  `auto:<ulid>` and returned.
- **States** are `queued → placed → running → succeeded|failed|cancelled|expired`; an end state never changes. A queued
  cancel is immediate; a placed/running cancel marks `cancel_requested`, asks Bot once per job and reaches `cancelled`
  only when Bot says so. Run never answers `cancelled` for work a node may still be doing.
- The stream ticket is a two-minute single-use RS256 token with audience `openvibe.run` and its own key — never
  Network's signing key. `Last-Event-ID` resumes after a `seq`; output is best effort (a chunk lost with the node's
  link is not resent).
- Sessions: `ttl_s` (3600 default), `idle_s` (900), a lease check every `RUN_SESSION_LEASE_CHECK_MS` (30 s), at most
  `RUN_SESSIONS_PER_PERSON` (3); a dropped lease ends `host_lost`; no host waits `placing` then `unplaceable`.
- CSP: add origins to `helmet` in [server/app.js](server/app.js). Phone first for the home/compute pages; no Font
  Awesome.
- Never log a token, a stream ticket, a provider key or a person's args. "Calm reduces, only Off removes": a filter
  hides, only `end`/`cancel`/`delete` removes.

## Key Pitfalls

- **Project scope comes from the token**, never a request body: `project_id`/`requester` are `claims.project_id`/
  `claims.sub`. A user token cannot act here without a service grant.
- **A job's args are limited** (512 KiB → 413 `run.args_too_large`), and `limits` are capped by the project's with
  422 `run.limits.exceeded`. `ttl_ms` defaults to `limits.wall_ms + 600000`.
- **No node offer:** keep the job queued until an offer appears or `ttl_ms` expires it (`run.job.unplaceable`); a
  Network that does not answer is a retry, never a job failure. A user-owned offer is eligible only for that person's
  own job naming `user-owned`, read from Network's internal `trust=user-owned` list — never from the public list.
- **Metering:** Bot's wall clock is the only usage for Bot-carried jobs; a running job shows 0 until `job_exit`. The
  browser provider's claim is clamped to Run's observed duration + 5 s. Never invent a number.
- **Sessions are person-owned:** a session may be created only for the caller (or a first-party `svc:` naming them in
  `X-OV-Subject`); control commands are limited to screen/input/browser and must respect the curtain.
- **Compute rentals default to quote-only.** No key, cap or provider is inferred from credentials; a provider key never
  enters an offer, a job, a log or a public page.
- **Events:** the outbox row is keyed `run:<job id>:<state>` (one per job/state); the envelope carries a contract-valid
  `evt_<ULID>`. A replay is one row.
- **Account data** arrives at `/internal/events` (loopback, signature-verified, idempotent).

## Testing

`npm test` runs each file in its own process on temp PGlite with mocked Network/Bot/provider: jobs/API/placement/
dispatch/delegation, sessions and control, compute/pools/policy/scale/settings, account data, agent steps, site/
discovery, SSO, telemetry, link egress and security. `npm run test:pg` for PostgreSQL. Run the narrowest file first,
then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, how a job runs, owns/does-not-own, dependencies, capabilities/routes, sessions,
  jobs, tests, security, deploy, deploy files.
- [docs/compute-broker.md](docs/compute-broker.md) — compute placement, pool autoscaling, rental caps, operator view.
- [docs/compute-providers-1111.md](docs/compute-providers-1111.md), [docs/link-egress.md](docs/link-egress.md),
  [docs/cutover-pr-openvibe-run-40.md](docs/cutover-pr-openvibe-run-40.md),
  [docs/cutover-pr-openvibe-run-41.md](docs/cutover-pr-openvibe-run-41.md).
- [STATUS.json](STATUS.json), [.env.example](.env.example), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
