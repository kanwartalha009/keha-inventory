-- DB scale "before 1,000 stores" (owner-approved 2026-10-17): compact daily fact tables.
--
--  - Shop.num: a small integer per shop (SERIAL, never reused) stored in every fact row instead
--    of the shop domain.
--  - FactKey: one dictionary of the string keys the facts carry — location ids, "online", "all",
--    "pos:<name>", sales channel names, traffic types — as small integers (0 = "all",
--    1 = "online"). Append-only: a key keeps its number for ever.
--  - SalesFact: SalesDaily with integer keys (variant = the number in the Shopify GID, gross in
--    cents), PK (shopNum, variantNum, locNum, channelNum, day), plus (shopNum, day) for the
--    shop-wide day reads; monthly RANGE partitions on day.
--  - StockMonth: StockDaily as one row per variant × location × MONTH: endUnits[1..31] (day of
--    month; NULL = no stock row that day), outMask (bit d-1 = out of stock on day d), firstDay /
--    lastDay (the first / last day with data); monthly RANGE partitions on month. A day costs
--    ~4 bytes instead of a ~520-byte row (docs/SCALE.md).
--  - SessionsFact: SessionsDaily with shopNum and trafficNum; monthly RANGE partitions on day.
--
-- Partitions are created here for the retention window and 2 months ahead; from then on the
-- partition-maintenance job (services/partitions.server) keeps 2 months ahead and drops what is
-- past retention (DROP TABLE of a month instead of row deletes). Storage parameters are set per
-- partition (Postgres does not take them on a partitioned parent).
--
-- Add-only: SalesDaily, StockDaily and SessionsDaily stay (no longer written or read; a later
-- cleanup migration can drop them). Their rows are copied into the new tables below, so a store
-- keeps its history and nothing has to be read from Shopify again.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "num" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Shop_num_key" ON "Shop"("num");

-- CreateTable
CREATE TABLE "FactKey" (
    "num" SERIAL NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "FactKey_pkey" PRIMARY KEY ("num")
);

-- CreateIndex
CREATE UNIQUE INDEX "FactKey_key_key" ON "FactKey"("key");

INSERT INTO "FactKey" ("num", "key") VALUES (0, 'all'), (1, 'online');
SELECT setval(pg_get_serial_sequence('"FactKey"', 'num'), 1);

-- CreateTable
CREATE TABLE "SalesFact" (
    "variantNum" BIGINT NOT NULL,
    "grossCents" BIGINT NOT NULL,
    "shopNum" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "locNum" INTEGER NOT NULL,
    "channelNum" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL,
    "returned" INTEGER NOT NULL,

    CONSTRAINT "SalesFact_pkey" PRIMARY KEY ("shopNum","variantNum","locNum","channelNum","day")
) PARTITION BY RANGE ("day");

-- CreateIndex
CREATE INDEX "SalesFact_shopNum_day_idx" ON "SalesFact"("shopNum", "day");

-- CreateTable
CREATE TABLE "StockMonth" (
    "variantNum" BIGINT NOT NULL,
    "shopNum" INTEGER NOT NULL,
    "month" DATE NOT NULL,
    "locNum" INTEGER NOT NULL,
    "outMask" INTEGER NOT NULL,
    "firstDay" SMALLINT NOT NULL,
    "lastDay" SMALLINT NOT NULL,
    "endUnits" INTEGER[],

    CONSTRAINT "StockMonth_pkey" PRIMARY KEY ("shopNum","variantNum","locNum","month")
) PARTITION BY RANGE ("month");

-- CreateTable
CREATE TABLE "SessionsFact" (
    "shopNum" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "trafficNum" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "checkouts" INTEGER NOT NULL,
    "landingPath" TEXT NOT NULL,

    CONSTRAINT "SessionsFact_pkey" PRIMARY KEY ("shopNum","day","landingPath","trafficNum")
) PARTITION BY RANGE ("day");

