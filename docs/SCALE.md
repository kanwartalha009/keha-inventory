# Database scale — measured (2026-10-18)

`npm run loadtest:db -- --stores 100` builds synthetic stores straight into the compact tables
with SQL (`generate_series`) and measures with the app's own SQL builders
(`lib/facts-sql-shared`, `lib/facts-eval-shared`, `lib/season-sql-shared`, the partition DDL).
Raw output: [`scale/loadtest-100-stores-2026-10-18.json`](./scale/loadtest-100-stores-2026-10-18.json).

**What was measured, honestly labelled**

- **100 stores, not 1,000:** 1,000 would need ~175 GB; the sandbox had 26 GB free. Sizes are
  extrapolated **linearly** (×10, ×50): every table grows with stores × their variants × days, and
  no table is shared between stores except the tiny `FactKey` dictionary.
- **Sandbox hardware:** 2 shared vCPUs, Postgres 16 with `shared_buffers = 128MB` (default),
  `work_mem = 16MB`, local disk; other work ran on the same machine. Times are pessimistic next to
  the 4 vCPU · 16 GB instance recommended in [`OPERATIONS.md`](./OPERATIONS.md), and noisy (±30 %).
- **Prisma's query engine does not run in the sandbox:** all SQL ran through psql. Times are
  server time (psql `\timing`); Prisma adds its own serialisation and transfer on top.
- **Mix:** 70 S (300 variants, 1 location), 25 M (3,000 variants, 3 locations), 5 L (30,000
  variants, 10 locations). Sales on 10 / 8 / 5 % of variant-days for 25 months, two sales views
  (location + channel), stock every day for 430 days at every location, 40 / 200 / 1,000 landing
  pages a day, a VariantMetric per variant (online) and per location for 30 % of M / L stores.

## Size

| Table | 100 stores (measured) | Rows | Bytes / row | 1,000 stores | 5,000 stores |
|---|---:|---:|---:|---:|---:|
| StockMonth (stock, 430 days) | 7.7 GB | 26.2 M month rows (771 M stock days) | 294 / month row = **10 / stock day** | 77 GB | 386 GB |
| SalesFact (sales, 25 months) | 5.0 GB | 34.0 M | 147 | 50 GB | 250 GB |
| VariantMetric | 1.8 GB | 0.62 M | 2,932 | 18 GB | 91 GB |
| SessionsFact (visits, 25 months) | 1.7 GB | 9.7 M | 176 | 17 GB | 86 GB |
| StockNow | 0.56 GB | 1.75 M | 323 | 5.6 GB | 28 GB |
| VariantLocationDays | 0.51 GB | 1.75 M | 294 | 5.1 GB | 26 GB |
| Variant, ShopDaily, the rest | 0.13 GB | | | 1.3 GB | 6.5 GB |
| **Total** (heap + indexes + TOAST) | **17.4 GB** | | | **174 GB** | **872 GB** |

**Against the old layout** (measured on one M store, same data, fresh tables):

| | Old row (text keys + shop domain) | Compact daily row (as first specified) | This layout |
|---|---:|---:|---:|
| Stock, per stock day | 430 B | 115 B | **10 B** (one row per variant × location × month) |
| Sales, per row | 310 B | — | **147 B** |
| Stock at 1,000 stores, 430 days | 3.3 TB | 0.89 TB | **77 GB** |
| Stock at 1,000 stores, 25 months (old retention) | 5.9 TB | — | — |

The compact daily stock row (PK `(shopNum, variantNum, locNum, day)`) was measured too: 115 B a day
— an index entry and a tuple header per day — would still be ~0.9 TB at 1,000 stores. Hence
`StockMonth`: one tuple per variant × location × month holding a 31-day array (NULL = no row that
day) and an out-of-stock bitmask, read back as the same daily rows (tests prove the equality).

## One nightly compute pass — measured again 2026-10-18 (perf round)

The first table on this page (2026-10-18 morning: S 0.3 s, M 2 s, L 24 s) counted the database
reads of the 90-day window and their stock decoding only. An independent audit the same day
measured what it left out — the 14-month history read for EVERY variant (forecast quality
2026-10-17), the role-prior pre-pass and the engine's own CPU — at **S 1.3–2 s, M 11–16 s,
L 130–220 s**, and found 83–100 % of the metric rows rewritten every night (this page assumed 30 %).
The load test now measures all of it (`npm run loadtest:db`, raw output
[`scale/loadtest-20-stores-2026-10-18-perf.json`](./scale/loadtest-20-stores-2026-10-18-perf.json)),
before and after the perf round in the same run:

