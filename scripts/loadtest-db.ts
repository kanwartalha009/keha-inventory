/**
 * Database load test (DB scale "before 1,000 stores"): builds N synthetic stores in a local
 * Postgres directly with SQL (generate_series into the compact tables — minutes, not hours), then
 * measures with the app's own SQL (lib/facts-sql-shared buildRead / write builders, the season
 * query, the partition DDL) what docs/SCALE.md reports:
 *
 *   - size per table (heap + indexes + TOAST, every partition) and bytes per row / per stock day,
 *     against the legacy row layout (SalesDaily / StockDaily, measured on one M store) and the
 *     "compact daily rows" stock layout (also measured, the alternative to month arrays);
 *   - one nightly compute pass's database time for an S, M and L store (the reads computeShop
 *     issues, chunk by chunk, plus the change-only VariantMetric writes) and the nightly sync's
 *     one-day writes (replaceStock / replaceSales);
 *   - page-load queries (Products, the order plan, the product page, the Dashboard): p50 / p95;
 *   - partition maintenance (a month created and one dropped per table) and the purge of an L store.
 *
 * Mix: 70 % S (300 variants, 1 location), 25 % M (3,000 variants, 3 locations), 5 % L (30,000
 * variants, 10 locations); sales on 10 / 8 / 5 % of variant-days over 25 months; stock every day
 * for 430 days; visits by landing page; VariantMetric for every variant (online) and per location
 * for 30 % of M / L stores.
 *
 *   npm run loadtest:db -- --stores 100            (default 100; --keep keeps the database)
 *
 * Needs psql and a local Postgres: KEHA_TEST_PG (libpq string) or the sandbox socket /tmp/pg:5433.
 * Prints JSON (and writes it to --out, default /tmp/keha-loadtest.json).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PURGE_BATCH, buildRead, buildStockFetch, buildStockLatestInMonth, purgeBatchSql, purgeProbeSql, salesReplace, stockReplace, type EncodedSales, type EncodedStock, type FactTableName, type ReadOp } from "../app/lib/facts-sql-shared";
import { productTypeSeriesQuery } from "../app/lib/season-sql-shared";
import { evaluateStockMonths, type StockMonthRow } from "../app/lib/facts-eval-shared";
import { addMonths, monthOf, variantNum } from "../app/lib/ids-shared";
import { FACT_TABLES, createPartitionSql, detachPartitionSql, dropPartitionSql, partitionName } from "../app/lib/partitions-shared";
import { addDays } from "../app/lib/sync/shopifyql-shared";

// ---------------------------------------------------------------------------
// psql plumbing
// ---------------------------------------------------------------------------

const CONN = process.env.KEHA_TEST_PG || (existsSync("/tmp/pg/.s.PGSQL.5433") ? "host=/tmp/pg port=5433 user=postgres" : null);
if (!CONN) throw new Error("no Postgres: set KEHA_TEST_PG");

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const STORES = Number(arg("stores", "100"));
const DB = arg("db", "keha_loadtest");
const OUT = arg("out", "/tmp/keha-loadtest.json");
const KEEP = process.argv.includes("--keep");
const SKIP_PURGE = process.argv.includes("--skip-purge");

function psql(db: string, script: string, opts: { quiet?: boolean } = {}): string {
  return execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", ...(opts.quiet === false ? [] : ["-q"]), "-A", "-t", `${CONN} dbname=${db}`, "-f", "-"], {
    input: script,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const one = (db: string, sql: string) => psql(db, `${sql};`).trim();

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const element = (v: unknown) => (v === null || v === undefined ? "NULL" : `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
function bind(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (m, n: string) => {
    const v = params[Number(n) - 1];
    if (Number(n) - 1 >= params.length) return m;
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return quote(`{${v.map(element).join(",")}}`);
    return typeof v === "number" ? String(v) : quote(String(v));
  });
}

/** Runs statements in one session (results discarded) and returns each one's time in ms. */
function timed(db: string, statements: readonly string[], setup = ""): number[] {
  const script = `${setup}\n\\timing on\n\\o /dev/null\n${statements.map((s) => `${s};`).join("\n")}\n`;
  const out = psql(db, script);
  return [...out.matchAll(/Time: ([0-9.]+) ms/g)].map((m) => Number(m[1]));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : 0;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const log = (...a: unknown[]) => console.error(`[loadtest ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------------------------------------------------------------------------
// Setup and generation
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = addDays(TODAY, -1);
const SALES_FROM = addDays(TODAY, -760); // 25 months
const STOCK_FROM = monthOf(addDays(TODAY, -430));

type Klass = { name: "S" | "M" | "L"; share: number; variants: number; locations: number; density: number; paths: number };
const CLASSES: Klass[] = [
  { name: "S", share: 0.7, variants: 300, locations: 1, density: 100, paths: 40 },
  { name: "M", share: 0.25, variants: 3000, locations: 3, density: 80, paths: 200 },
  { name: "L", share: 0.05, variants: 30000, locations: 10, density: 50, paths: 1000 },
];

function applyMigrations(): void {
  psql("postgres", `DROP DATABASE IF EXISTS ${DB};\nCREATE DATABASE ${DB};`);
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
  for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", `${CONN} dbname=${DB}`, "-f", join(dir, f, "migration.sql")], { stdio: ["ignore", "ignore", "pipe"] });
  }
}

/** Shops 1..N: S first, then M, then L (counts from the mix, at least one of each). */
function shopPlan(n: number): { num: number; k: Klass }[] {
  const counts = CLASSES.map((k) => Math.max(1, Math.round(n * k.share)));
  const out: { num: number; k: Klass }[] = [];
  let num = 1;
  CLASSES.forEach((k, i) => {
    for (let j = 0; j < counts[i]!; j++) out.push({ num: num++, k });
  });
  return out;
}

/** Stops before the sandbox disk fills up (other work shares it). */
function guardDisk(minGb = 4): void {
  const free = Number(execFileSync("df", ["-BG", "--output=avail", "/"], { encoding: "utf8" }).split("\n")[1]!.replace("G", "").trim());
  if (free < minGb) throw new Error(`only ${free} GB free: stopping (run fewer --stores)`);
}

function generate(plan: { num: number; k: Klass }[]): Record<string, number> {
  const t: Record<string, number> = {};
  const step = (name: string, sql: string) => {
    guardDisk();
    const s = Date.now();
    psql(DB, `SET synchronous_commit = off;\nSET work_mem = '256MB';\nSET maintenance_work_mem = '512MB';\n${sql}`);
    t[name] = Date.now() - s;
    log(name, `${t[name]} ms`);
  };
  const values = plan.map((p) => `(${p.num}, '${p.k.name}', ${p.k.variants}, ${p.k.locations}, ${p.k.density}, ${p.k.paths})`).join(",");
  step(
    "shops+keys",
    `
CREATE TABLE lt_shop (num int PRIMARY KEY, klass text, variants int, locations int, density int, paths int);
INSERT INTO lt_shop VALUES ${values};
INSERT INTO "Shop" ("id", "domain", "currency", "timezone", "locale", "num", "factDaysAt", "lastNightlyAt", "backfillState")
SELECT 'lt' || num, 'loadtest-' || num || '.myshopify.com', 'EUR', 'Europe/Madrid', 'en', num, now(), now(), '{"finishedAt":"2026-01-01T00:00:00Z","first90Ready":true}'
FROM lt_shop;
SELECT setval(pg_get_serial_sequence('"Shop"', 'num'), (SELECT max(num) FROM lt_shop));
INSERT INTO "FactKey" ("key") SELECT 'gid://shopify/Location/' || (s.num * 100 + j) FROM lt_shop s, generate_series(1, s.locations) j ORDER BY 1;
INSERT INTO "FactKey" ("key") VALUES ('Online Store'), ('Point of Sale'), ('Shop'), ('direct'), ('google'), ('facebook'), ('email');
CREATE TABLE lt_loc AS SELECT s.num AS shop, g.j, k.num AS loc FROM lt_shop s CROSS JOIN LATERAL generate_series(1, s.locations) AS g(j) JOIN "FactKey" k ON k.key = 'gid://shopify/Location/' || (s.num * 100 + g.j);
INSERT INTO "Location" ("id", "shop", "name", "active", "online", "role")
SELECT 'gid://shopify/Location/' || (shop * 100 + j), 'loadtest-' || shop || '.myshopify.com', 'Location ' || j, true, true, CASE WHEN j = 1 THEN 'warehouse' ELSE 'store' END FROM lt_loc;`,
  );
  step(
    "variants",
    `
INSERT INTO "Variant" ("id", "shop", "productId", "productTitle", "variantTitle", "handle", "sku", "vendor", "productType", "collections", "tracked", "isBundle", "status", "productCreatedAt", "cost", "costCurrency", "price", "updatedAt", "firstStockDay", "firstSaleDay", "lastSaleDay")
SELECT 'gid://shopify/ProductVariant/' || (s.num::bigint * 1000000 + i), 'loadtest-' || s.num || '.myshopify.com',
  'gid://shopify/Product/' || (s.num::bigint * 1000000 + i / 5), 'Product ' || (i / 5), 'Size ' || (i % 5), 'product-' || (i / 5), 'SKU-' || i, 'Vendor ' || (i % 7),
  'Type ' || (i % 20), ARRAY['gid://shopify/Collection/' || (s.num * 1000 + i % 30)], true, false, 'ACTIVE', now() - interval '800 days', 9.5, 'EUR', 25, now(),
  '${STOCK_FROM}'::date, '${SALES_FROM}'::date, '${YESTERDAY}'::date
FROM lt_shop s, generate_series(1, s.variants) i;`,
  );
  step(
    "stock now",
    `
INSERT INTO "StockNow" ("shop", "variantId", "locationId", "available", "incoming", "committed", "onHand", "updatedAt")
SELECT 'loadtest-' || s.num || '.myshopify.com', 'gid://shopify/ProductVariant/' || (s.num::bigint * 1000000 + i), 'gid://shopify/Location/' || (s.num * 100 + j), (i * 7 + j) % 40, 0, 0, (i * 7 + j) % 40, now()
FROM lt_shop s, generate_series(1, s.variants) i, generate_series(1, s.locations) j;`,
  );
  // 1,024 month arrays of plausible ending units (values 0–60, some sold-out runs). Written one
  // shop and month at a time, in variant order — the physical order the sync's writes produce.
  step(
    "stock pool",
    `CREATE TABLE lt_pool AS
SELECT k, array_agg(v ORDER BY d) AS arr, sum(CASE WHEN v <= 0 THEN 1 << (d - 1) ELSE 0 END)::int AS mask
FROM (SELECT k, d, greatest(0, ((k * 37 + d * 11) % 70) - 9) AS v FROM generate_series(0, 1023) k, generate_series(1, 31) d) x GROUP BY k;`,
  );
  const months: string[] = [];
  for (let m = STOCK_FROM; m <= monthOf(YESTERDAY); m = addMonths(m, 1)) months.push(m);
  const started = Date.now();
  for (const p of plan) {
    guardDisk();
    const parts = months.map((m) => {
      const current = m === monthOf(YESTERDAY);
      const last = current ? Number(YESTERDAY.slice(8, 10)) : Number(addDays(addMonths(m, 1), -1).slice(8, 10));
      return `INSERT INTO "StockMonth" ("variantNum", "shopNum", "month", "locNum", "outMask", "firstDay", "lastDay", "endUnits")
SELECT ${p.num}::bigint * 1000000 + i, ${p.num}, '${m}'::date, l.loc, p.mask & ${last === 31 ? -1 : (1 << last) - 1}, 1, ${last}, p.arr[1:${last}] || array_fill(NULL::int4, ARRAY[${31 - last}])
FROM generate_series(1, ${p.k.variants}) i CROSS JOIN (SELECT j, loc FROM lt_loc WHERE shop = ${p.num} ORDER BY j) l
JOIN lt_pool p ON p.k = ((${p.num}::bigint * 7919 + i::bigint * 104729 + l.j * 31 + ${Number(m.slice(5, 7))}) % 1024);`;
    });
    psql(DB, `SET synchronous_commit = off;\n${parts.join("\n")}`);
  }
  t["stock history (StockMonth)"] = Date.now() - started;
  log("stock history (StockMonth)", `${t["stock history (StockMonth)"]} ms`);
  // Sales: a variant sells on `density` ‰ of days; location view (online, + a store on M / L),
  // channel view (Online Store, + Point of Sale on M / L).
  step(
    "sales history (SalesFact)",
    `
CREATE TEMP TABLE lt_ch AS SELECT (SELECT num FROM "FactKey" WHERE key = 'Online Store') AS web, (SELECT num FROM "FactKey" WHERE key = 'Point of Sale') AS pos;
INSERT INTO "SalesFact" ("variantNum", "grossCents", "shopNum", "day", "locNum", "channelNum", "sold", "returned")
SELECT x.v, r.g, x.shop, x.d, r.loc, r.ch, r.sold, 0 FROM (
  SELECT s.num::bigint * 1000000 + i AS v, s.num AS shop, d::date AS d, 1 + ((i + extract(doy from d)::int) % 3) AS sold, l2.loc AS store, i
  FROM lt_shop s
  LEFT JOIN lt_loc l2 ON l2.shop = s.num AND l2.j = 2
  CROSS JOIN generate_series(1, s.variants) i
  CROSS JOIN generate_series('${SALES_FROM}'::date, '${YESTERDAY}'::date, interval '1 day') d
  WHERE ((s.num::bigint * 1000000 + i) * 2654435761 + (d::date - '2000-01-01'::date) * 40503) % 1000 < s.density
) x
CROSS JOIN lt_ch c
CROSS JOIN LATERAL (VALUES
  (1, 0, x.sold, 0::bigint),
  (CASE WHEN x.store IS NOT NULL AND x.i % 2 = 0 THEN x.store END, 0, 1, 0::bigint),
  (0, c.web, x.sold, x.sold * 2500::bigint),
  (CASE WHEN x.store IS NOT NULL AND x.i % 2 = 0 THEN 0 END, c.pos, 1, 1999::bigint)
) AS r(loc, ch, sold, g)
WHERE r.loc IS NOT NULL;`,
  );
  step(
    "visits (SessionsFact)",
    `
INSERT INTO "SessionsFact" ("shopNum", "day", "trafficNum", "sessions", "checkouts", "landingPath")
SELECT s.num, d::date, t.num, 1 + (p * 7 + extract(doy from d)::int) % 40, (p + extract(doy from d)::int) % 3, '/products/product-' || p
FROM lt_shop s CROSS JOIN generate_series(1, s.paths) p CROSS JOIN generate_series('${SALES_FROM}'::date, '${YESTERDAY}'::date, interval '1 day') d
JOIN "FactKey" t ON t.key = CASE WHEN p % 2 = 0 THEN 'google' ELSE 'direct' END;
INSERT INTO "ShopDaily" ("shop", "day", "orders", "gross")
SELECT 'loadtest-' || s.num || '.myshopify.com', d::date, 10, 250 FROM lt_shop s CROSS JOIN generate_series('${SALES_FROM}'::date, '${YESTERDAY}'::date, interval '1 day') d;`,
  );
  // A realistic slim inputs document (~1.2 KB, as lib/metric-store-shared stores it).
  const inputs = JSON.stringify({
    historyDays: 90, inStockDays: 88, enoughData: true,
    windows: [{ days: 28, weight: 0.5, inStockDays: 28, rate: 2.0772089182493803, used: true }, { days: 56, weight: 0.3, inStockDays: 56, rate: 2.059454995871181, used: true }, { days: 90, weight: 0.2, inStockDays: 88, rate: 2.0381502890173384, used: true }],
    seasonal: 1.0759460695946261, trend: 1, plan: 1, leadTimeDays: 30, leadTimeSource: "supplier", cycleDays: 14, z: 1.65, onHand: 85, incoming: 24, caseQty: 6, minOrder: 10, orderNeed: null,
    sellsWhenOut: false, pace: null, outSince: null, lastSaleDay: YESTERDAY, dataSinceDay: null, offSeason: false, noReorder: false, productCreatedDay: "2024-08-01", price: 23, priceSource: "input", cost: 9, costSource: "input",
    season: { level: "store", collectionId: null, productType: null, seasonalApplied: true, seasonalReason: "ok", seasonalYears: 1, seasonalWeight: 0.5, horizonDays: 44, trendApplied: false, trendReason: "off", trendMeasured: 0.8592501536570376, trendMode: "off", trendNote: "Not applied: the growth assumption is off", label: null },
    safetyLevel: "balanced", serviceLevel: 0.95, supplierId: "sup1", kehaOnOrder: 0, kehaOrders: [], safety: 6.388917300982472, seasonCurve: [1.02, 1.05, 1.1, 1.2, 1.31, 1.25, 1.1, 1.0, 0.95, 0.9, 0.92, 0.97, 1.01], arrivals: [], today: YESTERDAY,
  }).replace(/'/g, "''");
  step(
    "metrics (VariantMetric, MetricRun, VariantLocationDays)",
    `
INSERT INTO "VariantMetric" ("shop", "variantId", "scope", "rate", "sigma", "daysLeft", "neverRunsOut", "status", "role", "orderQty", "orderBy", "computedAt", "inputs", "contentHash")
SELECT 'loadtest-' || s.num || '.myshopify.com', 'gid://shopify/ProductVariant/' || (s.num::bigint * 1000000 + i), 'online', 2.05 + (i % 13) / 10.0, 0.8, 30 + i % 60, false,
  (ARRAY['healthy','low','out','too_much','dead','not_enough_data'])[1 + i % 6], (ARRAY['A','B','C','C'])[1 + i % 4], CASE WHEN i % 3 = 0 THEN 12 END, CURRENT_DATE + (i % 120), now(),
  jsonb_set('${inputs}'::jsonb, '{onHand}', to_jsonb(i % 90)), md5(i::text)
FROM lt_shop s, generate_series(1, s.variants) i;
-- Pro stores (30 % of M / L): one metric per variant and location too.
INSERT INTO "VariantMetric" ("shop", "variantId", "scope", "rate", "sigma", "daysLeft", "neverRunsOut", "status", "role", "orderQty", "orderBy", "computedAt", "inputs", "contentHash")
SELECT 'loadtest-' || s.num || '.myshopify.com', 'gid://shopify/ProductVariant/' || (s.num::bigint * 1000000 + i), 'gid://shopify/Location/' || (s.num * 100 + j), 0.5, 0.3, 40, false,
  'healthy', 'B', NULL, NULL, now(), jsonb_set('${inputs}'::jsonb, '{onHand}', to_jsonb(i % 90)), md5(i::text || j)
FROM lt_shop s, generate_series(1, s.variants) i, generate_series(1, s.locations) j
WHERE s.klass <> 'S' AND s.num % 10 < 3;
INSERT INTO "MetricRun" ("shop", "scope", "startedAt", "finishedAt", "rows", "changed")
SELECT "shop", "scope", max("computedAt"), max("computedAt"), count(*)::int, 0 FROM "VariantMetric" GROUP BY 1, 2;
INSERT INTO "VariantLocationDays" ("shop", "variantId", "locationKey", "firstStockDay", "lastSaleDay")
SELECT 'loadtest-' || s.num || '.myshopify.com', 'gid://shopify/ProductVariant/' || (s.num::bigint * 1000000 + i), 'gid://shopify/Location/' || (s.num * 100 + j), '${STOCK_FROM}'::date, '${YESTERDAY}'::date
FROM lt_shop s, generate_series(1, s.variants) i, generate_series(1, s.locations) j;`,
  );
  step("vacuum analyze", `VACUUM (ANALYZE);`);
  return t;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

const APP_TABLES = ["SalesFact", "StockMonth", "SessionsFact", "ShopDaily", "Variant", "StockNow", "VariantMetric", "VariantLocationDays", "Location", "Shop", "FactKey", "MetricRun"];

function sizes(): Record<string, { bytes: number; rows: number }> {
  const out: Record<string, { bytes: number; rows: number }> = {};
  for (const t of APP_TABLES) {
    const partitioned = (FACT_TABLES as readonly string[]).includes(t);
    const bytes = Number(
      one(DB, partitioned ? `SELECT coalesce(sum(pg_total_relation_size(relid)), 0) FROM pg_partition_tree('"${t}"') WHERE isleaf` : `SELECT pg_total_relation_size('"${t}"')`),
    );
    const rows = Number(one(DB, `SELECT count(*) FROM "${t}"`));
    out[t] = { bytes, rows };
  }
  return out;
}

/** Bytes per row of the legacy daily layout and of compact daily stock rows, measured on one M store's 90 days. */
function layoutComparison(shopNum: number): Record<string, number> {
  const shop = `loadtest-${shopNum}.myshopify.com`;
  const from = addDays(TODAY, -90);
  psql(
    DB,
    `
SET work_mem = '256MB';
TRUNCATE "SalesDaily", "StockDaily";
INSERT INTO "SalesDaily" SELECT '${shop}', s."day", 'gid://shopify/ProductVariant/' || s."variantNum", lk.key, ck.key, s."sold", s."returned", s."grossCents" / 100.0
FROM "SalesFact" s JOIN "FactKey" lk ON lk.num = s."locNum" JOIN "FactKey" ck ON ck.num = s."channelNum" WHERE s."shopNum" = ${shopNum} AND s."day" >= '${from}';
INSERT INTO "StockDaily" SELECT '${shop}', s."month" + (u.i::int - 1), 'gid://shopify/ProductVariant/' || s."variantNum", lk.key, u.e, ((s."outMask" >> (u.i::int - 1)) & 1) = 1
FROM "StockMonth" s CROSS JOIN LATERAL unnest(s."endUnits") WITH ORDINALITY u(e, i) JOIN "FactKey" lk ON lk.num = s."locNum"
WHERE s."shopNum" = ${shopNum} AND u.e IS NOT NULL AND s."month" + (u.i::int - 1) >= '${from}';
DROP TABLE IF EXISTS lt_stock_daily_compact;
CREATE TABLE lt_stock_daily_compact ("variantNum" bigint NOT NULL, "shopNum" int NOT NULL, "day" date NOT NULL, "locNum" int NOT NULL, "endUnits" int NOT NULL, "outOfStock" bool NOT NULL, PRIMARY KEY ("shopNum", "variantNum", "locNum", "day"));
INSERT INTO lt_stock_daily_compact SELECT s."variantNum", s."shopNum", s."month" + (u.i::int - 1), s."locNum", u.e, ((s."outMask" >> (u.i::int - 1)) & 1) = 1
FROM "StockMonth" s CROSS JOIN LATERAL unnest(s."endUnits") WITH ORDINALITY u(e, i) WHERE s."shopNum" = ${shopNum} AND u.e IS NOT NULL AND s."month" + (u.i::int - 1) >= '${from}';
VACUUM ANALYZE "SalesDaily", "StockDaily", lt_stock_daily_compact;`,
  );
  const per = (t: string) => Number(one(DB, `SELECT pg_total_relation_size('${t}')::float / greatest(1, (SELECT count(*) FROM ${t}))`));
  const stockDays = Number(one(DB, `SELECT count(*) FROM "StockDaily"`));
  const monthRows = Number(one(DB, `SELECT sum(cardinality(array_remove("endUnits", NULL))) FROM "StockMonth" WHERE "shopNum" = ${shopNum}`));
  const monthBytes = Number(one(DB, `SELECT sum(pg_column_size(t.*)) FROM "StockMonth" t WHERE "shopNum" = ${shopNum}`));
  const salesFactPer = Number(one(DB, `SELECT coalesce(sum(pg_total_relation_size(relid)), 0)::float FROM pg_partition_tree('"SalesFact"') WHERE isleaf`)) / Number(one(DB, `SELECT count(*) FROM "SalesFact"`));
  const stockMonthPer = Number(one(DB, `SELECT coalesce(sum(pg_total_relation_size(relid)), 0)::float FROM pg_partition_tree('"StockMonth"') WHERE isleaf`)) / Number(one(DB, `SELECT sum(cardinality(array_remove("endUnits", NULL))) FROM "StockMonth"`));
  const res = {
    legacySalesDailyBytesPerRow: r1(per(`"SalesDaily"`)),
    legacyStockDailyBytesPerRow: r1(per(`"StockDaily"`)),
    compactStockDailyBytesPerRow: r1(per("lt_stock_daily_compact")),
    salesFactBytesPerRow: r1(salesFactPer),
    stockMonthBytesPerStockDay: r1(stockMonthPer),
    stockMonthTupleBytesPerDay_thisStore: r1(monthBytes / Math.max(1, monthRows)),
    legacyRowsMeasured: stockDays,
  };
  psql(DB, `TRUNCATE "SalesDaily", "StockDaily"; DROP TABLE lt_stock_daily_compact;`);
  return res;
}

type StoreCtx = { num: number; k: Klass; shop: string; variants: string[]; locations: string[]; keyNum: (k: string) => number | undefined };

function storeCtx(num: number, k: Klass): StoreCtx {
  const shop = `loadtest-${num}.myshopify.com`;
  const keys = new Map<string, number>();
  for (const line of psql(DB, `SELECT key || '|' || num FROM "FactKey";`).trim().split("\n")) {
    const i = line.lastIndexOf("|");
    keys.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  const variants = Array.from({ length: k.variants }, (_, i) => `gid://shopify/ProductVariant/${num * 1000000 + i + 1}`);
  const locations = Array.from({ length: k.locations }, (_, j) => `gid://shopify/Location/${num * 100 + j + 1}`);
  return { num, k, shop, variants, locations, keyNum: (x) => keys.get(x) };
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
function read(ctx: StoreCtx, table: FactTableName, op: ReadOp): string {
  const b = buildRead(table, op, { shopNum: ctx.num, keyNum: ctx.keyNum });
  return bind(b.sql, b.params);
}

/** The reads (and the metric writes) of one computeShop on this store, as SQL. */
function computeStatements(ctx: StoreCtx): string[] {
  const shop = ctx.shop;
  const range = { gte: d(addDays(TODAY, -90)), lte: d(YESTERDAY) };
  const st: string[] = [];
  const v = (sql: string, params: unknown[]) => bind(sql, params);
  // Catalog, locations, suppliers, open POs, money row.
  st.push(v(`SELECT * FROM "Location" WHERE "shop" = $1`, [shop]));
  st.push(v(`SELECT "id","productId","handle","vendor","collections","productType","tracked","isBundle","cost","price","productCreatedAt","caseQty","supplierId","status","noReorder","inventoryPolicy","firstStockDay","firstSaleDay","lastSaleDay" FROM "Variant" WHERE "shop" = $1`, [shop]));
  st.push(v(`SELECT * FROM "PurchaseOrder" WHERE "shop" = $1 AND "status" = ANY($2::text[])`, [shop, ["sent", "confirmed"]]));
  // Shop-wide: 90-day revenue, season store series + 12-month units, product types, last year ahead, traffic.
  st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["variantId"], where: { shop, locationKey: "all", day: range }, _sum: { gross: true } }));
  st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["day"], where: { shop, locationKey: "all", day: { gte: d(addDays(TODAY, -846)), lte: d(YESTERDAY) } }, _sum: { sold: true } }));
  st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["variantId"], where: { shop, locationKey: "all", day: { gte: d(addDays(TODAY, -365)), lte: d(YESTERDAY) } }, _sum: { sold: true } }));
  const q = productTypeSeriesQuery({
    shop,
    demand: { view: "channel" },
    types: ["Type 1", "Type 2", "Type 3"],
    windows: [{ from: addDays(TODAY, -846), to: addDays(TODAY, -300) }, { from: addDays(TODAY, -28), to: YESTERDAY }],
  })!;
  st.push(bind(q.sql, q.params));
  st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["variantId"], where: { shop, locationKey: "all", day: { gte: d(addDays(TODAY, -364)), lte: d(addDays(TODAY, -275)) } }, _sum: { sold: true } }));
  st.push(read(ctx, "sessionsDaily", { op: "groupBy", by: ["landingPath", "day"], where: { shop, day: { gte: d(addDays(TODAY, -30)), lte: d(YESTERDAY) } }, _sum: { sessions: true, checkouts: true } }));
  st.push(v(`SELECT "orders", "gross" FROM "ShopDaily" WHERE "shop" = $1 AND "day" >= $2::date AND "day" <= $3::date`, [shop, addDays(TODAY, -30), YESTERDAY]));
  // Per chunk of 2,000 variants (COMPUTE_CHUNK).
  for (let i = 0; i < ctx.variants.length; i += 2000) {
    const ids = ctx.variants.slice(i, i + 2000);
    const inChunk = { in: ids };
    st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["variantId", "day"], where: { shop, locationKey: "all", variantId: inChunk, day: range }, _sum: { sold: true, gross: true, returned: true } }));
    st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["variantId", "day"], where: { shop, locationKey: "all", variantId: inChunk, day: range }, _sum: { sold: true } }));
    // Stock: the store fetches the month rows (index work) and expands the days in JS (measured apart).
    // (Sum + count and out-of-stock days fetch the same month rows: the store reads them once.)
    st.push(stockFetch(ctx, { shop, locationId: { in: ctx.locations }, variantId: inChunk, day: range }));
    st.push(v(`SELECT "variantId", "onHand", "available", "incoming" FROM "StockNow" WHERE "shop" = $1 AND "locationId" = ANY($2::text[]) AND "variantId" = ANY($3::text[])`, [shop, ctx.locations, ids]));
    st.push(v(`SELECT "variantId", "locationKey", "firstStockDay", "lastSaleDay" FROM "VariantLocationDays" WHERE "shop" = $1 AND "variantId" = ANY($2::text[])`, [shop, ids]));
    // A few exact last-sale lookups and the older series of 20 variants out of stock most of the window.
    for (const id of ids.slice(0, 10)) st.push(read(ctx, "salesDaily", { op: "findMany", where: { shop, variantId: id, locationKey: "all", sold: { gt: 0 }, day: { lt: range.gte } }, orderBy: { day: "desc" }, select: { day: true }, take: 1 }));
    const older = ids.slice(0, 20);
    const oRange = { gte: d(addDays(TODAY, -427)), lt: range.gte };
    st.push(read(ctx, "salesDaily", { op: "groupBy", by: ["variantId", "day"], where: { shop, locationKey: "all", variantId: { in: older }, day: oRange }, _sum: { sold: true } }));
    st.push(stockFetch(ctx, { shop, locationId: { in: ctx.locations }, variantId: { in: older }, day: oRange }));
    // VariantMetric: the stored hashes of each 1,000, then ~30 % of the rows changed (delete + insert).
    for (let j = 0; j < ids.length; j += 1000) {
      const batch = ids.slice(j, j + 1000);
      st.push(v(`SELECT "variantId", "contentHash" FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online' AND "variantId" = ANY($2::text[])`, [shop, batch]));
      const changed = batch.filter((_, n) => n % 10 < 3);
      st.push(
        `BEGIN; ${v(`DELETE FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online' AND "variantId" = ANY($2::text[])`, [shop, changed])}; ` +
          v(
            `INSERT INTO "VariantMetric" ("shop","variantId","scope","rate","sigma","daysLeft","neverRunsOut","status","role","orderQty","orderBy","computedAt","inputs","contentHash")
             SELECT $1, x, 'online', 2.1, 0.8, 31, false, 'healthy', 'B', NULL, CURRENT_DATE + 30, now(), (SELECT "inputs" FROM "VariantMetric" WHERE "shop" = $1 LIMIT 1), md5(x) FROM unnest($2::text[]) x`,
            [shop, changed],
          ) +
          "; COMMIT",
      );
    }
  }
  // The sweep: every variant id of the scope.
  st.push(v(`SELECT "variantId" FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online'`, [shop]));
  return st;
}

