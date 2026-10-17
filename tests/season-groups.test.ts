/**
 * Seasonality by season group (owner 2026-10-17): catch-all collections skipped, product type as
 * a group, the store as the fallback — through the loader (services/season.server) on the fake
 * Prisma, with every product type read in ONE grouped statement (season-sql-shared), and that
 * statement run on real Postgres (skipped where none is reachable, see helpers/pg).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma();
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { loadSeasonContext } from "../app/services/season.server";
import { productTypeSeriesQuery, readProductTypeSeries, type RawQuery } from "../app/lib/season-sql-shared";
import { seasonGroupsOf } from "../app/lib/engine/season-shared";
import { addDays } from "../app/lib/engine/dates-shared";
import { seedSales } from "./helpers/pg-facts";
import { PG_AVAILABLE, bind, dropDb, freshDb, psql } from "./helpers/pg";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const SHOP = "groups.myshopify.com";
const TODAY = "2026-10-17";
const COVERAGE = { from: "2024-09-01", to: addDays(TODAY, -1) };
const ALL_C = "gid://shopify/Collection/1"; // every product: a catch-all
const OUTER = "gid://shopify/Collection/2"; // products 1–5
const d = (day: string) => new Date(`${day}T00:00:00Z`);

/** 10 products × 1 active tracked variant. Jackets: products 1–2; Shirts: 6–8; none: 3–5, 9–10. */
const TYPE: Record<number, string | null> = { 1: "Jackets", 2: "Jackets", 6: "Shirts", 7: "Shirts", 8: "Shirts" };
const variants = Array.from({ length: 10 }, (_, k) => {
  const n = k + 1;
  return {
    id: `gid://shopify/ProductVariant/${n}`,
    shop: SHOP,
    productId: `gid://shopify/Product/${n}`,
    collections: [ALL_C, ...(n <= 5 ? [OUTER] : [])],
    productType: TYPE[n] ?? null,
    tracked: true,
    isBundle: false,
    status: "ACTIVE",
  };
});

/** Jackets sell 20/day from mid-October to December, 4/day otherwise; everything else 5/day. */
const soldOn = (v: (typeof variants)[number], day: string) => {
  if (v.productType !== "Jackets") return 5;
  const md = day.slice(5);
  return md >= "10-15" ? 20 : 4;
};

function seed() {
  db.reset();
  const rows: Record<string, unknown>[] = [];
  for (let day = COVERAGE.from; day <= COVERAGE.to; day = addDays(day, 1)) {
    for (const v of variants) rows.push({ shop: SHOP, day: d(day), variantId: v.id, locationKey: "all", channel: "Online Store", sold: soldOn(v, day), returned: 0, gross: 0 });
  }
  db.tables.salesDaily = rows;
  db.tables.variant = variants.map((v) => ({ ...v }));
}

/** The statement's meaning in JS, for the fake (shop, channel view, types, windows from its parameters). */
const emulate: RawQuery = async (_sql, params) => {
  const types = new Set(Object.values(TYPE));
  const ps = params.map(String);
  const typeParams = ps.filter((p) => types.has(p));
  const dates = ps.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p));
  const windows: [string, string][] = [];
  for (let i = 0; i < dates.length; i += 2) windows.push([dates[i]!, dates[i + 1]!]);
  const typeOf = new Map(variants.map((v) => [v.id, v.productType]));
  const sums = new Map<string, number>();
  for (const r of db.tables.salesDaily ?? []) {
    const t = typeOf.get(r.variantId as string);
    const day = (r.day as Date).toISOString().slice(0, 10);
    if (r.shop !== ps[0] || r.locationKey !== "all" || !t || !typeParams.includes(t) || !windows.some(([a, b]) => day >= a && day <= b)) continue;
    sums.set(`${t}|${day}`, (sums.get(`${t}|${day}`) ?? 0) + (r.sold as number));
  }
  return [...sums].map(([k, sold]) => ({ productType: k.split("|")[0], day: k.split("|")[1], sold: BigInt(sold) }));
};

const input = () => ({
  today: TODAY,
  demand: { view: "channel" as const },
  variants: variants.map((v) => ({ id: v.id, productId: v.productId, collections: v.collections, productType: v.productType, counted: true })),
  coverage: COVERAGE,
  maxHorizonDays: 60,
});

