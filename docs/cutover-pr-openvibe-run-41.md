# Cutover runbook — PR #41 (OpenVibe.Run llms.txt, llms-full.txt and IndexNow)

PR #41 (plan T11 step 4) serves `/llms.txt` and `/llms-full.txt` and, only when `INDEXNOW_KEY` is set, serves the
IndexNow key file at `GET /<key>.txt` and pings the public pages once per boot. **There is no data change:** the PR
adds no migration (`migrations/` still ends at `0003_usage_outbox.sql`), no table, column, index or row, and no
`Contracts`, capability or token change. The cutover is a code and environment change; the database is only
backed up and checked as the standing guard of any Run deploy.

## What changes

- `server/web/discovery.js` (new): the two `llms` documents, built from the public pages only (never the API,
  admin routes, a job or a stream), and the one-time IndexNow notifier.
- `server/app.js`: routes `/llms.txt` and `/llms-full.txt` (`Cache-Control: public, max-age=3600`); the IndexNow
  key route is mounted only when a key is set. A malformed key (not 8–128 letters and digits) turns IndexNow off
  with a warning and does not stop the service.
- `server/config.js`, `server/index.js`, `.env.example`: `INDEXNOW_KEY`, unset by default; the ping runs once after
  the server is listening and never throws.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook named in the PR description and
   `ds/deploy/rehearsals/openvibe-run-41.json` saying `{"ok": true}`. Only then does the squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Run's PostgreSQL database (pgBackRest) and confirm with
   `pgbackrest info` that the latest restore point is newer than the deploy start.
3. **Deploy.** Run deploys through its own pipeline (`ov deploy run "llms.txt and IndexNow (PR #41)"` queues the
   guarded deploy on `openvibe-ovh`; unit `openvibe-run.service`, layout `/opt/openvibe.run`, port 4920). The boot
   finds nothing new to migrate and serves. A failed readiness check rolls the release back automatically.
4. **Leave IndexNow off until verified.** `INDEXNOW_KEY` is added to `/etc/openvibe/run.env` only after step 5
   passes with it unset (check names with `ov access run openvibe-ovh env-names`). Setting it is a separate,
   later change followed by a restart; the key is 8–128 letters and digits, and is not secret (it is published
   at `/<key>.txt`).
5. **Verify** (below).

## The backup

- Command: the standard pgBackRest backup of the Run database (the one every Run deploy takes), then
  `pgbackrest info`.
- Nothing in this PR touches the database, so nothing needs restoring for it; the backup is the unconditional
  guard that lets a deploy start, and the way back for any other commit shipped in the same release.

## Rehearsal

`ov rehearse OpenVibe.Run 41` builds the base from main's migrations, loads the repository's fixtures, applies
this PR's migrations (none) and then runs the block below on the scratch database: the migration ledger is
exactly `0001`, `0002`, `0003` (the PR added none), the Run tables exist, and the fixture rows in `run_jobs` are
unchanged by a read-only count.

```rehearse
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const ids=(await db.prepare("SELECT id FROM ov_migrations ORDER BY id").all()).map((r)=>String(r.id));a.deepStrictEqual(ids,["0001","0002","0003"]);const t=(await db.prepare("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = current_schema()").all()).map((r)=>r.n);for(const n of ["run_jobs","run_events_outbox","run_usage_outbox"])a.ok(t.includes(n),n);const jobs=Number((await db.prepare("SELECT COUNT(*) AS n FROM run_jobs").get()).n);console.log("PR 41: no migration added (ledger 0001-0003), Run tables present, run_jobs "+jobs+" rows")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

## How the result is verified

On production, with `INDEXNOW_KEY` still unset:

- `ov access run openvibe-ovh health` and `GET /api/ready` are 200; `ov access run openvibe-ovh journal
  openvibe-run.service 200` shows a clean boot, no `applied 00..` line for a new migration and no error.
- `curl -si https://openvibe.run/llms.txt` and `/llms-full.txt` answer 200 `text/plain` and list only the front
  page, `/terms`, `/privacy`, `/dmca` and the repository links — no `/api/`, `/internal/` or job path.
- `robots.txt` and `sitemap.xml` are unchanged; `/` and the legal pages still answer 200.
- `SELECT state, COUNT(*) FROM run_jobs GROUP BY state` is unchanged from before the deploy; queued jobs still
  place and mirror, and `run_events_outbox` keeps draining.

After step 4 sets `INDEXNOW_KEY`: `GET /<key>.txt` answers 200 with the key as its body, a wrong key path is 404,
and the journal shows no `[IndexNow]` warning (a `Run] IndexNow disabled` line means the key was malformed).

## The way back

- **Code (the usual case).** `ov access run openvibe-ovh releases` to find the previous release, then roll back
  through the pipeline's guarded rollback. The routes simply disappear (`/llms.txt` becomes 404); no data is
  involved, so there is nothing to undo in PostgreSQL.
- **Environment.** To turn IndexNow off without a rollback, remove `INDEXNOW_KEY` from `/etc/openvibe/run.env` and
  restart `openvibe-run.service`; the key route is 404 again and nothing is sent. A ping already sent cannot be
  recalled, and it only listed public URLs.
- **Restore.** Not needed for this change. The step 2 backup is the last resort for something else in the same
  release, restored only with the owner's approval because it also discards every job written since.