/** The nightly sync's one-day writes for this store (yesterday re-read, nothing changed + 5 % changed). */
function syncWriteStatements(ctx: StoreCtx): { label: string; sql: string }[] {
  const day = YESTERDAY;
  const month = monthOf(day);
  const a = Number(day.slice(8, 10));
  const stock: EncodedStock[] = [];
  for (let i = 0; i < ctx.variants.length; i++)
    for (let j = 0; j < ctx.locations.length; j++) stock.push({ variantNum: variantNum(ctx.variants[i]!)!, locNum: ctx.keyNum(ctx.locations[j]!)!, day, endUnits: i % 40 === 0 ? 999 : (i * 3 + j) % 50, outOfStock: false });
  const sales: EncodedSales[] = [];
  for (let i = 0; i < ctx.variants.length; i += Math.round(1000 / ctx.k.density)) sales.push({ variantNum: variantNum(ctx.variants[i]!)!, locNum: 1, channelNum: 0, day, sold: 2, returned: 0, grossCents: "0" });
  const tx = (stmts: { sql: string; params: unknown[] }[]) => `BEGIN; ${stmts.map((s) => bind(s.sql, s.params)).join(";\n")}; COMMIT`;
  return [
    { label: "stock day (first write)", sql: tx(stockReplace(ctx.num, month, a, a, stock)) },
    { label: "stock day (re-read, unchanged)", sql: tx(stockReplace(ctx.num, month, a, a, stock)) },
    { label: "sales day", sql: tx(salesReplace(ctx.num, day, day, sales)) },
    { label: "sales day (re-read, unchanged)", sql: tx(salesReplace(ctx.num, day, day, sales)) },
  ];
}

