/**
 * The Postgres facts store (services/facts-store.server over lib/facts-sql-shared) against the
 * in-memory one the unit tests use (tests/helpers/fake-facts: the old daily-row semantics), on a
 * real Postgres: the same facts written to both, then every read shape the app uses compared
 * result for result. Also: rewriting the same facts changes no row (xmin unchanged), a changed /
 * removed / added fact is applied exactly, stock merges days into a month's array across writes,
 * id conversion at the boundary (GIDs, location keys, channels, cents), the shop purge, and
 * retention by dropping partitions (maintenance job). Skipped without a local Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_AVAILABLE, dropDb, freshDb, psql } from "./helpers/pg";
import { psqlRunner } from "./helpers/pg-runner";
import { createFakePrisma } from "./helpers/fake-prisma";
import { delegateFactsStore } from "./helpers/fake-facts";
import { pgFactsStore, type FactsStore } from "../app/services/facts-store.server";
import { forgetPartitions, listPartitions, maintainPartitions } from "../app/services/partitions.server";
import { addDays } from "../app/lib/sync/shopifyql-shared";
import { addMonths, monthOf } from "../app/lib/ids-shared";
import { partitionName } from "../app/lib/partitions-shared";
import type { SalesFact, SessionsFact, StockFact } from "../app/lib/sync/facts-shared";

const DB = "r1db_facts_pg";
const A = "alpha.myshopify.com";
const B = "beta.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${45000000000000 + n}`;
const L = (n: number) => `gid://shopify/Location/${98000000000 + n}`;
const TODAY = new Date().toISOString().slice(0, 10);
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Deterministic pseudo-random facts over `days` days ending yesterday. */
function facts(seed: number, days: number, variants: number, opts: { skip?: (v: number, i: number) => boolean } = {}) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sales: SalesFact[] = [];
  const stock: StockFact[] = [];
  const sessions: SessionsFact[] = [];
  const until = addDays(TODAY, -1);
  const since = addDays(until, -(days - 1));
  for (let i = 0; i < days; i++) {
    const day = addDays(since, i);
    for (let v = 1; v <= variants; v++) {
      if (opts.skip?.(v, i)) continue;
      for (const loc of [1, 2]) {
        if (v % 3 === 0 && loc === 2) continue; // not carried at L2
        const end = Math.floor(rnd() * 20) - 2;
        stock.push({ day, variantId: V(v), locationId: L(loc), endUnits: end, outOfStock: end <= 0 });
      }
      const sold = Math.floor(rnd() * 4);
      if (sold > 0) {
        sales.push({ day, variantId: V(v), locationKey: "online", channel: "all", sold, returned: 0, gross: 0 });
        if (v % 2) sales.push({ day, variantId: V(v), locationKey: L(2), channel: "all", sold: 1, returned: 0, gross: 0 });
        sales.push({ day, variantId: V(v), locationKey: "all", channel: "Online Store", sold, returned: rnd() < 0.2 ? 1 : 0, gross: Math.round(sold * (10 + rnd() * 30) * 100) / 100 });
        if (v % 2) sales.push({ day, variantId: V(v), locationKey: "all", channel: "Point of Sale", sold: 1, returned: 0, gross: 19.99 });
      }
      if (v === 4 && i % 5 === 0) sales.push({ day, variantId: V(v), locationKey: "pos:Pop-up Madrid", channel: "all", sold: 2, returned: 0, gross: 0 });
    }
    sessions.push({ day, landingPath: "/products/tee", trafficType: "google", sessions: 10 + i, checkouts: i % 3 });
    sessions.push({ day, landingPath: "/es/products/mug", trafficType: "direct", sessions: 3, checkouts: 0 });
    sessions.push({ day, landingPath: "/", trafficType: "direct", sessions: 50, checkouts: 2 });
  }
  return { sales, stock, sessions, range: { since, until } };
}

/** Results comparable across stores: Dates → days, numbers rounded, rows sorted. */
function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Math.round(v * 1e6) / 1e6;
  if (Array.isArray(v)) return v.map(norm).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)]));
  return v;
}

