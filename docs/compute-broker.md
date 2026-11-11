# Computer pools and compute broker

Run owns scheduling, session leases, autoscaling and rental accounting. Computer is the front door;
Exchange shows GPU quotes; AI retains GPU inference runtimes and its nano-USD ledger.

## Existing machines and strategies

Set `RUN_COMPUTE_POOLS` to a JSON object keyed by pool name, and `RUN_COMPUTE_INVENTORY` to an
operator-controlled JSON object keyed by Bot machine id. These are non-secret configuration.
For example, a browser pool has `kind: "browser"`, `strategy: "automatic"`, `currency: "EUR"`,
`min_warm: 1`, `max_machines: 3`, `slots_per_machine: 8`, `target_wait_ms: 30000`,
`idle_grace_ms: 600000`, `max_hourly: 0.10`, `providers: ["hetzner", "ovh"]`.
A machine entry has `pool`, `tier` (`home`, `dedicated`, `community`, `partner`), `ram_mb`,
`measured_peak_ram_mb`, `region`, `hourly`, `currency`, optionally measured `latency_ms`,
`queue_ms`, `gpu_mb`, and `egress: "ovh-tunnel"`. Own-machine identity always comes from Bot.
Public offers cannot claim an OpenVibe trust tier. Missing RAM/price means ineligible, not free.

`POST /api/v1/sessions?pool=browser&strategy=cheapest` keeps the released request contract.
Strategies are `automatic`, `cheapest`, `fastest`, `private`, `own`; the request overrides the
pool default. The pool and strategy are part of idempotency and persist on the session.
`GET /api/v1/sessions/:id?explain=1` adds the recorded decision, tier, price and reasons for its
owner. Normal reads remain contract-compatible. Fastest uses measured latency; an unmeasured
host has no advantage. Region and privacy constraints never relax to satisfy a queue.

Automatic walks own → home → dedicated → community → partner, rejecting health, capacity,
queue-wait and price failures first. New rentals are ranked with their configured disk/network
allowance; unavailable keys or exhausted provider caps do not hide eligible alternatives.
Home public egress requires an OVH tunnel. RAM packing
uses at least 300 MB/browser and 2048 MB/desktop, subtracts 1 GB for the system, and respects
Bot's slot ceiling. Configure measured peaks from load tests; these defaults are not measurements.

For jobs, `RUN_COMPUTE_JOB_POOL` applies the pool policy to Fabric offers after the existing
SDK planner's hard checks. Inventory `free_ram_mb` and `free_slots` cover offers whose public
projection omits capacity. Job `requirements.objective` selects cheapest, lowest-latency or
private; an explicit `node` remains pinned. Draining rentals reject both sessions and jobs.
The dispatch result retains placement reasons and estimated hourly cost.

## Rental switches: all default off

- `RUN_COMPUTE_ENABLED=1` enables pool reconciliation; `RUN_COMPUTE_DRY_RUN=0` permits provision.
  Dry run defaults on. Cleanup of already-created rentals continues when either switch is disabled.
- `RUN_COMPUTE_OWNER` is the Network subject whose Bot host list the operator manages.
- `RUN_COMPUTE_OPERATORS` is a comma-separated allowlist of Network user subject ids.
- For each provider prefix `RUN_COMPUTE_HETZNER_`, `RUN_COMPUTE_OVH_`, `RUN_COMPUTE_VAST_`,
  `RUN_COMPUTE_RUNPOD_`, set `KEY`, `MONTHLY_CAP`, `CURRENCY`, and `IMAGE`. Cap is a decimal
  amount in that currency, default `0`. Image must be a prepared, isolated Link worker image.
  Never put credentials in the inventory, pool JSON or image. Enrollment is an operator step.
- Also set `EXTRA_HOURLY` to a conservative bound for disk/egress and `COSTS_BOUNDED=1` only
  after enforcing that bound in the worker/network. Without both, live provisioning is refused.
  Public catalogue prices alone do not bound bandwidth or persistent-volume charges.
- OVH additionally needs `PROJECT`, `APPLICATION_SECRET`, and `CONSUMER_KEY`; `KEY` is the
  application key. This adapter uses EU API/IE catalogue, EUR including catalogue tax. Hetzner
  Cloud quotes EUR including tax and provisions IPv6 only. Vast and RunPod quote USD.
  Do not mix currencies or guess an exchange rate.
- GPU inference should use AI's existing `ai.gpus` settings and ledger. Leave Run's Vast and
  RunPod caps at zero unless intentionally operating a separate worker pool with a separate budget.

No-key quotes: auction, OVH public catalogue, Vast, RunPod, and community offer reads, subject to
upstream availability. Hetzner Cloud needs a token; OVH needs credentials to resolve live project
flavors. Auction purchase is quote-only pending cancellation/liability implementation. Community
inference offers are not hourly machine rentals; use AI's existing routing or an existing Bot desk.

The broker reserves a bounded runtime (at most one hour) plus a deletion allowance before calling
a provider. Integer micro-currency arithmetic and database locks serialize cap checks. Unknown
creation outcomes block new rentals and retain their reservation across restarts and months.
A pending release also blocks new purchases from that provider until deletion is confirmed.
Every provision, release, drain and strategy change is journalled. Deletion must be confirmed by
provider health before releasing the reservation; a refused deletion continues to accrue cost and
can exceed a reservation. The journal flags this. No software can guarantee an upstream provider
will honor deletion while unavailable; the operator must handle failed releases promptly.