/** The store's fetch of the StockMonth rows a stock read can match. */
function stockFetch(ctx: StoreCtx, where: Record<string, unknown>): string {
  const b = buildStockFetch(where, { shopNum: ctx.num, keyNum: ctx.keyNum });
  return bind(b.sql, b.params);
}

/**
 * The in-memory part of one compute chunk's stock reads (lib/facts-eval-shared over the fetched
 * month rows): the pooled sum + count and the out-of-stock count of 2,000 variants × 90 days.
 * Rows are fetched once with psql (outside the timing), as Prisma would hand them over.
 */
function stockJsMs(ctx: StoreCtx): { rows: number; ms: number } {
  const ids = ctx.variants.slice(0, 2000);
  const range = { gte: d(addDays(TODAY, -90)), lte: d(YESTERDAY) };
  const where = { shop: ctx.shop, locationId: { in: ctx.locations }, variantId: { in: ids }, day: range };
  const csv = psql(DB, `COPY (${stockFetch(ctx, where)}) TO STDOUT WITH (FORMAT csv);`).trim().split("\n");
  const locKey = new Map<number, string>();
  for (const l of ctx.locations) locKey.set(ctx.keyNum(l)!, l);
  const rows = csv.map((line) => {
    const m = line.match(/^(\d+),(\d+),([0-9-]+),(-?\d+),"?\{(.*)\}"?$/)!;
    return { v: m[1]!, loc: Number(m[2]), month: m[3]!.slice(0, 7), mask: Number(m[4]), units: m[5]!.split(",").map((x) => (x === "NULL" ? null : Number(x))) };
  });
  const started = performance.now();
  // As the store does it: decode the month rows, then the fast evaluator.
  const months: StockMonthRow[] = rows.map((r) => ({ variantId: `gid://shopify/ProductVariant/${r.v}`, locationId: locKey.get(r.loc)!, month: r.month, mask: r.mask, units: r.units }));
  const a = evaluateStockMonths({ op: "groupBy", by: ["variantId", "day"], where, _sum: { endUnits: true }, _count: { _all: true } }, ctx.shop, months);
  const b = evaluateStockMonths({ op: "groupBy", by: ["variantId", "day"], where: { ...where, outOfStock: true }, _count: { _all: true } }, ctx.shop, months);
  if (a === undefined || b === undefined) throw new Error("stock reads did not take the fast path");
  return { rows: rows.length, ms: Math.round(performance.now() - started) };
}

