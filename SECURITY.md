# Security policy

OpenVibe is run in the open, and we want to hear about security problems before anyone else does.

## Reporting a vulnerability

Email **contact@openvibe.network** with "security" in the subject. Please include what you found, where (URL,
repository, file), how to reproduce it, and what an attacker could do with it. Do not open a public GitHub issue for
a vulnerability, and do not test against other people's accounts, projects, jobs or data.

We reply within 7 days, keep you updated while we fix it, and credit you when the fix ships if you would like.

## Scope

Every OpenVibe service and site (openvibe.run, openvibe.live, openvibe.network, openvibe.tools, openvibe.media,
openvibe.bot and the other openvibe.* domains) and every repository under github.com/OpenVibers. Machine-readable
contact details are at `/.well-known/security.txt` on each site.

## This service

OpenVibe.Run executes other people's work and its usage is billed, so a defect here is money and execution. What
Run guarantees, and what a report should assume:

- every route checks exactly one capability from the caller's Network service token (audience `openvibe.run`), and
  a job's project and requester come from that token — never from a request body or a query string;
- another project's job is always `404` (`run.job_not_found`), never `403`: Run never confirms that an id exists;
- request bodies and query strings are validated against the released `openvibe-contracts` schemas, and so is every
  answer before it is sent;
- `GET /api/v1/jobs/:id/stream` accepts only a two-minute, single-use ticket that Run itself signed for that one job
  (audience `openvibe.run`, `typ run-stream`) — never a service token in a query string;
- no secret is logged: not the `Authorization` header, not a stream ticket, not a job's stdout;
- nothing starts at module load (timers, relays and listeners start in `server/index.js` `main()`).

## Supported versions

Only the current `main` branch, which is what runs in production, receives fixes.
