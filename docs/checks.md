# GitHub checks on shared nodes

The checks scheduler (`server/checks/`, research-2026-11-13/shared-node-checks.md piece 2) plans a repository's
GitHub Actions workflow jobs and runs each one as an ordinary Run job on a node, then reports a GitHub check run.
It is **shadow first**: `openvibe / …` check runs are not required, and the Actions conclusion of the same
workflow job is stored beside the node one for the agreement figure.

## Setup (owner)

1. Generate one 32-byte `RUN_SECRETS_KEY`, base64 (standard or URL-safe) or 64 hex characters, and put it in
   `/etc/openvibe/run.env`. It seals the App's private key, webhook secret, client secret and installation tokens.
2. Set `RUN_CHECKS_PROJECT` to the project check jobs belong to (`prj_…`). A check job is a normal Run job and needs
   a project for its `run_job.project_id` and its `run.job.*` events; without it nothing is planned.
3. Sign in as the network owner and open `/admin/checks`. Press **Create the GitHub App**: the browser posts the
   manifest to `https://github.com/organizations/OpenVibers/settings/apps/new` and GitHub redirects back to
   `/admin/checks/created`, where Run exchanges the code and stores the App encrypted.
4. Press **Install … on OpenVibers** and choose the organization/repositories.

Owner = `RUN_CHECKS_OWNER` (a `usr_…` subject) or `OWNER_USERNAME` (default `goosely`), the same owner name
Network's owner guard uses.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /admin/checks` | owner session | App state (`none`, `created`, installed accounts), the manifest button and the install link |
| `GET /admin/checks/created` | owner session + state | exchanges the manifest code, seals the App |
| `POST /webhooks/github` | GitHub signature | HMAC-SHA256 raw body, delivery dedupe for seven days |
| `GET /api/v1/checks/agreement?repo=` | owner session | paired checks, agreement, average queue/run ms per repo |

Only `push` to the default branch and `pull_request` `opened`/`synchronize`/`reopened` plan checks, and only for
repositories/installations under `RUN_CHECKS_OWNERS` (default `OpenVibers`). A pull request whose head repository is
outside the allow-list is ignored (a fork's workflow is never run). `workflow_job.completed` records the Actions
conclusion; every other delivery is answered `204`.

## What is planned

The workflows under `.github/workflows` at the event's SHA are read with an installation token (cached until five
minutes before it expires). A workflow is kept when its `on` names the event and its `branches`/`branches-ignore`
filter matches. Jobs are flattened:

- `needs` become stages: stage 0 is queued at planning, a later stage only when every need succeeded; a failed or
  skipped need skips the job (and its check run says `skipped`).
- `strategy.matrix` expands with GitHub's `include`/`exclude` order; `max-parallel` limits the concurrently queued
  combinations of one matrix.
- A reusable workflow (`uses: owner/repo/.github/workflows/x.yml@ref`, or local `./…`) is read at its ref and
  expanded as a sub-play; its jobs carry the caller's needs and their check names are prefixed with the caller.
- `if:` is not evaluated: an expression the planner cannot read runs the job.

Each planned job becomes one Run job:

```
class: code, artifact: openvibe-codes@1.0.0,
args: { kind: 'check', repo: <clone URL>, sha, workflow, job, matrix?, event, ref, timeout_ms },
requirements: { kind: 'run.code', mobility: 'job', latency_class: 'background',
                objective: 'balanced', trust: ['first-party', 'user-owned'] },
egress: public, limits: { wall_ms, cpu_ms, mem_bytes: 4 GiB },
ttl_ms: min(wall_ms + 10 min, 24 h),
timeout: the job's timeout-minutes, default 30
```

A node that goes away mid-job (Run ends failed/expired/cancelled with no result) is retried once on another node;
the second end settles the check run. A check that produces a conclusion is never retried.

## Check runs and the shadow

One GitHub check run per planned job, named `openvibe / <the job's Actions name>` (matrix values in parentheses),
is created `queued` at planning, moves to `in_progress` when the Run job starts, and completes with the node's
conclusion and a summary of its steps. `details_url` is Run's job API URL (`/api/v1/jobs/<id>`): Run has no HTML
job page today.

Every completion upserts `run_checks_shadow` keyed by repo, SHA and job name, and `workflow_job` writes the Actions
conclusion into the same row. `GET /api/v1/checks/agreement` aggregates the paired rows.

## Safety

- The App key, webhook secret, client secret and every installation token are AES-256-GCM sealed under
  `RUN_SECRETS_KEY` (AAD per App field / installation id) before they reach a row. They are never logged, never in
  a response and never in a node input.
- A webhook is accepted only with a valid `X-Hub-Signature-256` (constant-time), a fresh `X-GitHub-Delivery`, and
  a repository and installation account on the allow-list.
- Steps get no secrets from Run; the node clones the repo with its own credential and `GITHUB_TOKEN` is never
  passed to the steps. The job's egress is public.
- Nothing starts at module load. The tick starts from `server/index.js` only with `RUN_JOBS` on; `RUN_JOBS=off`
  (drills/tests) makes the webhook record a delivery without reading a workflow or calling GitHub.