| Per store, one night | S (300 variants) | M (3,000 × 3 locations) | L (30,000 × 10 locations) |
|---|---:|---:|---:|
| **Before** — database | 0.15 s | 1.3 s | 27.3 s |
| Before — JS (stock decoding, 90 days + 14 months) | 0.26 s | 3.5 s | 35.1 s |
| Before — engine (2.1 / 1.7 ms a variant, full backtest) | 0.54 s | 6.4 s | 50.6 s |
| **Before — total** | **0.95 s** | **11.2 s** | **113 s** |
| **After** — database | 0.10 s | 0.67 s | 16.1 s |
| After — JS | 0.12 s | 1.3 s | 13.4 s |
| After — engine (6 of 7 nights cached: 0.6–0.9 ms a variant) | 0.31 s | 2.7 s | 21.7 s |
| **After — total** | **0.53 s** | **4.7 s** | **51 s** |
| 14-month history reads alone, before → after | 73 → 15 ms | 0.70 → 0.12 s | 13.2 → 2.6 s |
| Metric rows rewritten night to night, before → after | 100 → 42 % | 100 → 34 % | 99 → 23 % |

What changed: the history rows and the backtest are read once in seven nights per variant (spread
over the variants) and reused from `VariantBacktest` — the same rows a fresh read builds, tested —
the roles' pooled error ratios are kept for the week (`BacktestRun`) instead of a 600-variant
14-month pre-pass every night; variants that sold nothing in 14 months skip the stock read; stored
floats keep 12 significant digits and inputs.error only what screens show, so float noise and the
nightly-moving backtest internals no longer rewrite rows. Engine outputs are unchanged on the night
a variant's backtest runs; on the other six it uses that night's backtest (ratio, samples, bias).
One intended change: the roles' pooled ratios come from the stored backtests of compute's own runs
(the pre-pass, which ran the engine apart without bundle sales or "Don't cap", only on a first run),
measured once a week.

