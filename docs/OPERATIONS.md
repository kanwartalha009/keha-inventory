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

## Routine checks

- Partitions: `SELECT parent.relname, count(*) FROM pg_inherits i JOIN pg_class parent ON parent.oid = i.inhparent GROUP BY 1;`
  — `SalesFact` / `SessionsFact` ≈ 28 months, `StockMonth` ≈ 17. `/health` → `jobs` shows a failing
  `maintenance` job.
- Bloat after the nightly runs: `SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;`
- Size: `SELECT pg_size_pretty(pg_database_size(current_database()));`

## Later cleanup (not urgent)

Once every store runs on the compact tables (they do from the 20261018 migration on), a cleanup
migration can drop the legacy tables (`DROP TABLE "SalesDaily", "StockDaily", "SessionsDaily";` and
remove the `Legacy*` models). Not done now: migrations here are add-only.
