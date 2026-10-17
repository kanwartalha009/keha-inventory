/**
 * The catalog sync's bulk writes (DB scale "before 1,000 stores"): Variant and StockNow rows in
 * chunks of BULK_CHUNK through one change-only upsert statement each (lib/bulk-sql-shared) —
 * unchanged rows are not rewritten and their updatedAt stays (the order-plan cache keys on
 * Variant.updatedAt: it now moves only when a variant really changed). StockNow is reconciled per
 * page instead of by updatedAt: the variants a page read have their rows at other locations
 * removed, and the end of a pass removes the rows of variants no longer in the catalog.
 *
 * `catalogWriter()` is Postgres through Prisma; tests swap it (setCatalogWriter) for the
 * in-memory one (tests/helpers/fake-facts) or psql.
 */
import { prismaRunner, type SqlRunner } from "../db/sql.server";
import { SQL_STOCK_NOW_ORPHANS, SQL_STOCK_NOW_RECONCILE, STOCK_NOW_TABLE, VARIANT_TABLE, bulkUpserts } from "../../lib/bulk-sql-shared";
import type { StockLevelRow, VariantRow } from "../../lib/sync/catalog-shared";

export interface CatalogWriter {
  /** Variant rows (catalog fields only); returns the rows inserted or changed. */
  upsertVariants(shop: string, rows: readonly VariantRow[]): Promise<number>;
  /** StockNow rows; returns the rows inserted or changed. */
  upsertStockNow(shop: string, rows: readonly StockLevelRow[]): Promise<number>;
  /** For `variantIds` (their complete levels just read as `rows`): rows at other locations go. */
  reconcileStockNow(shop: string, variantIds: readonly string[], rows: readonly StockLevelRow[]): Promise<number>;
  /** StockNow rows of variants no longer in the catalog. */
  removeOrphanStockNow(shop: string): Promise<number>;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function pgCatalogWriter(runner: SqlRunner): CatalogWriter {
  return {
    async upsertVariants(shop, rows) {
      if (!rows.length) return 0;
      return sum(await runner.transaction(bulkUpserts(VARIANT_TABLE, rows.map((r) => ({ ...r, shop })))));
    },
    async upsertStockNow(shop, rows) {
      if (!rows.length) return 0;
      return sum(await runner.transaction(bulkUpserts(STOCK_NOW_TABLE, rows.map((r) => ({ ...r, shop })))));
    },
    async reconcileStockNow(shop, variantIds, rows) {
      if (!variantIds.length) return 0;
      return runner.execute(SQL_STOCK_NOW_RECONCILE, [shop, [...variantIds], rows.map((r) => r.variantId), rows.map((r) => r.locationId)]);
    },
    async removeOrphanStockNow(shop) {
      return runner.execute(SQL_STOCK_NOW_ORPHANS, [shop]);
    },
  };
}

let current: CatalogWriter | null = null;

export function catalogWriter(): CatalogWriter {
  return (current ??= pgCatalogWriter(prismaRunner));
}

/** Tests: use another writer (null = back to Postgres). */
export function setCatalogWriter(w: CatalogWriter | null): void {
  current = w;
}