/** The store's newest-month probe for the latest stock day (one month: the data is current). */
function stockLatest(ctx: StoreCtx, month: string): string {
  const b = buildStockLatestInMonth({ shop: ctx.shop, locationId: { in: ctx.locations } }, month, { shopNum: ctx.num, keyNum: ctx.keyNum });
  return bind(b.sql, b.params);
}

/** Page loads: the reads behind Products, the order plan, the product page and the Dashboard. */
function pageStatements(ctx: StoreCtx, n: number): Record<string, string[]> {
  const shop = ctx.shop;
  const v = (sql: string, params: unknown[]) => bind(sql, params);
  const pick = (i: number) => ctx.variants[(i * 7919) % ctx.variants.length]!;
  const out: Record<string, string[]> = { products: [], orderPlan: [], productPage: [], dashboard: [], alertsLastStockDay: [] };
  for (let i = 0; i < n; i++) {
    const page = ctx.variants.slice((i * 50) % ctx.variants.length, ((i * 50) % ctx.variants.length) + 50);
    out.products.push(
      `${v(`SELECT "variantId", "orderBy" FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online'`, [shop])}; ` +
        `${v(`SELECT count(*) FROM "Variant" WHERE "shop" = $1 AND "tracked" = true AND "isBundle" = false`, [shop])}; ` +
        `${v(`SELECT * FROM "Variant" WHERE "shop" = $1 AND "tracked" = true ORDER BY "productTitle", "id" LIMIT 50 OFFSET $2`, [shop, (i * 50) % ctx.variants.length])}; ` +
        `${v(`SELECT "variantId", "rate", "daysLeft", "status", "orderQty", "orderBy" FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online' AND "variantId" = ANY($2::text[])`, [shop, page])}; ` +
        v(`SELECT "variantId", sum("onHand"), sum("incoming") FROM "StockNow" WHERE "shop" = $1 AND "locationId" = ANY($2::text[]) AND "variantId" = ANY($3::text[]) GROUP BY 1`, [shop, ctx.locations, page]),
    );
    out.orderPlan.push(
      `${v(`SELECT min("computedAt") FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online'`, [shop])}; ` +
        `${v(
          `SELECT "variantId","status","rate","sigma","orderQty","orderBy","daysLeft","neverRunsOut","inputs","computedAt" FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online' AND "status" <> ALL($2::text[]) AND ("orderQty" > 0 OR "orderBy" <= $3::date)`,
          [shop, ["dead", "not_enough_data"], addDays(TODAY, 92)],
        )}; ` +
        v(`SELECT "variantId","status" FROM "VariantMetric" WHERE "shop" = $1 AND "scope" = 'online' AND ("status" = ANY($2::text[]) OR ("status" = 'out' AND "rate" IS NULL))`, [shop, ["dead", "not_enough_data"]]),
    );
    const id = pick(i);
    out.productPage.push(
      `${read(ctx, "salesDaily", { op: "groupBy", by: ["day"], where: { shop, variantId: id, locationKey: "all", day: { gte: d(addDays(TODAY, -90)), lt: d(TODAY) } }, _sum: { sold: true }, orderBy: { day: "asc" } })}; ` +
        `${stockFetch(ctx, { shop, variantId: id, locationId: { in: ctx.locations }, day: { gte: d(addDays(TODAY, -90)), lt: d(TODAY) } })}; ` +
        `${v(`SELECT * FROM "VariantMetric" WHERE "shop" = $1 AND "variantId" = $2 AND "scope" = 'online'`, [shop, id])}; ` +
        v(`SELECT sum("onHand"), sum("incoming") FROM "StockNow" WHERE "shop" = $1 AND "variantId" = $2 AND "locationId" = ANY($3::text[])`, [shop, id, ctx.locations]),
    );
    out.dashboard.push(
      `${read(ctx, "salesDaily", { op: "groupBy", by: ["day"], where: { shop }, orderBy: { day: "desc" }, take: 14 })}; ` +
        `${v(`SELECT count(*) FROM "Variant" WHERE "shop" = $1 AND "tracked" = true AND "isBundle" = false`, [shop])}; ` +
        v(`SELECT * FROM "MoneyAtStake" WHERE "shop" = $1 ORDER BY "day" DESC LIMIT 1`, [shop]),
    );
    // Alerts (hourly, not a page): the latest stock day over the pool — the store probes the newest month first.
    out.alertsLastStockDay.push(stockLatest(ctx, monthOf(YESTERDAY)));
  }
  return out;
}

/** One maintenance pass a month later: next month created, the oldest month dropped, per table. */
function maintenanceStatements(): string[] {
  const later = addMonths(monthOf(TODAY), 3);
  const st: string[] = [];
  for (const t of FACT_TABLES) {
    st.push(createPartitionSql(t, later));
    const oldest = one(DB, `SELECT min(c.relname) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = '${t}'`);
    const m = oldest.match(/_p(\d{4})(\d{2})$/);
    if (m) {
      const month = `${m[1]}-${m[2]}-01`;
      st.push(detachPartitionSql(t, month));
      st.push(dropPartitionSql(t, month));
    }
  }
  return st;
}

/** The purge of one shop, as the facts store does it: per table, the partitions holding its rows (one probe each), then batches of 50,000. */
function purge(ctx: StoreCtx): { ms: number; rows: number } {
  const started = Date.now();
  let rows = 0;
  for (const t of FACT_TABLES) {
    const names = psql(DB, `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = '${t}';`).trim().split("\n").filter(Boolean);
    const b = purgeProbeSql(names);
    const parts = b ? psql(DB, `${bind(b, [String(ctx.num)])};`).trim().split("\n").filter(Boolean) : [];
    for (const part of parts) {
      for (;;) {
        const out = psql(DB, `${bind(purgeBatchSql(part), [String(ctx.num)])};`, { quiet: false });
        const n = Number(out.match(/DELETE (\d+)/)?.[1] ?? 0);
        rows += n;
        if (n < PURGE_BATCH) break;
      }
    }
  }
  for (const t of ["VariantMetric", "VariantLocationDays", "StockNow", "Variant", "Location", "ShopDaily", "MetricRun"]) {
    const out = psql(DB, `DELETE FROM "${t}" WHERE "shop" = '${ctx.shop}';`, { quiet: false });
    rows += Number(out.match(/DELETE (\d+)/)?.[1] ?? 0);
  }
  return { ms: Date.now() - started, rows };
}

// ---------------------------------------------------------------------------

function main() {
  const freeGb = Number(execFileSync("df", ["-BG", "--output=avail", "/"], { encoding: "utf8" }).split("\n")[1]!.replace("G", "").trim());
  log(`stores ${STORES}, database ${DB}, ${freeGb} GB free`);
  const plan = shopPlan(STORES);
  // --reuse: measure a database a previous run kept (--keep), without generating again.
  const reuse = process.argv.includes("--reuse");
  if (!reuse) applyMigrations();
  const gen = reuse ? {} : generate(plan);
  const size = sizes();
  const totalBytes = sum(Object.values(size).map((s) => s.bytes));
  log("sizes", JSON.stringify(size));

  const sample = (name: string) => plan.find((p) => p.k.name === name)!;
  const mCtx = storeCtx(sample("M").num, sample("M").k);
  const layout = layoutComparison(mCtx.num);
  log("layout", JSON.stringify(layout));

  const setup = `SET work_mem = '16MB';`;
  const compute: Record<string, { statements: number; ms: number; p95ms: number; stockJsMsPerChunk: number; stockJsMsTotal: number; monthRowsPerChunk: number }> = {};
  const sync: Record<string, Record<string, number>> = {};
  const pages: Record<string, Record<string, { p50: number; p95: number }>> = {};
  for (const name of ["S", "M", "L"] as const) {
    const p = sample(name);
    const ctx = name === "M" ? mCtx : storeCtx(p.num, p.k);
    // Warm once (as a running database would be), then measure.
    const statements = computeStatements(ctx);
    timed(DB, statements.slice(0, 12), setup);
    const ms = timed(DB, statements, setup);
    if (process.argv.includes("--profile")) {
      // Statement → its timings (a BEGIN; …; COMMIT counts each part).
      const flat = statements.flatMap((x) => x.split(/;\s*(?=BEGIN|DELETE|INSERT|COMMIT)/));
      const top = flat.map((sql, i) => ({ ms: ms[i] ?? 0, sql: sql.replace(/\s+/g, " ").slice(0, 160) })).sort((a, b) => b.ms - a.ms).slice(0, 12);
      log(`top statements ${name}`, JSON.stringify(top, null, 1));
    }
    const js = stockJsMs(ctx);
    const chunks = Math.ceil(ctx.variants.length / 2000);
    compute[name] = { statements: ms.length, ms: Math.round(sum(ms)), p95ms: r1(pct(ms, 95)), stockJsMsPerChunk: js.ms, stockJsMsTotal: js.ms * chunks, monthRowsPerChunk: js.rows };
    log(`compute ${name}`, JSON.stringify(compute[name]));
    const w = syncWriteStatements(ctx);
    const wt = timed(DB, w.map((x) => x.sql), setup);
    // Each write is BEGIN; …; COMMIT: sum the statements of each.
    sync[name] = {};
    let k = 0;
    for (const x of w) {
      const parts = x.sql.split(";").length - 1;
      sync[name]![x.label] = Math.round(sum(wt.slice(k, k + parts + 1)));
      k += parts + 1;
    }
    log(`sync ${name}`, JSON.stringify(sync[name]));
    const ps = pageStatements(ctx, 30);
    pages[name] = {};
    for (const [label, list] of Object.entries(ps)) {
      const parts = list[0]!.split("; ").length;
      const t = timed(DB, list, setup);
      const perLoad: number[] = [];
      for (let i = 0; i < t.length; i += parts) perLoad.push(sum(t.slice(i, i + parts)));
      pages[name]![label] = { p50: r1(pct(perLoad, 50)), p95: r1(pct(perLoad, 95)) };
    }
    log(`pages ${name}`, JSON.stringify(pages[name]));
  }
  const maint = maintenanceStatements();
  const maintMs = Math.round(sum(timed(DB, maint)));
  log(`maintenance ${maintMs} ms (${maint.length} statements)`);
  const L = sample("L");
  const purged = SKIP_PURGE ? { ms: -1, rows: 0 } : purge(storeCtx(L.num, L.k));
  log(`purge of one L store ${JSON.stringify(purged)}`);

  const counts = Object.fromEntries(CLASSES.map((k) => [k.name, plan.filter((p) => p.k === k).length]));
  const result = {
    measuredAt: new Date().toISOString(),
    stores: STORES,
    mix: counts,
    postgres: one(DB, "SHOW server_version"),
    settings: { shared_buffers: one(DB, "SHOW shared_buffers"), work_mem: "16MB (session)", cpus: Number(execFileSync("nproc", { encoding: "utf8" }).trim()) },
    generationMs: gen,
    sizeBytes: size,
    totalBytes,
    projected: { stores1000GB: r1((totalBytes * (1000 / STORES)) / 1e9), stores5000GB: r1((totalBytes * (5000 / STORES)) / 1e9) },
    layout,
    computeMs: compute,
    nightlySyncWriteMs: sync,
    pageLoadMs: pages,
    maintenanceMs: maintMs,
    purgeL: purged,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!KEEP) psql("postgres", `DROP DATABASE IF EXISTS ${DB};`);
}

main();
