/**
 * Change-only batched upserts (lib/bulk-sql-shared, services/sync/catalog-writes.server) on a
 * real Postgres: the same rows again rewrite nothing (xmin and updatedAt unchanged), one changed
 * value rewrites one row, decimals compare by value, the merchant's own fields (supplier, case
 * pack, "Don't reorder") are never touched, chunks of any size give the same table, and StockNow
 * reconciles per variant and drops rows of variants gone from the catalog. Skipped without Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_AVAILABLE, dropDb, freshDb, psql } from "./helpers/pg";
import { psqlRunner } from "./helpers/pg-runner";
import { pgCatalogWriter } from "../app/services/sync/catalog-writes.server";
import { STOCK_NOW_TABLE, VARIANT_TABLE, bulkUpserts, toSqlText } from "../app/lib/bulk-sql-shared";
import type { StockLevelRow, VariantRow } from "../app/lib/sync/catalog-shared";

const DB = "r1db_bulk_pg";
const S = "acme.myshopify.com";
const run = PG_AVAILABLE ? describe : describe.skip;

const variant = (n: number, over: Partial<VariantRow> = {}): VariantRow => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productId: `gid://shopify/Product/${Math.ceil(n / 2)}`,
  productTitle: `Tee ${n}`,
  variantTitle: n % 2 ? "S" : "M",
  handle: "tee",
  sku: n === 3 ? null : `T-${n}`,
  vendor: "Acme",
  productType: "Shirts",
  collections: n === 2 ? [] : ["gid://shopify/Collection/1", 'quote "and" \\ slash'],
  image: null,
  tracked: true,
  isBundle: false,
  status: "ACTIVE",
  productCreatedAt: new Date("2025-01-02T03:04:05.678Z"),
  cost: "9.50",
  costCurrency: "EUR",
  price: "27.00",
  inventoryPolicy: n === 1 ? "CONTINUE" : null,
  ...over,
});
const stock = (v: number, loc: number, onHand: number): StockLevelRow => ({ variantId: `gid://shopify/ProductVariant/${v}`, locationId: `gid://shopify/Location/${loc}`, available: onHand, incoming: 0, committed: 0, onHand });
const stamps = (t: string) => psql(DB, `SELECT xmin::text AS x, "updatedAt"::text AS u FROM "${t}" ORDER BY 1, 2`);

run("change-only upserts on Postgres", () => {
  const runner = psqlRunner(DB);
  const w = pgCatalogWriter(runner);

  beforeAll(() => freshDb(DB));
  afterAll(() => dropDb(DB));

  it("variants: inserts, then rewrites nothing for the same rows, then only what changed", async () => {
    expect(await w.upsertVariants(S, [1, 2, 3].map((n) => variant(n)))).toBe(3);
    psql(DB, `UPDATE "Variant" SET "supplierId" = 'sup1', "caseQty" = 6, "noReorder" = true WHERE "id" = 'gid://shopify/ProductVariant/1'`);
    const before = stamps("Variant");
    // Same values — price "27.0" equals the stored 27.0000; collections equal element by element.
    expect(await w.upsertVariants(S, [1, 2, 3].map((n) => variant(n, { price: "27.0" })))).toBe(0);
    expect(stamps("Variant")).toEqual(before);
    expect(await w.upsertVariants(S, [variant(1), variant(2, { collections: ["gid://shopify/Collection/9"] }), variant(3, { price: "28.00" })])).toBe(2);
    const rows = psql(DB, `SELECT "id", "price"::text AS price, "collections"::text AS c, "supplierId", "caseQty"::text AS case, "noReorder"::text AS nr, "sku", "inventoryPolicy", "productCreatedAt"::text AS created FROM "Variant" ORDER BY "id"`);
    expect(rows).toEqual([
      { id: "gid://shopify/ProductVariant/1", price: "27.0000", c: '{gid://shopify/Collection/1,"quote \\"and\\" \\\\ slash"}', supplierId: "sup1", case: "6", nr: "true", sku: "T-1", inventoryPolicy: "CONTINUE", created: "2025-01-02 03:04:05.678" },
      { id: "gid://shopify/ProductVariant/2", price: "27.0000", c: "{gid://shopify/Collection/9}", supplierId: null, case: null, nr: "false", sku: "T-2", inventoryPolicy: null, created: "2025-01-02 03:04:05.678" },
      { id: "gid://shopify/ProductVariant/3", price: "28.0000", c: '{gid://shopify/Collection/1,"quote \\"and\\" \\\\ slash"}', supplierId: null, case: null, nr: "false", sku: null, inventoryPolicy: null, created: "2025-01-02 03:04:05.678" },
    ]);
    const after = stamps("Variant");
    expect(after.filter((r) => before.some((b) => b.x === r.x && b.u === r.u))).toHaveLength(1); // variant 1 untouched
  });

  it("chunks of any size give the same table", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ ...variant(100 + i), shop: S }));
    await runner.transaction(bulkUpserts(VARIANT_TABLE, rows, 3));
    expect(Number(psql(DB, `SELECT count(*) AS n FROM "Variant" WHERE "id" LIKE 'gid://shopify/ProductVariant/1__'`)[0]!.n)).toBe(11);
    expect(await runner.transaction(bulkUpserts(VARIANT_TABLE, rows, 4))).toEqual([0, 0, 0]);
  });

  it("stock now: idempotent, reconciled per variant, orphans dropped", async () => {
    expect(await w.upsertStockNow(S, [stock(1, 1, 5), stock(1, 2, 3), stock(2, 1, 0), stock(999, 1, 7)])).toBe(4);
    const before = stamps("StockNow");
    expect(await w.upsertStockNow(S, [stock(1, 1, 5), stock(1, 2, 3), stock(2, 1, 0)])).toBe(0);
    expect(stamps("StockNow")).toEqual(before);
    expect(await w.upsertStockNow(S, [stock(1, 1, 4)])).toBe(1);
    // Variant 1's levels now: only location 1 → its row at location 2 goes; variant 2 untouched.
    expect(await w.reconcileStockNow(S, ["gid://shopify/ProductVariant/1"], [stock(1, 1, 4)])).toBe(1);
    // Variant 999 is not in the catalog.
    expect(await w.removeOrphanStockNow(S)).toBe(1);
    expect(psql(DB, `SELECT "variantId", "locationId", "onHand"::text AS h FROM "StockNow" ORDER BY 1, 2`)).toEqual([
      { variantId: "gid://shopify/ProductVariant/1", locationId: "gid://shopify/Location/1", h: "4" },
      { variantId: "gid://shopify/ProductVariant/2", locationId: "gid://shopify/Location/1", h: "0" },
    ]);
    // A variant whose item lists no level any more loses every row.
    expect(await w.reconcileStockNow(S, ["gid://shopify/ProductVariant/2"], [])).toBe(1);
  });

  it("values travel as text", () => {
    expect(toSqlText(["a", null, 'b"c'], "text[]")).toBe('{"a",NULL,"b\\"c"}');
    expect(toSqlText(new Date("2026-10-17T01:02:03.004Z"), "timestamp(3)")).toBe("2026-10-17 01:02:03.004");
    expect(toSqlText(false, "bool")).toBe("false");
    expect(toSqlText(null, "int4")).toBeNull();
    expect(STOCK_NOW_TABLE.columns.filter((c) => c.key).map((c) => c.name)).toEqual(["shop", "variantId", "locationId"]);
  });
});
