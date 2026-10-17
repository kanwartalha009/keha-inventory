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

## One nightly compute pass (database work per store)

The reads `computeShop` issues — catalog, 90-day revenue, the season's store series (846 days),
12-month units, product types, last year ahead, traffic, then per chunk of 2,000 variants: sales
(channel and pool views), stock, stock now, stored days, exact last-sale lookups, older series —
plus the change-only VariantMetric writes (hash read per 1,000, 30 % rewritten) and the sweep.

| Store | Statements | DB time | Stock days expanded in JS | Total |
|---|---:|---:|---:|---:|
| S (300 variants) | 33 | 0.25 s | 0.08 s | **0.3 s** |
| M (3,000 × 3) | 60 | 1.0 s | 1.0 s | **2.0 s** |
| L (30,000 × 10) | 416 | 16.2 s | 8.1 s | **24 s** |

Per night at 1,000 stores: 700 × 0.3 + 250 × 2.0 + 50 × 24 ≈ **32 minutes of one worker**, spread
over the stores' 03:00 local times; 5,000 stores ≈ 2.7 h — one or two worker services.

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

(p50 / p95.) The order plan reads every metric with something to order and its inputs JSON; on an
L store that is ~20,000 rows. Products and Sidekick reuse it through the plan cache (fingerprint on
MetricRun and the catalog's `updatedAt`, which now moves only on a real change).

## Maintenance and purge

- One partition-maintenance pass a month later (a month created and the oldest dropped, for each of
  the 3 tables, `DETACH … CONCURRENTLY` + `DROP`): **0.3 s**. The row-delete retention it replaces
  would have deleted ~1 month of every store's rows (≈ 30 M rows per 100 stores) and left them to vacuum.
- Purge of one L store (8.96 M fact rows + catalog rows), partition by partition in batches of
  50,000: **33 s**.

## Rating (honest)

**1,000 stores: 8 / 10.** The data layer fits a mid-size Railway Postgres (≈ 175 GB, 4 vCPU · 16 GB),
nightly work is ~40 minutes of one worker, page loads are ≤ 0.1 s except the order plan on the
largest stores (~0.4 s), retention and purge are cheap. Not 10 because: (1) Prisma's query engine
never ran here — the raw-SQL paths (array parameters, BigInt results, 300,000-element arrays in one
statement) are tested through psql only and must be checked once on Railway; (2) the order plan
reads ~20,000 metric rows with their JSON on L stores; (3) VariantMetric is ~3 KB a row and is now
the third-largest table; (4) measured on 2 shared vCPUs at 100 stores, extrapolated.

**5,000 stores: 6 / 10** — ~870 GB is inside Railway Pro's 1 TB self-serve volume but without
headroom (Enterprise above 1 TB), and the order plan / VariantMetric points above weigh 5× more.
Next steps, in order: verify the raw SQL on Railway (one dev store, `EXPLAIN` the stock fetch and a
change-only write); trim the order plan's read (only the forward-plan fields of `inputs`); store
VariantMetric.inputs as a smaller document; a read replica for pages.
