# Operations — the database (Railway Postgres)

What to run and how to set it for 1,000 installed stores (and how to grow to 5,000). The numbers
behind every recommendation are measured in [`SCALE.md`](./SCALE.md) (`npm run loadtest:db`).

## What the data layer does

- **Daily facts are compact and partitioned by month** (`prisma/migrations/20261018000000_compact_facts`):
  `SalesFact` (one row per variant × location / channel × day, integer keys, gross in cents),
  `StockMonth` (one row per variant × location × **month**: a 31-day array of ending units plus an
  out-of-stock bitmask), `SessionsFact` (visits per landing page × traffic type × day). Keys are
  `Shop.num`, the number in the variant GID and `FactKey` (location ids, "online", "all", POS names,
  channels, traffic types). The app reads and writes them only through
  `app/services/facts-store.server.ts`, in its own ids. The old `SalesDaily` / `StockDaily` /
  `SessionsDaily` tables are no longer used (their rows were copied by the migration).
- **Retention is a DROP, not a DELETE.** The store-wide `maintenance` job (`Job.shop = "*"`, queued
  by the hourly `partitions` tick) creates every month from the retention cutoff to 2 months ahead
  and drops months past retention with `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` + `DROP TABLE`
  (readers and writers of the parent never wait). Sales and visits: 25 months; stock: 430 days (the
  out-of-stock pace fallback reads 427 days back). Writers create a missing month themselves.
- **Rows are written only when they change.** Catalog sync (`Variant`, `StockNow`) and the facts
  use `INSERT … ON CONFLICT DO UPDATE … WHERE (values differ)` in chunks with array parameters;
  `VariantMetric` compares a content hash per row. Unchanged rows produce no dead tuples, no index
  updates and no WAL.
- **Uninstall purge** (48 h after uninstall, and `shop/redact`) deletes the shop's fact rows partition
  by partition, 50,000 rows per statement, then every table with a `shop` column.
- **The 14-month history is read once a week per variant** (perf 2026-10-18, `lib/backtest-cache-shared`):
  `VariantBacktest` keeps, per variant, the history rows compute's read built (encoded, ~0.3–0.7 KB at
  5–10 % sales days) and that night's forecast-error backtest; each variant is read again on one night in
  seven (spread by variant), the rest reuse it. `BacktestRun` keeps the ABC roles' pooled error ratios for
  the week. A cache row from another pool / demand view / settings / backfill coverage is ignored; a
  failing cache read or write falls back to reading the facts (compute never fails on it). Purged with the
  shop like every table with a `shop` column.
- **Alerts read candidates only**: the hourly job asks Postgres for the products fully out over the pool,
  the metrics a rule can use and the dead products (`lib/alerts-sql-shared`), then reads the catalog of
  those products only.