describe("season source by group (loader)", () => {
  beforeEach(seed);

  it("skips the catch-all, picks the product type when more specific, else the collection, else the store", async () => {
    const raw = vi.fn(emulate);
    const ctx = await loadSeasonContext(SHOP, input(), raw);
    const at = (n: number) => ctx.forVariant(seasonGroupsOf(variants[n - 1]!), 60);
    // Product 1: "All" (catch-all), "Outer" (5 products) and Jackets (2 products) → Jackets.
    expect(at(1)).toMatchObject({ level: "productType", productType: "Jackets", collectionId: null });
    expect(at(1).seasonalResult.applied).toBe(true);
    // Product 3: no type → the Outer collection.
    expect(at(3)).toMatchObject({ level: "collection", collectionId: OUTER });
    // Product 6: Shirts (3 products) — "All" is never used.
    expect(at(6)).toMatchObject({ level: "productType", productType: "Shirts" });
    // Product 9: only the catch-all → the whole store.
    expect(at(9)).toMatchObject({ level: "store", collectionId: null, productType: null });
    // The jacket season is its own: steeper than the store's.
    expect(at(1).seasonal).toBeGreaterThan(at(9).seasonal);
  });

  it("reads every product type in ONE statement and never loads the catch-all collection", async () => {
    const raw = vi.fn(emulate);
    db.calls.length = 0;
    await loadSeasonContext(SHOP, input(), raw);
    expect(raw).toHaveBeenCalledTimes(1);
    const [sql, params] = raw.mock.calls[0]!;
    expect(sql).toContain("GROUP BY");
    expect(params).toEqual(expect.arrayContaining(["Jackets", "Shirts"]));
    const memberReads = db.calls.filter((c) => c.table === "salesDaily" && c.op === "groupBy" && (c.args as { where: { variantId?: unknown } }).where.variantId);
    const read = new Set(memberReads.map((c) => JSON.stringify(((c.args as { where: { variantId: { in: string[] } } }).where.variantId.in).length)));
    // Only Outer's 5 members (one read per day window), never All's 10.
    expect([...read]).toEqual(["5"]);
  });

  it("a group's series covers every day through yesterday (forecast quality: no unread gap read as zero sales)", async () => {
    const ctx = await loadSeasonContext(SHOP, input(), vi.fn(emulate));
    // Outer (collection) and Jackets (type) sell every day: the 90-day levels have every day, and
    // the realised season factor of the 28 days from a past day is known (season-shared realisedFactor).
    const outer = ctx.forVariant(seasonGroupsOf(variants[2]!), 60);
    const jackets = ctx.forVariant(seasonGroupsOf(variants[0]!), 60);
    expect(ctx.levelsFor(outer, 90)!.size).toBe(90);
    expect(ctx.levelsFor(jackets, 90)!.size).toBe(90);
    const [o] = ctx.originsFor(outer, [addDays(TODAY, -28)], 28);
    expect(o!.multiplier).toBeGreaterThan(0);
  });

  it("no qualifying type → no statement", async () => {
    const raw = vi.fn(emulate);
    const small = input();
    small.variants = small.variants.map((v) => ({ ...v, productType: null }));
    await loadSeasonContext(SHOP, small, raw);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe("productTypeSeriesQuery", () => {
  it("one statement: types, windows and the demand view as scalar parameters; null with nothing to read", () => {
    expect(productTypeSeriesQuery({ shop: SHOP, demand: { view: "channel" }, types: [], windows: [{ from: "2026-01-01", to: "2026-01-31" }] })).toBeNull();
    expect(productTypeSeriesQuery({ shop: SHOP, demand: { view: "channel" }, types: ["A"], windows: [] })).toBeNull();
    const q = productTypeSeriesQuery({
      shop: SHOP,
      demand: { view: "location", exclude: ["gid://shopify/Location/9"] },
      types: ["A", "B", "A"],
      windows: [{ from: "2025-01-01", to: "2025-03-31" }, { from: "2026-09-01", to: "2026-09-30" }],
      plannedOnly: true,
    })!;
    expect(q.params).toEqual([SHOP, "gid://shopify/Location/9", "A", "B", "2025-01-01", "2025-03-31", "2026-09-01", "2026-09-30"]);
    expect(q.params.every((p) => typeof p === "string")).toBe(true);
    expect(q.sql).toMatch(/GROUP BY v\."productType", s\."day"/);
    expect(q.sql).toContain(`v."tracked" = true AND v."status" = 'ACTIVE'`);
    expect(readProductTypeSeries([{ productType: "A", day: "2026-09-01", sold: 3n }, { productType: "A", day: new Date("2026-09-02T00:00:00Z"), sold: "4" }])).toEqual(
      new Map([["A", new Map([["2026-09-01", 3], ["2026-09-02", 4]])]]),
    );
  });
});

const PGDB = "keha_season_groups_test";

describe.skipIf(!PG_AVAILABLE)("productTypeSeriesQuery on Postgres", () => {
  beforeAll(() => {
    freshDb(PGDB);
    // Variant GIDs: the compact SalesFact keys a variant by the number in its GID.
    const G: Record<string, string> = { j1: "101", j2: "102", s1: "103", n1: "104", jb: "105", jd: "106" };
    const gid = (id: string) => `gid://shopify/ProductVariant/${G[id]}`;
    const v = (id: string, type: string | null, extra = "") =>
      `('${gid(id)}', '${SHOP}', 'p-${id}', 'P', 'V', 'h', ${type === null ? "NULL" : `'${type}'`}, ARRAY[]::text[], ${extra || "true, false, 'ACTIVE'"}, now())`;
    psql(
      PGDB,
      `INSERT INTO "Variant" ("id","shop","productId","productTitle","variantTitle","handle","productType","collections","tracked","isBundle","status","updatedAt") VALUES
        ${v("j1", "Jackets")}, ${v("j2", "Jackets")}, ${v("s1", "Shirts")}, ${v("n1", null)},
        ${v("jb", "Jackets", "true, true, 'ACTIVE'")}, ${v("jd", "Jackets", "true, false, 'DRAFT'")}`,
    );
    const sale = (day: string, id: string, locationKey: string, channel: string, sold: number, shop = SHOP) => ({ shop, day, variantId: gid(id), locationKey, channel, sold });
    seedSales(PGDB, [
      sale("2025-01-10", "j1", "all", "Online Store", 3),
      sale("2025-01-10", "j1", "all", "Point of Sale", 2),
      sale("2025-01-10", "j2", "all", "Online Store", 4),
      sale("2025-01-10", "s1", "all", "Online Store", 7),
      sale("2025-01-10", "n1", "all", "Online Store", 9),
      sale("2025-01-10", "jb", "all", "Online Store", 50),
      sale("2025-01-10", "jd", "all", "Online Store", 1),
      sale("2025-01-10", "j1", "online", "all", 3),
      sale("2025-01-10", "j1", "gid://shopify/Location/9", "all", 2),
      sale("2025-06-01", "j1", "all", "Online Store", 100),
      sale("2026-09-05", "j1", "all", "Online Store", 6),
      sale("2025-01-10", "j1", "all", "Online Store", 80, "other.myshopify.com"),
    ]);
  });
  afterAll(() => dropDb(PGDB));

  const run = (q: { sql: string; params: unknown[] }) => readProductTypeSeries(psql(PGDB, bind(q.sql, q.params)));
  const windows = [{ from: "2025-01-01", to: "2025-03-31" }, { from: "2026-09-01", to: "2026-09-30" }];

  it("sums every channel per type × day, inside the windows only, without bundles or other shops", () => {
    const out = run(productTypeSeriesQuery({ shop: SHOP, demand: { view: "channel" }, types: ["Jackets", "Shirts"], windows })!);
    // Jackets 10 Jan: j1 3 + 2, j2 4, the draft 1 (every non-bundle variant); the bundle and June are out.
    expect(out).toEqual(
      new Map([
        ["Jackets", new Map([["2025-01-10", 10], ["2026-09-05", 6]])],
        ["Shirts", new Map([["2025-01-10", 7]])],
      ]),
    );
  });

  it("location view minus a left-out location; active tracked members only (the planner)", () => {
    const loc = run(productTypeSeriesQuery({ shop: SHOP, demand: { view: "location", exclude: ["gid://shopify/Location/9"] }, types: ["Jackets"], windows })!);
    expect(loc).toEqual(new Map([["Jackets", new Map([["2025-01-10", 3]])]]));
    const planned = run(productTypeSeriesQuery({ shop: SHOP, demand: { view: "channel" }, types: ["Jackets"], windows, plannedOnly: true })!);
    expect(planned.get("Jackets")?.get("2025-01-10")).toBe(9); // without the draft
  });

  it("a channel left out of the forecast is left out of the type's season too (R4)", () => {
    const out = run(productTypeSeriesQuery({ shop: SHOP, demand: { view: "channel", excludeChannels: ["Point of Sale"] }, types: ["Jackets"], windows })!);
    expect(out.get("Jackets")?.get("2025-01-10")).toBe(8); // j1's 2 POS units out
  });
});
