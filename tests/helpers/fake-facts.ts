/**
 * The facts store (services/facts-store.server) over the unit tests' in-memory Prisma
 * (fake-prisma): the old daily-row semantics, on `db.tables.salesDaily` / `stockDaily` /
 * `sessionsDaily`, so the tests keep seeding and asserting plain rows. Writes are "delete the
 * shop's rows in the range, insert the fresh ones" (what the Postgres store's change-only writes
 * must equal — tests/facts-store-pg.test.ts runs both); retention deletes rows day by day with the
 * same cutoffs as the partitioned store (lib/partitions-shared keepFrom).
 *
 * useFakeFacts(db) installs it; the readers are the fake's own delegates.
 */
import { setFactsStore, type FactReader, type FactsStore, type SalesDailyRow, type SessionsDailyRow, type StockDailyRow } from "../../app/services/facts-store.server";
import { keepFrom } from "../../app/lib/partitions-shared";
import { retentionCutoff } from "../../app/lib/sync/store-time-shared";
import type { FakeDb } from "./fake-prisma";

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

/** Installs the in-memory facts store over a fake Prisma; returns it. */
export function useFakeFacts(db: FakeDb | { client: Record<string, unknown> }): FactsStore {
  const store = delegateFactsStore(db.client);
  setFactsStore(store);
  return store;
}