- **The order plan reads typed columns**: `VariantMetric.plan*` (the forward plan's inputs, written with
  each row) and `MetricRun.curves` (each run's seasonal curves, once per shape); `inputs` stays the full
  record for the product page. Rows written before the columns (`planVersion` NULL) are read the old way;
  the first compute after the deploy rewrites every row once (the column format is in the content hash).
- **Per-store jobs**: besides backfill / nightly / compute / alerts, the hourly accuracy snapshot and the
  6-hourly plan check are one queued job per store (`accuracy`, `plans`), not serial loops in a timer.
  The claim uses two partial indexes, `Job_claim_idx` (`runAt, id WHERE lockedUntil IS NULL`) and
  `Job_locked_idx` (`lockedUntil WHERE lockedUntil IS NOT NULL`). schema.prisma can't express partial
  indexes (like the fact tables' partitions): they exist only in the migration SQL — if a `prisma migrate dev`
  ever proposes dropping them, don't.

## Services (required in production)

Run **two Railway services from the same image**: the web service with `WORKER_MODE=web` (pages,
webhooks, `/health`) and a worker service with `WORKER_MODE=worker` (timers and the job queue:
backfill, nightly sync, compute, alerts, accuracy, plan checks, maintenance). Same variables,
same start command.

Why it is not optional: one nightly compute of a large store is tens of seconds of CPU on one core
(SCALE.md "One nightly compute pass"). Compute now yields to the event loop every 100 variants
(perf 2026-10-18; before, a 2,000-variant chunk held the loop 3–5 s), so a page request waits at
most ~0.2 s for a slice — but the slices still take the core, and on a store of 30,000 variants a
night's compute keeps it busy for tens of seconds. `WORKER_MODE=all` (the default, one service) stays
fine for development and for the first few small stores; in production, compute logs a warning when
it runs a store of more than 5,000 variants in a process that also serves pages:
`[compute] <shop>: … variants computed in a process that also serves pages (WORKER_MODE=all)`.

Scaling the worker: `INVENTORY_WORKERS` (default 2) is the number of job loops in ONE Node process —
they share one event loop and one core, so they overlap database waits, not CPU. More CPU for
compute means more worker **replicas** (Railway → the worker service → Replicas) or more worker
services: the queue hands each job to one claimant (`FOR UPDATE SKIP LOCKED` + a lease per shop), so
any number of replicas is safe. A replica needs at most 10 database connections (`connection_limit`).
Sizing (SCALE.md, sandbox numbers): a night of compute is ~1.1 h of one worker process at 1,000
stores and ~5.7 h at 5,000 — one replica, then three, to finish inside a two-hour window. The app does
not fork worker processes itself (no `node:cluster`): Railway replicas are the supported way.

## Instance size

| Stores | Database on disk (SCALE.md) | Postgres service | Volume |
|---|---|---|---|
| 100 | 17 GB (measured) | 2 vCPU · 4 GB | 50 GB (Pro default) |
| 1,000 | ~175 GB (projected) | **4 vCPU · 16 GB** (8 vCPU · 32 GB from ~2,500 stores) | 250–300 GB |
| 5,000 | ~870 GB (projected) | 8–16 vCPU · 64 GB, read replica for pages | 1 TB = Pro's self-serve maximum; above → Enterprise |

Why: the hot working set is the current and previous month of `StockMonth`, ~3 months of
`SalesFact`, `VariantMetric`, `Variant` and `StockNow` (SCALE.md lists them). It should fit in RAM
(shared_buffers + the OS page cache). Railway volumes give **3,000 read and 3,000 write operations
per second on every size** — so the design avoids random I/O at night: a shop's rows are written
together (one shop × one month per statement), retention drops files instead of deleting rows, and
unchanged rows are never rewritten. Railway prices (2026): $10 / GB RAM / month, $20 / vCPU / month,
$0.15 / GB of volume / month — 4 vCPU · 16 GB + 300 GB ≈ $285 / month.

## Postgres settings (Railway → the Postgres service → Variables / `ALTER SYSTEM`)

For a 16 GB / 4 vCPU instance (scale linearly):

```
shared_buffers = 4GB                 # 25 % of RAM
effective_cache_size = 11GB          # ~70 % of RAM
work_mem = 32MB                      # compute groups up to ~200,000 rows per query
maintenance_work_mem = 1GB
max_wal_size = 8GB                   # nightly writes are bursts: fewer forced checkpoints
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = lz4
random_page_cost = 1.1               # SSD-backed volume
effective_io_concurrency = 200
jit = off                            # short OLTP queries: JIT only adds latency
autovacuum_max_workers = 4
autovacuum_naptime = 20s
autovacuum_vacuum_cost_limit = 2000  # let vacuum keep up with the nightly updates
max_connections = 200                # behind PgBouncer; the app opens at most 10 per process
```

Per-table autovacuum and fillfactor are set by the migrations (hot tables: `StockMonth` partitions
85 %, `StockNow` 85 %, `Variant` / `VariantMetric` 90 %, `Job` / `JobLease` 70 %; vacuum at 2–5 % of
changed rows instead of 20 %).

## Connection pooler (from ~500 stores or a second app service)

Run **PgBouncer in transaction mode** in front of Postgres, as its own service on the private
network (for example the `edoburu/pgbouncer` Docker image; check Railway's template marketplace for
a maintained PgBouncer template first):

```
pool_mode = transaction
default_pool_size = 30
max_client_conn = 500
server_reset_query =                 # not needed in transaction mode
```

- App services: `DATABASE_URL=postgresql://…@pgbouncer.railway.internal:6432/railway?pgbouncer=true`
  (`pgbouncer=true` makes Prisma stop using prepared statements). The app still adds
  `connection_limit=10&pool_timeout=20` per process.
- Migrations: run `prisma migrate deploy` with `DATABASE_URL` set to the **direct** Postgres URL
  (e.g. in the deploy command of one service), never through PgBouncer.
- Safe by construction: every statement is single-statement or a Prisma batch transaction; the
  job queue uses row leases, never session locks; `DETACH PARTITION CONCURRENTLY` runs outside a
  transaction (autocommit), which transaction pooling allows.

## Read replica (optional, from ~2,500 stores)

Page loads read `VariantMetric`, `Variant`, `StockNow` and a few days of facts; nightly work writes.
A Railway Postgres read replica can take the page reads once the primary is busy at night. It needs
a second Prisma client for reads (not wired today: `@prisma/extension-read-replicas` is not a
dependency) — measure first: SCALE.md's page-load p95s are on a single primary.

## Email and notifications (no email provider)

Owner decision 2026-10-18: the app runs with **no email provider**. Leave `INVENTORY_EMAIL_API_KEY`
/ `INVENTORY_EMAIL_FROM` unset; `/health` → `config.email` is `"flow"` (normal, not a failure).

- **Monday summary** → Shopify Flow trigger "Weekly order plan ready" (every plan; the Monday job,
  once per store week, `OwnerEmailLog` kind `monday_flow`). **First plan ready** → "First order plan
  ready" (after a compute job, once per store, kind `plan_ready_flow`). Instant alerts → "Product
  needs reorder" (Growth, hourly alerts job) and Slack. Merchants get them by email with a Flow
  workflow (Send internal email); templates: `docs/FLOW-TEMPLATES.md`.
- A trigger Shopify refuses (extension not released yet) is logged `[flow] … rejected` and marked
  FAILED for that period (next week fires again); a network error gets one retry an hour later.
  Check: `SELECT kind, status, error, count(*) FROM "OwnerEmailLog" WHERE kind LIKE '%flow' GROUP BY 1,2,3;`
- **Purchase orders** go from the merchant's own email app ("Open in your email", a mailto); the
  supplier page serves the PDF and CSV (`/supplier/confirm/:token/pdf|csv`, same rate limit).
- **Data requests** (`customers/data_request`) are answered in the access log; the log line is
  `[gdpr] data_request for <shop>: no customer data held; recorded in the access log` (info).
- Setting a provider later turns the app's own emails back on (Monday email, alert emails, "Email
  supplier", data-request email) with no code change; the privacy page then names it as a
  sub-processor automatically — add it to `docs/listing/PCD-ANSWERS.md` too.

## Routine checks

- Partitions: `SELECT parent.relname, count(*) FROM pg_inherits i JOIN pg_class parent ON parent.oid = i.inhparent GROUP BY 1;`
  — `SalesFact` / `SessionsFact` ≈ 28 months, `StockMonth` ≈ 17. `/health` → `jobs` shows a failing
  `maintenance` job.
- Bloat after the nightly runs: `SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;`
- Size: `SELECT pg_size_pretty(pg_database_size(current_database()));`
- Backtest cache: `SELECT pg_size_pretty(pg_total_relation_size('"VariantBacktest"')), count(*), count(*) FILTER (WHERE "day" < CURRENT_DATE - 7) AS stale FROM "VariantBacktest";`
  — about one row per planned variant; compute removes a store's rows older than 14 nights (variants no
  longer planned), so `stale` rows belong to stores whose compute stopped (purged with the store).

## Later cleanup (not urgent)

Once every store runs on the compact tables (they do from the 20261018 migration on), a cleanup
migration can drop the legacy tables (`DROP TABLE "SalesDaily", "StockDaily", "SessionsDaily";` and
remove the `Legacy*` models). Not done now: migrations here are add-only.