-- First / last day with data in a 31-day month array (NULL = no data that day).
CREATE OR REPLACE FUNCTION keha_first_day(a INTEGER[]) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT min(u.i)::smallint FROM unnest(a) WITH ORDINALITY AS u(e, i) WHERE u.e IS NOT NULL
$$;
CREATE OR REPLACE FUNCTION keha_last_day(a INTEGER[]) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT max(u.i)::smallint FROM unnest(a) WITH ORDINALITY AS u(e, i) WHERE u.e IS NOT NULL
$$;
-- (day of month, value) pairs → the 31-day array (used by the copy below).
CREATE OR REPLACE FUNCTION keha_month_array(days INTEGER[], vals INTEGER[]) RETURNS INTEGER[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_agg(x.e ORDER BY g.d) FROM generate_series(1, 31) AS g(d) LEFT JOIN unnest(days, vals) AS x(d, e) ON x.d = g.d
$$;

-- Partitions: the retention window (sales and visits 25 months, stock 430 days — the longest
-- stock read is 427 days, engine/rate-shared PACE_LOOKBACK_DAYS) and 2 months ahead.
-- Same names and settings as services/partitions.server (lib/partitions-shared).
DO $$
DECLARE
  m DATE;
BEGIN
  FOR m IN SELECT generate_series(date_trunc('month', now() - interval '25 months'), date_trunc('month', now() + interval '2 months'), interval '1 month')::date LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF "SalesFact" FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 95, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05)',
      'SalesFact_p' || to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF "SessionsFact" FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 95, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05)',
      'SessionsFact_p' || to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date);
  END LOOP;
  FOR m IN SELECT generate_series(date_trunc('month', now() - interval '430 days'), date_trunc('month', now() + interval '2 months'), interval '1 month')::date LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF "StockMonth" FOR VALUES FROM (%L) TO (%L) WITH (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05)',
      'StockMonth_p' || to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date);
  END LOOP;
END $$;

-- Copy the existing facts (dev stores only before launch). Rows outside the partitions' window
-- are past retention and are not copied; rows of a shop without a Shop row cannot be keyed.
INSERT INTO "FactKey" ("key")
SELECT x.k FROM (
  SELECT "locationKey" AS k FROM "SalesDaily"
  UNION SELECT "channel" FROM "SalesDaily"
  UNION SELECT "locationId" FROM "StockDaily"
  UNION SELECT "trafficType" FROM "SessionsDaily"
) x
ORDER BY x.k
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "SalesFact" ("variantNum", "grossCents", "shopNum", "day", "locNum", "channelNum", "sold", "returned")
SELECT substring(d."variantId" from '([0-9]+)$')::bigint, round(d."gross" * 100)::bigint, s."num", d."day", l."num", c."num", d."sold", d."returned"
FROM "SalesDaily" d
JOIN "Shop" s ON s."domain" = d."shop"
JOIN "FactKey" l ON l."key" = d."locationKey"
JOIN "FactKey" c ON c."key" = d."channel"
WHERE d."variantId" ~ '[0-9]+$'
  AND d."day" >= date_trunc('month', now() - interval '25 months')::date
  AND d."day" < (date_trunc('month', now() + interval '2 months') + interval '1 month')::date;

INSERT INTO "StockMonth" ("variantNum", "shopNum", "month", "locNum", "outMask", "firstDay", "lastDay", "endUnits")
SELECT x.v, x.sn, x.m, x.ln,
  bit_or(CASE WHEN x.o THEN 1 << (x.dd - 1) ELSE 0 END),
  min(x.dd)::smallint, max(x.dd)::smallint,
  keha_month_array(array_agg(x.dd), array_agg(x.e))
FROM (
  SELECT substring(d."variantId" from '([0-9]+)$')::bigint AS v, s."num" AS sn, date_trunc('month', d."day")::date AS m, l."num" AS ln,
    extract(day from d."day")::int AS dd, d."endUnits" AS e, d."outOfStock" AS o
  FROM "StockDaily" d
  JOIN "Shop" s ON s."domain" = d."shop"
  JOIN "FactKey" l ON l."key" = d."locationId"
  WHERE d."variantId" ~ '[0-9]+$'
    AND d."day" >= date_trunc('month', now() - interval '430 days')::date
    AND d."day" < (date_trunc('month', now() + interval '2 months') + interval '1 month')::date
) x
GROUP BY x.v, x.sn, x.m, x.ln;

INSERT INTO "SessionsFact" ("shopNum", "day", "trafficNum", "sessions", "checkouts", "landingPath")
SELECT s."num", d."day", t."num", d."sessions", d."checkouts", d."landingPath"
FROM "SessionsDaily" d
JOIN "Shop" s ON s."domain" = d."shop"
JOIN "FactKey" t ON t."key" = d."trafficType"
WHERE d."day" >= date_trunc('month', now() - interval '25 months')::date
  AND d."day" < (date_trunc('month', now() + interval '2 months') + interval '1 month')::date;

-- Hot tables: updated in place by the change-only upserts (lib/bulk-sql-shared) → room for HOT
-- updates, and vacuumed / analysed sooner than the 20 % default.
ALTER TABLE "StockNow" SET (fillfactor = 85, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "Variant" SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE "VariantLocationDays" SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE "Job" SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 200);
ALTER TABLE "JobLease" SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 200);