## Operator view and lifecycle

`GET /api/v1/compute` shows pools, strategies, machines, sessions, current hourly cost, spend,
committed budget and cap; `?format=json` gives the same data. Only allowlisted signed-in operators
can read it. Strategy forms require same-origin writes. Quotes are at
`GET /api/v1/compute/pools/:pool/quotes`; they never spend.

A prepared worker that enrolls a fresh Link identity under `RUN_COMPUTE_OWNER` and reports the
provider-assigned rental label as its machine name is bound automatically. Bot must identify it
as that owner's own machine; community/shared name claims are never accepted. Its quote supplies
the pool and RAM inventory. The image's enrollment mechanism is an operator prerequisite.

For workers without this naming integration, put the machine id in trusted inventory and bind it
with `POST /api/v1/compute/rentals/:id/bind`, JSON `{ "machine": "dev_…" }`, as the operator with
an Origin matching Run. Automatic secure enrollment itself is not implemented here; do not bake reusable Link credentials into an image. Unbound rentals
count as starting capacity and are deleted at their deadline; never regarded as usable desktops.

Ordinary scale-down marks a host draining, excludes it from placement, waits for zero sessions,
then requests deletion. At the runtime/budget limit, Run ends sessions before release. Unknown
host observations never count as zero occupancy. Each rental's stop deadline survives restart.
Desktop sizing is available, but the current released Bot session API creates browser desks only;
full Linux desktop execution still needs the Computer/Link runtime work and security review.

Checks: `npm test -- compute sessions dispatch`; the full suite is `OV_ALLOW_SUITE=1 npm test`.
The SDK dependency is pinned to the reviewed job commit until its PR is merged and released;
replace that pin with the resulting SDK release before shipping. Do not deploy this PR before
Opus reviews money, worker enrollment, privacy and cancellation behavior.

## Owner-managed sandboxes (ask 356)

Network `/admin#ai` → platform settings → **OpenVibe.Run** exposes `run.compute` and
`run.compute_baseten`, `run.compute_daytona`, `run.compute_e2b`, `run.compute_fly`.
Only Network's owner-ranked admin proxy can use `run.config.manage`. Keys are write-only,
sealed by shared/config; Run refuses a secret PUT without `OV_CONFIG_KEKS`. The owner supplies
keys later; this release supplies none. Changing settings activates them without restart.

Start with `run.compute.enabled=false`, `dry_run=true`. Add a pool with `kind`, `providers`,
`strategy: "cheapest"`, `currency: "USD"`, a region, `max_machines`, `max_runtime_ms` and
`slots_per_machine`. Set `owner` to the subject owning the enrolled machines. Set `job_pool`
for queued agent jobs using their actual runtime class (`code`, `linux`, or `function`); set measured RAM per worker for that image. Browser sessions select the pool through their existing request query.
The four providers each default off, zero concurrency, zero cap and no allowed kinds.

For each provider set `price_id` from https://openvibe.exchange/compute, matching `region`,
prepared `image` (E2B template / Daytona snapshot), key, `allowed_kinds`, `max_concurrent`,
positive USD `monthly_cap`, bounded `extra_hourly`, and `costs_bounded`. Fly additionally needs
an existing app in `project`; Baseten can use `project` to select its team. Images/templates
must have exactly the selected quote's resource shape and enroll fresh identities through the
existing Link/worker path; E2B uses `provider-default` as its region marker because this API has no region selector; it cannot satisfy a named-region purchase. Its template CPU/RAM are checked against the quote before creation. The adapter does not create
accounts, apps, templates or reusable enrollment credentials. Keep `min_warm: 0` unless warm
capacity is intentional. The global enabled/dry switches must also be changed for provisioning.

The Exchange catalogue supplies dated public tariffs; its explicit expiry is enforced, and an
unavailable catalogue yields no new purchases. CPU adapters reject GPU requests; existing
RunPod/Vast and AI GPU routing remain the GPU path. Baseten/Daytona/E2B send native lifetime
limits; Fly relies on Run's durable deadline and delete reconciliation. A stopped resource is
not treated as deleted. Do not revoke a key while rentals still need cleanup.

Set `credit_amount` to a confirmed one-time grant and `credit_expires` to its actual UTC expiry.
Recorded charges and outstanding reservations reduce that grant across months; credits only
change ranking, never the gross hard cap. Untracked external use of the same grant is not
observable: use a dedicated account/budget, or set the credit to zero. A promotional free rate
requires both the owner expiry and Exchange's advertised expiry to cover the full reservation;
otherwise the ordinary price wins. At `promotion_expires`, rentals drain and no new ones start.
At 80% of committed cap, Run writes `budget.near_cap` and displays an alert in `/api/v1/compute`.
Network also shows these figures and warnings in the owner-only Worker compute budgets section of `/admin#ai`, through `/api/admin/ai/config/compute/status`. The Run view admits the configured machine owner as well as existing operators. Unknown provider
outcomes keep reservations, block retries and remain visible for operator resolution.