Honest labels:
- **Sandbox, not Railway:** 2 shared vCPUs (other builders' test suites ran at the same time),
  Postgres 16 with `shared_buffers = 128MB`, psql instead of Prisma (its engine does not run here).
  A second run under heavier load measured L at 261 s before and 113 s after: read the table as ±50 %.
- **Synthetic sales:** 10 / 8 / 5 % of variant-days with a sale (S / M / L). Churn is what is left
  when nothing else changes: a sale entering or leaving the 28 / 56 / 90-day windows still changes a
  row, so busier stores rewrite more. **A variant with an applied seasonal index is rewritten every
  night** (its seasonal multiplier and 53-week curve are re-anchored on today — engine design, not
  storage): on a store with seasonality applied everywhere, churn stays ~100 % (the night totals move
  by < 1 s on L: the writes are a small part).
- **The first night** after install or deploy is the before column (every variant read and
  backtested) plus a one-time write of every cache row and every metric row (the order plan's new
  columns are part of the content hash).
- Not counted (as before): per-location metrics (Pro), the money cards and actions, Prisma's own
  serialisation.

Per night at 1,000 stores (70 % S, 25 % M, 5 % L): before 700 × 0.95 + 250 × 11.2 + 50 × 113 ≈
**2.5 h** of one worker process; after 700 × 0.53 + 250 × 4.7 + 50 × 51 ≈ **1.1 h**. At 5,000 stores
≈ **5.7 h** after (12.7 h before): three worker processes (replicas) finish inside a two-hour window,
spread over the stores' 03:00 local times. Postgres's share after: 1,000 stores ≈ 0.3 h of database
time a night (700 × 0.10 + 250 × 0.67 + 50 × 16.1 s).

New storage: `VariantBacktest` measured 780 B a row with its index (one row per planned variant;
synthetic histories of 0.3–0.6 KB — a store selling on 30 % of days encodes ~1.7 KB) ≈ **1.9 GB at
1,000 stores, 9.6 GB at 5,000**. The order plan's columns add ~0.2 KB to a VariantMetric row (~+15 %).

### The page loads and the hourly jobs this round touched (20 stores, same run)

| | S | M | L |
|---|---:|---:|---:|
| Order plan, database p50 / p95 — before (inputs JSON) | 0.2 / 0.3 ms | 36 / 43 ms | 421 / 473 ms |
| Order plan, database p50 / p95 — after (typed columns + the run's curves) | 0.2 / 0.4 ms | 9 / 14 ms | 115 / 162 ms |
| Order plan rows as the app receives them, before → after | — | 4.9 → 1.7 MB, parse 21 → 5 ms | 49 → 17 MB, parse 249 → 55 ms |
| Alerts (hourly), database p50 — before → after | 1.8 → 3.1 ms | 12 → 21 ms | 319 → 331 ms |
| Alerts rows to the app, before → after | 600 → 0 | 15,000 → 1 | 360,000 (32 MB, parse 116 ms) → 1 |

(The parse is a JSON stand-in for Prisma turning rows into objects, measured the same way on both
sides; Prisma's real cost is higher and was not measured.) The alerts job's database time is the same
— Postgres now does the aggregation the app did — but the app no longer pulls every metric, every
stock-now row and the whole catalog of a store into memory every hour. The order plan's synthetic
curve has 13 weeks; real rows carry 53 (~0.8 KB more each before, nothing more after).

Job queue claim (`SQL_CLAIM`, 30 claims rolled back): 0.6 ms p50 with 2,000 or 20,000 queued jobs
and few running, before and after. The claim index matters when many of the oldest due jobs are
running or locked: with 50,000 of 100,000 locked the old claim took 28 ms (it walked past every
locked row), the new one 0.7 ms.

## Earlier measurement: the 90-day reads only (2026-10-18 morning, 100 stores)

| Store | Statements | DB time | Stock days expanded in JS | Total |
|---|---:|---:|---:|---:|
| S (300 variants) | 33 | 0.25 s | 0.08 s | 0.3 s |
| M (3,000 × 3) | 60 | 1.0 s | 1.0 s | 2.0 s |
| L (30,000 × 10) | 416 | 16.2 s | 8.1 s | 24 s |

These are part of the night above (the "database" and "JS" rows include them), not the night.

Stock reads are evaluated in memory: Postgres returns the month rows that can match (index work
only; compute's "pooled stock" and "out-of-stock days" reads share one fetch) and the days are
expanded with typed-array accumulators (`lib/facts-eval-shared` `evaluateStockMonths`). Letting
Postgres unnest and sort the arrays measured 0.6–2 s per chunk query — 3–5× slower.

## Nightly sync writes (one day re-read, per store)

| Store | Stock day, first write | Stock day re-read, unchanged | Sales day | Sales day re-read |
|---|---:|---:|---:|---:|
| S | 13 ms | 3 ms | 4 ms | 1 ms |
| M (9,000 series) | 120 ms | 64 ms | 6 ms | 2 ms |
| L (300,000 series) | 4.7 s | 2.7 s | 42 ms | 11 ms |

Per night at 1,000 stores: 700 × 0.02 + 250 × 0.13 + 50 × 4.8 ≈ **5 minutes**. An unchanged re-read
rewrites nothing (tests check `xmin`); the first write of a day updates each series' month row once.

## Page loads (database time; 30 loads each)

| Store | Products | Order plan | Product page | Dashboard | Alerts: last stock day (hourly job) |
|---|---|---|---|---|---|
| S | 2.4 / 3.2 ms | 3.3 / 3.7 ms | 1.3 / 3.6 ms | 1.1 / 5.9 ms | 0.3 / 0.5 ms |
| M | 11 / 13 ms | 33 / 45 ms | 1.3 / 1.8 ms | 2.1 / 3.2 ms | 4.7 / 7 ms |
| L | 66 / 90 ms | **314 / 383 ms** | 2.7 / 5.2 ms | 11.5 / 16 ms | 60 / 92 ms |

(p50 / p95, before the perf round.) The order plan read every metric with something to order and its
inputs JSON; on an L store that is ~20,000 rows — it now reads typed columns (above: L 473 → 162 ms p95). Products and Sidekick reuse it through the plan cache (fingerprint on
MetricRun and the catalog's `updatedAt`, which now moves only on a real change).

## Maintenance and purge

- One partition-maintenance pass a month later (a month created and the oldest dropped, for each of
  the 3 tables, `DETACH … CONCURRENTLY` + `DROP`): **0.3 s**. The row-delete retention it replaces
  would have deleted ~1 month of every store's rows (≈ 30 M rows per 100 stores) and left them to vacuum.
- Purge of one L store (8.96 M fact rows + catalog rows), partition by partition in batches of
  50,000: **33 s**.

## Rating (honest)

**1,000 stores: 8 / 10.** The data layer fits a mid-size Railway Postgres (≈ 175 GB + ~2 GB of
backtest cache, 4 vCPU · 16 GB); a night of compute is ~1.1 h of one worker process (was ~2.5 h), the
largest store ~50 s (was ~115 s), page loads are ≤ 0.1 s except the order plan on the largest stores
(~0.16 s p95, was ~0.47 s). Not 10 because: (1) nothing ran on Railway or through Prisma's query
engine — the raw SQL, the array parameters and the new typed columns are verified on Postgres 16
through psql only; (2) a production deployment needs the separate worker service (`OPERATIONS.md`
"Services"): with `WORKER_MODE=all` compute shares the core with pages; (3) seasonal stores still
rewrite every metric row every night (engine design); (4) the engine itself (~0.6 ms a variant even
cached, the spike cap re-reads 14 months of rows in memory) is now the largest part of a large
store's night.

**5,000 stores: 6.5 / 10** — ~880 GB of data is inside Railway Pro's 1 TB volume without headroom
(Enterprise above), a night is ~5.7 h of worker time (three replicas), and every point above weighs
5× more. Next steps, in order: one Railway run on a dev store (`EXPLAIN` the stock fetch, the
alerts aggregation and a change-only write through Prisma); the worker service; measure Prisma's
own cost on the order plan read; a read replica for pages.