const run = PG_AVAILABLE ? describe : describe.skip;

run("facts store on Postgres = the in-memory store", () => {
  const runner = psqlRunner(DB);
  let pg: FactsStore;
  const fake = createFakePrisma();
  const mem = delegateFactsStore(fake.client);

  /** Reads compared so far, and how many of them returned something (the comparisons are not vacuous). */
  const seen = { reads: 0, nonEmpty: 0 };
  const both = async (fn: (s: FactsStore) => Promise<unknown>) => {
    const [a, b] = [await fn(pg), await fn(mem)];
    expect(norm(a)).toEqual(norm(b));
    seen.reads++;
    if (Array.isArray(a) ? a.length > 0 : a !== null && a !== 0) seen.nonEmpty++;
    else if (process.env.DEBUG_FACTS) console.log("empty read", fn.toString());
    return a;
  };

  beforeAll(async () => {
    forgetPartitions();
    freshDb(DB);
    psql(DB, `INSERT INTO "Shop" ("id","domain","currency","timezone","locale") VALUES ('a','${A}','EUR','UTC','en'), ('b','${B}','EUR','UTC','en')`);
    pg = pgFactsStore(runner);
    for (const [shop, seed] of [[A, 7], [B, 11]] as const) {
      const f = facts(seed, 70, 9);
      for (const s of [pg, mem]) {
        await s.replaceSales(shop, f.range, f.sales);
        await s.replaceStock(shop, f.range, f.stock);
        await s.replaceSessions(shop, f.range, f.sessions);
      }
    }
  }, 120_000);
  afterAll(() => dropDb(DB));

  const ids = [V(1), V(2), V(3), V(4), V(5), V(8), V(999)];
  const pool = [L(1), L(2)];
  const range = { gte: d(addDays(TODAY, -60)), lte: d(addDays(TODAY, -1)) };

  it("stores the facts compactly (one stock row per series and month)", () => {
    const series = Number(psql(DB, `SELECT count(DISTINCT ("shopNum","variantNum","locNum")) AS n FROM "StockMonth"`)[0]!.n);
    const rows = Number(psql(DB, `SELECT count(*) AS n FROM "StockMonth"`)[0]!.n);
    expect(series).toBe(2 * (9 * 2 - 3));
    expect(rows).toBeGreaterThanOrEqual(series * 3); // 70 days span 3 or 4 months
    expect(rows).toBeLessThanOrEqual(series * 4);
    expect(Number(psql(DB, `SELECT sum(cardinality("endUnits")) AS n FROM "StockMonth"`)[0]!.n)).toBe(rows * 31);
  });

  it("routes every row to its month's partition", () => {
    for (const [t, col] of [["SalesFact", "day"], ["StockMonth", "month"], ["SessionsFact", "day"]] as const) {
      const wrong = psql(DB, `SELECT count(*) AS n FROM "${t}" s WHERE s.tableoid::regclass::text <> '"${t}_p' || to_char(s."${col}", 'YYYYMM') || '"'`)[0]!.n;
      expect(wrong, t).toBe("0");
      expect(Number(psql(DB, `SELECT count(DISTINCT s.tableoid) AS n FROM "${t}" s`)[0]!.n), t).toBeGreaterThanOrEqual(3);
    }
    // StockMonth rows start on the 1st and carry 31 days.
    expect(psql(DB, `SELECT count(*) AS n FROM "StockMonth" WHERE extract(day from "month") <> 1 OR cardinality("endUnits") <> 31`)[0]!.n).toBe("0");
  });

  it("sales reads: channel view, pool view, store totals, first / last days", async () => {
    await both((s) => s.salesDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, locationKey: "all", variantId: { in: ids }, day: range }, _sum: { sold: true, gross: true, returned: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, channel: "all", locationKey: { notIn: ["all", L(2)] }, variantId: { in: ids }, day: range }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, locationKey: "all", variantId: { in: ids }, day: range }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId"], where: { shop: B, locationKey: "all", day: range }, _sum: { gross: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["day"], where: { shop: A }, orderBy: { day: "desc" }, take: 14 }));
    await both((s) => s.salesDaily.groupBy({ by: ["day"], where: { shop: A, locationKey: "all", day: { gte: d(addDays(TODAY, -30)) } }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.aggregate({ where: { shop: A, locationKey: "all" }, _min: { day: true } }));
    await both((s) => s.salesDaily.findFirst({ where: { shop: A, variantId: V(1), locationKey: "all", sold: { gt: 0 }, day: { lt: d(addDays(TODAY, -20)) } }, orderBy: { day: "desc" }, select: { day: true } }));
    await both((s) => s.salesDaily.findFirst({ where: { shop: A, variantId: V(4), locationKey: "all" }, orderBy: { day: "asc" }, select: { day: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId", "locationKey"], where: { shop: A, variantId: { in: ids }, channel: "all", sold: { gt: 0 } }, _max: { day: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId"], where: { shop: A, variantId: { in: ids }, locationKey: "all" }, _min: { day: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, variantId: { in: ids }, channel: "all", locationKey: { in: ["online", L(2), "pos:Pop-up Madrid", "pos:nowhere"] }, day: range }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["channel"], where: { shop: B, locationKey: "all" }, _sum: { sold: true, gross: true }, _count: { _all: true } }));
    await both((s) => s.salesDaily.count({ where: { shop: A, channel: "Point of Sale" } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId"], where: { shop: A, variantId: { in: ids }, day: { gte: d(addDays(TODAY, -10)) }, OR: [{ locationKey: "online" }, { channel: "Online Store" }] }, _sum: { sold: true } }));
    expect(seen).toEqual({ reads: 15, nonEmpty: 15 });
  });

  it("stock reads: pooled days, out-of-stock days, first days, the last day, one day, one location", async () => {
    await both((s) => s.stockDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, locationId: { in: pool }, variantId: { in: ids }, day: range }, _sum: { endUnits: true }, _count: { _all: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, locationId: { in: pool }, variantId: { in: ids }, day: range, outOfStock: true }, _count: { _all: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId", "locationId"], where: { shop: A, variantId: { in: ids } }, _min: { day: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId"], where: { shop: B, variantId: { in: ids }, locationId: { in: [L(2)] } }, _min: { day: true } }));
    await both((s) => s.stockDaily.findFirst({ where: { shop: A, locationId: { in: pool } }, orderBy: { day: "desc" }, select: { day: true } }));
    await both((s) => s.stockDaily.findFirst({ where: { shop: A, variantId: V(3) }, orderBy: { day: "asc" }, select: { day: true } }));
    await both((s) => s.stockDaily.findFirst({ where: { shop: A, variantId: V(3), locationId: L(2) }, orderBy: { day: "asc" }, select: { day: true } }));
    await both((s) => s.stockDaily.findMany({ where: { shop: A, day: d(addDays(TODAY, -3)), locationId: { in: pool }, variantId: { in: ids } }, select: { variantId: true, endUnits: true, outOfStock: true } }));
    await both((s) => s.stockDaily.findMany({ where: { shop: B, locationId: L(1), variantId: { in: ids }, day: range }, select: { variantId: true, day: true, endUnits: true, outOfStock: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId"], where: { shop: A, variantId: { in: ids }, day: { gte: d(addDays(TODAY, -45)), lte: d(addDays(TODAY, -39)) } }, _min: { day: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId", "day"], where: { shop: A, variantId: { in: ids }, locationId: { in: pool }, day: { in: [d(addDays(TODAY, -5)), d(addDays(TODAY, -33))] } }, _sum: { endUnits: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId"], where: { shop: A, variantId: { in: ids }, day: { gte: d(addDays(TODAY, -60)), lt: d(addDays(TODAY, -40)) } }, _min: { day: true }, _max: { day: true } }));
    await both((s) => s.stockDaily.aggregate({ where: { shop: A, variantId: V(2) }, _max: { day: true }, _min: { day: true } }));
    await both((s) => s.stockDaily.count({ where: { shop: B, outOfStock: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["locationId"], where: { shop: A, endUnits: { lte: 0 } }, _count: { _all: true } }));
    // Shapes outside the fast in-memory path (OR at the top level, NOT): the day-by-day evaluator.
    await both((s) => s.stockDaily.groupBy({ by: ["locationId"], where: { shop: A, OR: [{ endUnits: { gte: 15 } }, { outOfStock: true }] }, _count: { _all: true }, _max: { endUnits: true } }));
    await both((s) => s.stockDaily.findMany({ where: { shop: B, variantId: V(1), NOT: { locationId: L(1) }, day: { gt: d(addDays(TODAY, -6)) } }, select: { day: true, endUnits: true } }));
    await both((s) => s.stockDaily.aggregate({ where: { shop: A, variantId: { in: ids }, day: { in: [d(addDays(TODAY, -2)), d(addDays(TODAY, -40))] } }, _sum: { endUnits: true }, _min: { endUnits: true }, _count: { _all: true } }));
    expect(seen).toEqual({ reads: 33, nonEmpty: 32 }); // V(3) is not carried at L(2): null on both
  });

  it("visits reads", async () => {
    const r30 = { gte: d(addDays(TODAY, -30)), lte: d(addDays(TODAY, -1)) };
    await both((s) => s.sessionsDaily.groupBy({ by: ["landingPath", "day"], where: { shop: A, day: r30 }, _sum: { sessions: true, checkouts: true } }));
    await both((s) => s.sessionsDaily.findMany({ where: { shop: A, day: { gte: d(addDays(TODAY, -7)), lte: d(addDays(TODAY, -1)) }, landingPath: { contains: "/products/" } }, select: { landingPath: true, sessions: true } }));
    await both((s) => s.sessionsDaily.groupBy({ by: ["trafficType"], where: { shop: B }, _sum: { sessions: true } }));
  });

  it("an unknown shop, variant or key reads as nothing", async () => {
    await both((s) => s.salesDaily.groupBy({ by: ["variantId"], where: { shop: "nobody.myshopify.com", locationKey: "all" }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.aggregate({ where: { shop: "nobody.myshopify.com" }, _min: { day: true } }));
    await both((s) => s.stockDaily.findFirst({ where: { shop: "nobody.myshopify.com" }, orderBy: { day: "desc" }, select: { day: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId"], where: { shop: A, locationKey: "gid://shopify/Location/1" }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.groupBy({ by: ["variantId"], where: { shop: A, variantId: { in: ["not-a-gid", V(999)] } }, _sum: { sold: true } }));
    await both((s) => s.salesDaily.count({ where: { shop: A, channel: { notIn: ["all", "no such channel"] } } }));
  });

  it("rewriting the same facts changes no row; a corrected range is applied exactly", async () => {
    const f = facts(7, 70, 9);
    const before = psql(DB, `SELECT count(*) AS n, sum(xmin::text::bigint) AS x FROM "SalesFact"`)[0];
    const stockBefore = psql(DB, `SELECT count(*) AS n, sum(xmin::text::bigint) AS x FROM "StockMonth"`)[0];
    await pg.replaceSales(A, f.range, f.sales);
    await pg.replaceStock(A, f.range, f.stock);
    expect(psql(DB, `SELECT count(*) AS n, sum(xmin::text::bigint) AS x FROM "SalesFact"`)[0]).toEqual(before);
    expect(psql(DB, `SELECT count(*) AS n, sum(xmin::text::bigint) AS x FROM "StockMonth"`)[0]).toEqual(stockBefore);

    // Re-read of the last 3 days: one sale corrected, one gone, one new; stock: one value changed,
    // one series gone for those days, one new series.
    const r3 = { since: addDays(TODAY, -3), until: addDays(TODAY, -1) };
    const sales3 = f.sales.filter((x) => x.day >= r3.since);
    const changed = sales3.find((x) => x.channel === "Online Store")!;
    const gone = sales3.find((x) => x.locationKey === "online" && x !== changed)!;
    const nextSales = [
      ...sales3.filter((x) => x !== gone).map((x) => (x === changed ? { ...x, sold: x.sold + 5, gross: x.gross + 1.01 } : x)),
      { day: r3.until, variantId: V(77), locationKey: "online", channel: "all", sold: 9, returned: 0, gross: 0 },
    ];
    const stock3 = f.stock.filter((x) => x.day >= r3.since);
    const nextStock = [
      ...stock3.filter((x) => !(x.variantId === V(5) && x.locationId === L(1))).map((x, i) => (i === 0 ? { ...x, endUnits: 1234, outOfStock: false } : x)),
      { day: r3.since, variantId: V(78), locationId: L(1), endUnits: 3, outOfStock: false },
    ];
    for (const s of [pg, mem]) {
      await s.replaceSales(A, r3, nextSales);
      await s.replaceStock(A, r3, nextStock);
    }
    const all = { gte: d(addDays(TODAY, -80)), lte: d(TODAY) };
    await both((s) => s.salesDaily.findMany({ where: { shop: A, day: all }, select: { day: true, variantId: true, locationKey: true, channel: true, sold: true, returned: true, gross: true } }));
    await both((s) => s.stockDaily.findMany({ where: { shop: A, day: all }, select: { day: true, variantId: true, locationId: true, endUnits: true, outOfStock: true } }));
    await both((s) => s.stockDaily.groupBy({ by: ["variantId", "locationId"], where: { shop: A }, _min: { day: true }, _max: { day: true } }));
    // Only the rows that changed were written: the other shop's rows are untouched too.
    const xB = (t: string) => psql(DB, `SELECT sum(xmin::text::bigint) AS x FROM "${t}" WHERE "shopNum" = (SELECT num FROM "Shop" WHERE domain = '${B}')`)[0];
    const bSales = xB("SalesFact");
    await pg.replaceSales(A, r3, nextSales);
    expect(xB("SalesFact")).toEqual(bSales);
  });

  it("an empty range read clears the shop's days (stock series whose month empties are deleted)", async () => {
    const one = { since: addDays(TODAY, -2), until: addDays(TODAY, -2) };
    for (const s of [pg, mem]) {
      await s.replaceStock(B, one, []);
      await s.replaceSales(B, one, []);
      await s.replaceSessions(B, one, []);
    }
    const all = { gte: d(addDays(TODAY, -80)), lte: d(TODAY) };
    await both((s) => s.stockDaily.findMany({ where: { shop: B, day: all }, select: { day: true, variantId: true, locationId: true, endUnits: true, outOfStock: true } }));
    await both((s) => s.salesDaily.count({ where: { shop: B } }));
    await both((s) => s.sessionsDaily.count({ where: { shop: B } }));
    // A series written for one day only, then cleared, leaves no row behind.
    const lone = { since: addDays(TODAY, -1), until: addDays(TODAY, -1) };
    await pg.replaceStock(B, lone, [{ day: lone.since, variantId: V(500), locationId: L(9), endUnits: 1, outOfStock: false }]);
    expect(psql(DB, `SELECT count(*) AS n FROM "StockMonth" WHERE "variantNum" = 45000000000500`)[0]!.n).toBe("1");
    await pg.replaceStock(B, lone, []);
    expect(psql(DB, `SELECT count(*) AS n FROM "StockMonth" WHERE "variantNum" = 45000000000500`)[0]!.n).toBe("0");
  });

  it("keeps ids exact at the boundary (14-digit GIDs, location keys, channels, cents)", async () => {
    const r = await pg.salesDaily.findMany({ where: { shop: A, variantId: V(1), channel: "Online Store" }, select: { variantId: true, locationKey: true, channel: true, gross: true }, take: 1 });
    expect(r[0]!.variantId).toBe(V(1));
    expect(r[0]!.locationKey).toBe("all");
    expect(r[0]!.channel).toBe("Online Store");
    expect(Number.isInteger(Math.round(r[0]!.gross * 100))).toBe(true);
    const keys = psql(DB, `SELECT "key" FROM "FactKey" ORDER BY "num"`).map((x) => x.key);
    expect(keys.slice(0, 2)).toEqual(["all", "online"]);
    expect(keys).toEqual(expect.arrayContaining([L(1), L(2), "Online Store", "Point of Sale", "pos:Pop-up Madrid", "google", "direct"]));
  });

  it("purges one shop partition by partition and leaves the other", { timeout: 60_000 }, async () => {
    const n = await pg.purgeShop(B);
    expect(n).toBeGreaterThan(0);
    for (const t of ["SalesFact", "StockMonth", "SessionsFact"]) {
      expect(psql(DB, `SELECT count(*) AS n FROM "${t}" WHERE "shopNum" = (SELECT num FROM "Shop" WHERE domain = '${B}')`)[0]!.n).toBe("0");
      expect(Number(psql(DB, `SELECT count(*) AS n FROM "${t}" WHERE "shopNum" = (SELECT num FROM "Shop" WHERE domain = '${A}')`)[0]!.n)).toBeGreaterThan(0);
    }
    expect(await pg.purgeShop("nobody.myshopify.com")).toBe(0);
  });

  it("retention drops whole months past the cutoff and creates the months ahead", async () => {
    // A month far past every cutoff, with a row in it.
    const old = addMonths(monthOf(TODAY), -30);
    psql(DB, `CREATE TABLE "${partitionName("SalesFact", old)}" PARTITION OF "SalesFact" FOR VALUES FROM ('${old}') TO ('${addMonths(old, 1)}')`);
    psql(DB, `INSERT INTO "SalesFact" VALUES (1, 0, 1, '${old}', 0, 0, 1, 0)`);
    psql(DB, `DROP TABLE "${partitionName("StockMonth", addMonths(monthOf(TODAY), 2))}"`);
    forgetPartitions();
    const r = await maintainPartitions(TODAY, runner);
    expect(r.dropped).toContain(partitionName("SalesFact", old));
    expect(r.created).toBe(1);
    expect(await listPartitions(runner, "StockMonth")).toContain(addMonths(monthOf(TODAY), 2));
    expect(psql(DB, `SELECT count(*) AS n FROM "SalesFact" WHERE "day" < '${addMonths(old, 1)}'`)[0]!.n).toBe("0");
    // The stock window ends ~430 days back; 25 months for sales.
    const stockMonths = await listPartitions(runner, "StockMonth");
    expect(stockMonths[0]! >= monthOf(addDays(TODAY, -431))).toBe(true);
    expect((await listPartitions(runner, "SalesFact"))[0]).toBe(monthOf(addMonths(monthOf(TODAY), -25)));
    // Idempotent.
    expect((await maintainPartitions(TODAY, runner)).dropped).toEqual([]);
    const ret = await pg.applyRetention(A, TODAY);
    expect(ret.removed).toBe(0);
    expect(ret.from.sales).toBe(monthOf(addMonths(monthOf(TODAY), -25)));
  });

  it("writes skip days past retention (no partition, no error)", async () => {
    const ancient = { since: "2019-01-01", until: "2019-01-31" };
    await pg.replaceSales(A, ancient, [{ day: "2019-01-05", variantId: V(1), locationKey: "online", channel: "all", sold: 1, returned: 0, gross: 0 }]);
    await pg.replaceStock(A, ancient, [{ day: "2019-01-05", variantId: V(1), locationId: L(1), endUnits: 1, outOfStock: false }]);
    expect(psql(DB, `SELECT count(*) AS n FROM pg_class WHERE relname LIKE '%_p2019%'`)[0]!.n).toBe("0");
  });
});
