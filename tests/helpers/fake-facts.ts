/**
 * The facts store (services/facts-store.server) over the unit tests' in-memory Prisma
 * (fake-prisma): the old daily-row semantics, on `db.tables.salesDaily` / `stockDaily` /
 * `sessionsDaily`, so the tests keep seeding and asserting plain rows. Writes are "delete the
 * shop's rows in the range, insert the fresh ones" (what the Postgres store's change-only writes
 * must equal — tests/facts-store-pg.test.ts runs both); retention deletes rows day by day with the
 * same cutoffs as the partitioned store (lib/partitions-shared keepFrom).
 *
 * useFakeFacts(db) installs it (the readers are the fake's own delegates) and the in-memory
 * catalog writer (services/sync/catalog-writes.server): change-only Variant / StockNow upserts
 * with the same rules as the Postgres SQL (a row is rewritten, and its updatedAt moved, only when
 * a value changed), per-variant StockNow reconcile, orphan removal.
 */
import { setFactsStore, type FactReader, type FactsStore, type SalesDailyRow, type SessionsDailyRow, type StockDailyRow } from "../../app/services/facts-store.server";
import { keepFrom } from "../../app/lib/partitions-shared";
import { retentionCutoff } from "../../app/lib/sync/store-time-shared";
import type { FakeDb } from "./fake-prisma";
import { setCatalogWriter, type CatalogWriter } from "../../app/services/sync/catalog-writes.server";
import { STOCK_NOW_TABLE, VARIANT_TABLE, type BulkTable } from "../../app/lib/bulk-sql-shared";

type Delegate = {
  groupBy: (a: unknown) => Promise<unknown>;
  findMany: (a: unknown) => Promise<unknown>;
  findFirst: (a: unknown) => Promise<unknown>;
  aggregate: (a: unknown) => Promise<unknown>;
  count: (a: unknown) => Promise<number>;
  deleteMany?: (a: unknown) => Promise<{ count: number }>;
  createMany?: (a: unknown) => Promise<{ count: number }>;
};

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

/** A FactsStore over Prisma-like delegates (the fake's, or a test's own hand-written mocks). */
export function delegateFactsStore(client: Record<string, unknown>): FactsStore {
  const m = (name: string) => client[name] as Delegate;
  const replace = async (name: string, shop: string, range: { since: string; until: string }, rows: readonly Record<string, unknown>[]) => {
    await m(name).deleteMany!({ where: { shop, day: { gte: day(range.since), lte: day(range.until) } } });
    if (rows.length) await m(name).createMany!({ data: rows.map((r) => ({ shop, ...r, day: day(String(r.day)) })) });
  };
  return {
    salesDaily: m("salesDaily") as unknown as FactReader<SalesDailyRow>,
    stockDaily: m("stockDaily") as unknown as FactReader<StockDailyRow>,
    sessionsDaily: m("sessionsDaily") as unknown as FactReader<SessionsDailyRow>,
    replaceSales: (shop, range, rows) => replace("salesDaily", shop, range, rows),
    replaceStock: (shop, range, rows) => replace("stockDaily", shop, range, rows),
    replaceSessions: (shop, range, rows) => replace("sessionsDaily", shop, range, rows),
    async applyRetention(shop, today) {
      const sales = retentionCutoff(today);
      const stock = keepFrom("StockMonth", today);
      let removed = 0;
      removed += (await m("salesDaily").deleteMany!({ where: { shop, day: { lt: day(sales) } } })).count;
      removed += (await m("sessionsDaily").deleteMany!({ where: { shop, day: { lt: day(sales) } } })).count;
      removed += (await m("stockDaily").deleteMany!({ where: { shop, day: { lt: day(stock) } } })).count;
      return { removed, from: { stock, sales } };
    },
    async purgeShop(shop) {
      let n = 0;
      for (const t of ["salesDaily", "stockDaily", "sessionsDaily"]) n += (await m(t).deleteMany!({ where: { shop } })).count;
      return n;
    },
  };
}

type RowDelegate = {
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  create: (a: unknown) => Promise<unknown>;
  update: (a: unknown) => Promise<unknown>;
  deleteMany: (a: unknown) => Promise<{ count: number }>;
};

const same = (a: unknown, b: unknown) => {
  const n = (v: unknown) => (v instanceof Date ? v.getTime() : v !== null && typeof v === "object" && "toNumber" in (v as object) ? (v as { toNumber: () => number }).toNumber() : typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
};

/** The catalog writer over Prisma-like delegates (the fake's): what the Postgres upserts do, row by row. */
export function delegateCatalogWriter(client: Record<string, unknown>): CatalogWriter {
  const m = (name: string) => client[name] as RowDelegate;
  const upsert = async (t: BulkTable, delegate: string, rows: readonly Record<string, unknown>[]) => {
    let n = 0;
    const keys = t.columns.filter((c) => c.key).map((c) => c.name);
    const values = t.columns.filter((c) => !c.key && !c.insertOnly).map((c) => c.name);
    for (const r of rows) {
      const where = Object.fromEntries(keys.map((k) => [k, r[k]]));
      const [cur] = await m(delegate).findMany({ where });
      const data = Object.fromEntries(t.columns.map((c) => [c.name, r[c.name] ?? null]));
      if (!cur) {
        await m(delegate).create({ data: { ...data, updatedAt: new Date() } });
        n++;
      } else if (values.some((v) => !same(cur[v] ?? null, data[v]))) {
        const set = Object.fromEntries(values.map((v) => [v, data[v]]));
        await m(delegate).update({ where, data: { ...set, updatedAt: new Date() } });
        n++;
      }
    }
    return n;
  };
  return {
    upsertVariants: (shop, rows) => upsert(VARIANT_TABLE, "variant", rows.map((r) => ({ ...r, shop }))),
    upsertStockNow: (shop, rows) => upsert(STOCK_NOW_TABLE, "stockNow", rows.map((r) => ({ ...r, shop }))),
    async reconcileStockNow(shop, variantIds, rows) {
      const keep = new Set(rows.map((r) => `${r.variantId}|${r.locationId}`));
      const ids = new Set(variantIds);
      const existing = await m("stockNow").findMany({ where: { shop } });
      let n = 0;
      for (const e of existing) {
        if (!ids.has(String(e.variantId)) || keep.has(`${e.variantId}|${e.locationId}`)) continue;
        n += (await m("stockNow").deleteMany({ where: { shop, variantId: e.variantId, locationId: e.locationId } })).count;
      }
      return n;
    },
    async removeOrphanStockNow(shop) {
      const variants = new Set((await m("variant").findMany({ where: {} })).map((v) => String(v.id)));
      const existing = await m("stockNow").findMany({ where: { shop } });
      let n = 0;
      for (const e of existing) if (!variants.has(String(e.variantId))) n += (await m("stockNow").deleteMany({ where: { shop, variantId: e.variantId, locationId: e.locationId } })).count;
      return n;
    },
  };
}

/** Installs the in-memory facts store and catalog writer over a fake Prisma; returns the store. */
export function useFakeFacts(db: FakeDb | { client: Record<string, unknown> }): FactsStore {
  const store = delegateFactsStore(db.client);
  setFactsStore(store);
  setCatalogWriter(delegateCatalogWriter(db.client));
  return store;
}
