# Cutover runbook — PR #40 (OpenVibe.Run usage outbox for the managed-browser provider)

PR #40 sends browser jobs to the external managed-browser provider and queues the wall clock Run meters
itself for them (plan T14 R4a; Bot meters every other job). **The only data change is
`migrations/0003_usage_outbox.sql`** (`phase: expand`): one new empty table, `run_usage_outbox`, and two
partial indexes. No existing table, column, index or row of `run_jobs` / `run_events_outbox` is touched, and
no `Contracts`, capability or token change comes with it.

## What the migration does

In one transaction, at boot, on the owner role (`DATABASE_DIRECT_URL`):

```sql
CREATE TABLE IF NOT EXISTS run_usage_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    envelope jsonb NOT NULL,
    traceparent text,
    created_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at bigint,
    seq bigint,
    rejected_at bigint,
    last_error text
);
CREATE INDEX IF NOT EXISTS run_usage_outbox_due  ON run_usage_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS run_usage_outbox_sent ON run_usage_outbox (sent_at) WHERE sent_at IS NOT NULL;
```

It takes no lock on an existing table. Rows are written only for jobs that went to the external provider, so
the table stays empty until `RUN_BROWSER_PROVIDER_URL` is set and a browser job ends. Readings are relayed to
OpenVibe.Billing only when `RUN_BILLING_URL` is set; unset, they wait in the table.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook named in the PR description and
   `ds/deploy/rehearsals/openvibe-run-40.json` saying `{"ok": true}`. Only then does the squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Run's PostgreSQL database (pgBackRest) and confirm with
   `pgbackrest info` that the latest restore point is newer than the deploy start.
3. **Deploy.** Run deploys through its own pipeline (`ov deploy run "usage outbox (PR #40) — migration 0003"`
   queues the guarded deploy on `openvibe-ovh`; unit `openvibe-run.service`, layout `/opt/openvibe.run`,
   port 4920). The boot applies `migrations/` once (`applied 0003_usage_outbox (expand, NNms)`) and then
   serves on the pooled `DATABASE_URL`. A failed readiness check rolls the release back automatically.
4. **Leave the provider off until verified.** `RUN_BROWSER_PROVIDER_URL`, `RUN_BROWSER_PROVIDER_API_KEY` and
   `RUN_BILLING_URL` are set in `/etc/openvibe/run.env` only after step 5 passes with them unset (check names
   with `ov access run openvibe-ovh env-names`). Setting them is a separate, later change.
5. **Verify** (next section).

## The backup

- Command: the standard pgBackRest backup of the Run database (the one every Run deploy takes), then
  `pgbackrest info`.
- The migration only adds an empty table, so nothing needs restoring for it; the backup is the unconditional
  guard that lets a deploy start, and the way back for any other commit shipped in the same release.

## Rehearsal

`ov rehearse OpenVibe.Run 40` builds the base from main's migrations (0001, 0002), loads the repository's
fixtures, applies 0003 and then runs the block below on the scratch database: the table has exactly the
outbox columns, both partial indexes exist, `event_id` is unique (the same `run:<job id>:<second>` key is
queued once), the defaults hold, and the table is left empty.

```rehearse
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const cols=(await db.prepare("SELECT column_name AS c FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position").all("run_usage_outbox")).map((r)=>r.c);a.deepStrictEqual(cols,["id","event_id","envelope","traceparent","created_at","attempts","next_attempt_at","sent_at","seq","rejected_at","last_error"]);const ix=(await db.prepare("SELECT indexname AS n FROM pg_indexes WHERE tablename = ?").all("run_usage_outbox")).map((r)=>r.n);for(const n of ["run_usage_outbox_due","run_usage_outbox_sent"])a.ok(ix.includes(n),n);const before=Number((await db.prepare("SELECT COUNT(*) AS n FROM run_jobs").get()).n);await db.prepare("INSERT INTO run_usage_outbox (event_id, envelope, created_at) VALUES (?, ?::jsonb, ?)").run("run:job_REHEARSAL:0","{}",1);const row=await db.prepare("SELECT attempts, next_attempt_at, sent_at FROM run_usage_outbox WHERE event_id = ?").get("run:job_REHEARSAL:0");a.strictEqual(Number(row.attempts),0);a.strictEqual(Number(row.next_attempt_at),0);a.strictEqual(row.sent_at,null);await a.rejects(db.prepare("INSERT INTO run_usage_outbox (event_id, envelope, created_at) VALUES (?, ?::jsonb, ?)").run("run:job_REHEARSAL:0","{}",1));await db.prepare("DELETE FROM run_usage_outbox WHERE event_id = ?").run("run:job_REHEARSAL:0");a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM run_usage_outbox").get()).n),0);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM run_jobs").get()).n),before);console.log("0003: run_usage_outbox has the outbox shape, both indexes, event_id unique, run_jobs untouched ("+before+" rows)")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

By hand on a restored snapshot (a scratch role, never production), after the boot has migrated:

```sql
SELECT id, name, phase FROM ov_migrations WHERE id = '0003';   -- 0003 | usage_outbox | expand
SELECT COUNT(*) FROM run_usage_outbox;                         -- 0
SELECT COUNT(*) FROM run_jobs;                                 -- the same count as before the deploy
```

## How the result is verified

On production, with the provider and billing variables still unset:

- `ov access run openvibe-ovh health` and `GET /api/ready` are 200; `ov access run openvibe-ovh journal
  openvibe-run.service 200` shows `applied 0003_usage_outbox` once and no migration error.
- `ov_migrations` has the `0003` row, `\d run_usage_outbox` lists the table and both indexes, and
  `SELECT COUNT(*) FROM run_usage_outbox` is 0.
- `SELECT state, COUNT(*) FROM run_jobs GROUP BY state` is unchanged from before the deploy; queued jobs still
  place and mirror, and `run_events_outbox` keeps draining.
- The boot log line says the usage relay is off because `RUN_BILLING_URL` is unset (nothing is lost: readings
  would wait in the table).

Once the provider is switched on (step 4): a browser job's readings appear as `run:<job id>:<n>` rows,
`event_id` is never duplicated, and with `RUN_BILLING_URL` set `sent_at` fills in and `rejected_at` stays NULL.

## The way back

- **Code only (the usual case).** `ov access run openvibe-ovh releases` to find the previous release, then roll
  back through the pipeline's guarded rollback. The previous release does not know `run_usage_outbox` and
  ignores it, so leaving the empty table in place is safe.
- **Remove the table (only while it holds no unsent reading).** After the code rollback, in one transaction:
  ```sql
  BEGIN;
  DROP TABLE run_usage_outbox;
  DELETE FROM ov_migrations WHERE id = '0003';
  COMMIT;
  ```
- **Readings were already queued.** Do not drop the table: unsent rows (`sent_at IS NULL AND rejected_at IS NULL`)
  are usage Billing has not yet been told about. Roll back the code, keep the table, and let the next release
  relay them; the pgBackRest backup from step 2 is the last resort, restored only with the owner's approval
  because it also discards every job written since.
