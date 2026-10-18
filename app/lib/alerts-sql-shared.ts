/**
 * The hourly alerts job's database reads as SQL (perf 2026-10-18, "before 1,000 stores" #7). Pure:
 * statement text and parameters only; services/alerts.server runs them (Prisma $queryRawUnsafe),
 * the tests through psql on Postgres 16 and answered from the fake tables (tests/helpers/fake-raw).
 *
 * Before, every store's hourly run read EVERY online VariantMetric row and EVERY StockNow row of the
 * pool (300,000 rows on a 30,000-variant store with 10 locations) to find a handful of products.
 * Now Postgres aggregates and returns only the candidates; the rules (lib/alerts-shared,
 * lib/flow-shared) still run in JS on exactly the rows they read before:
 *  - SQL_FULLY_OUT_PRODUCTS: products whose every planned variant (tracked, active, not a bundle)
 *    has stock-now rows in the pool and Σ available ≤ 0 (fullyOut over the old outNow map);
 *  - SQL_ALERT_METRICS, one pass: the planned variants' online metrics a rule can use — A role with
 *    fewer than 365 days left (best seller running out: no lead time is longer), running low / out
 *    with an order quantity, days left and an order-by date ("Product needs reorder") — and the rows
 *    of products whose every planned variant with a metric is Dead ("Product became dead stock", `dead`).
 */

const PLANNED = `v."tracked" = true AND v."isBundle" = false AND v."status" = 'ACTIVE'`;

/** $1 shop, $2 pool location ids (text[]). → productId */
export const SQL_FULLY_OUT_PRODUCTS = `
SELECT v."productId"
FROM "Variant" v
LEFT JOIN (
  SELECT s."variantId", sum(s."available") AS "available"
  FROM "StockNow" s
  WHERE s."shop" = $1 AND s."locationId" = ANY($2::text[])
  GROUP BY s."variantId"
) n ON n."variantId" = v."id"
WHERE v."shop" = $1 AND ${PLANNED}
GROUP BY v."productId"
HAVING bool_and(n."available" IS NOT NULL AND n."available" <= 0)`;

/**
 * $1 shop, $2 scope — one pass over the shop's metrics. → variantId, productId, status, role,
 * daysLeft, orderQty, orderBy, computedAt, dead: the candidate rows of the instant and Flow rules,
 * and every row of a product whose every planned variant with a metric is Dead (dead = true).
 */
export const SQL_ALERT_METRICS = `
WITH m AS MATERIALIZED (
  SELECT m."variantId", v."productId", m."status", m."role", m."daysLeft", m."orderQty", m."orderBy", m."computedAt"
  FROM "VariantMetric" m
  JOIN "Variant" v ON v."id" = m."variantId" AND v."shop" = m."shop"
  WHERE m."shop" = $1 AND m."scope" = $2 AND ${PLANNED}
), dead AS (
  SELECT "productId" FROM m GROUP BY "productId" HAVING bool_and("status" = 'dead')
)
SELECT m.*, (d."productId" IS NOT NULL) AS "dead"
FROM m LEFT JOIN dead d ON d."productId" = m."productId"
WHERE d."productId" IS NOT NULL
  OR (m."role" = 'A' AND m."daysLeft" < 365)
  OR (m."status" IN ('running_low', 'out') AND m."orderQty" > 0 AND m."daysLeft" IS NOT NULL AND m."orderBy" IS NOT NULL)`;

/** A text[] parameter as Postgres reads it from a string (psql tests; Prisma binds JS arrays itself). */
export function textArrayLiteral(xs: readonly string[]): string {
  return `{${xs.map((x) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
