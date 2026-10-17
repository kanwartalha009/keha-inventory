/**
 * Change-only batched upserts (DB scale "before 1,000 stores"): one statement per chunk of rows,
 * every column as one array parameter (unnest), and
 *   INSERT … ON CONFLICT (key) DO UPDATE SET … WHERE (stored values) IS DISTINCT FROM (new values)
 * so a row whose values did not change is not rewritten — no dead tuple, no index or WAL churn,
 * and `updatedAt` moves only when something changed (the order-plan cache keys on it). Pure: SQL
 * text and parameters (services/sync/catalog-writes.server runs them).
 *
 * Values travel as strings (or null) in text[] arrays and are cast in SQL, so the same text runs
 * through Prisma and psql; a text[] column travels as its array literal.
 */

export type BulkColumn = {
  name: string;
  /** Postgres type the text is cast to: text, int4, bool, numeric, timestamp(3), text[] … */
  type: string;
  /** Part of the conflict key. */
  key?: boolean;
  /** Written on insert only (never updated, never compared). */
  insertOnly?: boolean;
};

export type BulkTable = {
  table: string;
  columns: BulkColumn[];
  /** Set to the database clock (UTC, as Prisma stores DateTime) on insert and on a real change. */
  updatedAt?: string;
};

/** Rows per statement. */
export const BULK_CHUNK = 5000;

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const NOW = `(now() AT TIME ZONE 'UTC')`;

/** A JS value as the text Postgres casts back to the column's type (null stays null). */
export function toSqlText(v: unknown, type: string): string | null {
  if (v === null || v === undefined) return null;
  if (type.endsWith("[]")) {
    const items = (v as unknown[]).map((x) => (x === null || x === undefined ? "NULL" : `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`));
    return `{${items.join(",")}}`;
  }
  if (v instanceof Date) return v.toISOString().replace("T", " ").replace("Z", "");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** The upsert statement for a chunk of rows (objects keyed by column name). */
export function bulkUpsert(t: BulkTable, rows: readonly Record<string, unknown>[]): { sql: string; params: unknown[] } {
  const cols = t.columns;
  const params = cols.map((c) => rows.map((r) => toSqlText(r[c.name], c.type)));
  const alias = (i: number) => `c${i}`;
  const select = cols.map((c, i) => `${c.type.endsWith("[]") ? `n.${alias(i)}::${c.type}` : `n.${alias(i)}::${c.type}`}`);
  const names = cols.map((c) => q(c.name));
  const keys = cols.filter((c) => c.key).map((c) => q(c.name));
  const upd = cols.filter((c) => !c.key && !c.insertOnly);
  const set = upd.map((c) => `${q(c.name)} = EXCLUDED.${q(c.name)}`);
  if (t.updatedAt) set.push(`${q(t.updatedAt)} = ${NOW}`);
  const sql = `INSERT INTO ${q(t.table)} AS t (${[...names, ...(t.updatedAt ? [q(t.updatedAt)] : [])].join(", ")})
SELECT ${[...select, ...(t.updatedAt ? [NOW] : [])].join(", ")}
FROM unnest(${cols.map((_, i) => `$${i + 1}::text[]`).join(", ")}) AS n(${cols.map((_, i) => alias(i)).join(", ")})
ON CONFLICT (${keys.join(", ")}) DO ${
    upd.length
      ? `UPDATE SET ${set.join(", ")}
WHERE (${upd.map((c) => `t.${q(c.name)}`).join(", ")}) IS DISTINCT FROM (${upd.map((c) => `EXCLUDED.${q(c.name)}`).join(", ")})`
      : "NOTHING"
  }`;
  return { sql, params };
}

/** Chunks of BULK_CHUNK rows → statements. */
export function bulkUpserts(t: BulkTable, rows: readonly Record<string, unknown>[], chunk = BULK_CHUNK): { sql: string; params: unknown[] }[] {
  const out: { sql: string; params: unknown[] }[] = [];
  for (let i = 0; i < rows.length; i += chunk) out.push(bulkUpsert(t, rows.slice(i, i + chunk)));
  return out;
}

/** Variant: what the catalog sync writes (supplier, case pack, "Don't reorder" and the stored days are never touched). */
export const VARIANT_TABLE: BulkTable = {
  table: "Variant",
  columns: [
    { name: "id", type: "text", key: true },
    { name: "shop", type: "text" },
    { name: "productId", type: "text" },
    { name: "productTitle", type: "text" },
    { name: "variantTitle", type: "text" },
    { name: "handle", type: "text" },
    { name: "sku", type: "text" },
    { name: "vendor", type: "text" },
    { name: "productType", type: "text" },
    { name: "collections", type: "text[]" },
    { name: "image", type: "text" },
    { name: "tracked", type: "bool" },
    { name: "isBundle", type: "bool" },
    { name: "status", type: "text" },
    { name: "productCreatedAt", type: "timestamp(3)" },
    { name: "cost", type: "numeric(18,4)" },
    { name: "costCurrency", type: "text" },
    { name: "price", type: "numeric(18,4)" },
    { name: "inventoryPolicy", type: "text" },
  ],
  updatedAt: "updatedAt",
};

/** StockNow: one row per variant × location. */
export const STOCK_NOW_TABLE: BulkTable = {
  table: "StockNow",
  columns: [
    { name: "shop", type: "text", key: true },
    { name: "variantId", type: "text", key: true },
    { name: "locationId", type: "text", key: true },
    { name: "available", type: "int4" },
    { name: "incoming", type: "int4" },
    { name: "committed", type: "int4" },
    { name: "onHand", type: "int4" },
  ],
  updatedAt: "updatedAt",
};

/**
 * For the variants $2 (complete level lists just read): their StockNow rows at locations not in
 * ($3 variant, $4 location) pairs are removed. $1 = shop.
 */
export const SQL_STOCK_NOW_RECONCILE = `DELETE FROM "StockNow" s
WHERE s."shop" = $1::text AND s."variantId" = ANY($2::text[])
  AND NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) AS n(v, l) WHERE n.v = s."variantId" AND n.l = s."locationId")`;

/** StockNow rows of variants no longer in the catalog (the end of a stock-now pass). $1 = shop. */
export const SQL_STOCK_NOW_ORPHANS = `DELETE FROM "StockNow" s
WHERE s."shop" = $1::text AND NOT EXISTS (SELECT 1 FROM "Variant" v WHERE v."id" = s."variantId")`;
