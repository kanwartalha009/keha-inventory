/**
 * Audit 2026-10-17 C1 / M10: every ShopifyQL dataset read pages through ALL rows.
 *
 * A fake Shopify server plays the behaviour verified live on a Plus store:
 *  - without LIMIT it silently returns only the first 1,000 rows (C1);
 *  - `ORDER BY … LIMIT n OFFSET k` sorts by the listed columns and slices.
 * Plus the failure modes the pager must catch: a silent cap below LIMIT, exact page-size
 * multiples, overlapping pages (duplicates), OFFSET ignored, a hard row cap, columns changing,
 * and a sales read that does not add up to the store's daily total (reconciliation).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "../helpers/fake-prisma";
import type { AdminGraphqlClient } from "../../app/models/shop.server";
import {
  IMPLICIT_ROW_CAP,
  PAGE_SIZE,
  SALES_BY_CHANNEL_KEY,
  SALES_BY_LOCATION_KEY,
  SALES_KEY,
  SALES_TOTALS_KEY,
  SESSIONS_KEY,
  SHOP_TOTALS_KEY,
  STOCK_KEY,
  ShopifyqlReconcileError,
  ShopifyqlTruncatedError,
  addDays,
  assertReconciled,
  buildDailySalesByChannelQuery,
  buildDailySalesByLocationQuery,
  buildDailySalesQuery,
  buildDailySalesTotalsQuery,
  buildDailySessionsQuery,
  buildDailyShopTotalsQuery,
  buildDailyStockQuery,
  fetchAllPages,
  parseSalesRows,
  reconcileDailyUnits,
  unitsByDay,
  type BuildOptions,
  type DayRange,
  type Paging,
  type ShopifyqlTableData,
} from "../../app/lib/sync/shopifyql-shared";

vi.mock("../../app/db.server", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const db = createFakePrisma({
    stockDaily: ["shop", "day", "variantId", "locationId"],
    salesDaily: ["shop", "day", "variantId", "locationKey", "channel"],
  });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../../app/db.server";
import { useFakeFacts } from "../helpers/fake-facts";
import { createShopifyqlClient } from "../../app/services/sync/shopifyql.server";
import { storeSales, storeStock } from "../../app/services/sync/facts.server";
import { syncErrorCode } from "../../app/lib/sync/errors-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const S = "acme.myshopify.com";
const TODAY = "2026-10-16";
const SEPT: DayRange = { since: "2026-09-01", until: "2026-09-30" };
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const WAREHOUSE = { id: "gid://shopify/Location/1", name: "Warehouse", active: true };
const STORE = { id: "gid://shopify/Location/2", name: "Madrid Store", active: true };

type Row = Record<string, unknown>;
type Dataset = { columns: string[]; rows: Row[] };

function days(r: DayRange): string[] {
  const out: string[] = [];
  for (let d = r.since; d <= r.until; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Stock rows: a row every day for every variant × location, like the live store (incl. zero / negative). */
function stockData(variants: number, r: DayRange = SEPT): Dataset {
  const rows: Row[] = [];
  for (const day of days(r))
    for (let v = 1; v <= variants; v++)
      for (const loc of ["Warehouse", "Madrid Store"]) {
        rows.push({ day, product_variant_id: String(v), inventory_location_name: loc, ending_inventory_units_at_location: loc === "Warehouse" ? v : -1, days_out_of_stock_at_location: loc === "Warehouse" ? 0 : 1 });
      }
  return { columns: ["day", "product_variant_id", "inventory_location_name", "ending_inventory_units_at_location", "days_out_of_stock_at_location"], rows };
}

type ServerOpts = {
  /** Every page is cut to this many rows whatever LIMIT says (a silent cap). */
  pageCap?: number;
  /** OFFSET is ignored: every page starts at row 0. */
  ignoreOffset?: boolean;
  /** Each page after the first starts this many rows early (non-total ordering → overlap). */
  overlap?: number;
};

function compare(cols: string[]) {
  return (a: Row, b: Row) => {
    for (const c of cols) {
      const x = String(a[c] ?? "");
      const y = String(b[c] ?? "");
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
}

/** Fake Admin client answering ShopifyQL like Shopify does (see the file header). */
function server(data: (q: string) => Dataset, opts: ServerOpts = {}) {
  const queries: string[] = [];
  const admin: AdminGraphqlClient = {
    graphql: async (_doc, options) => {
      const q = String(options?.variables?.q);
      queries.push(q);
      const ds = data(q);
      const m = /ORDER BY (.+?) LIMIT (\d+)(?: OFFSET (\d+))?$/.exec(q);
      let rows: Row[];
      if (!m) rows = ds.rows.slice(0, IMPLICIT_ROW_CAP); // C1: no LIMIT → first 1,000 rows, silently
      else {
        const cols = m[1].split(", ").map((c) => c.replace(/ ASC$/, ""));
        const sorted = [...ds.rows].sort(compare(cols));
        let offset = opts.ignoreOffset ? 0 : Number(m[3] ?? 0);
        if (opts.overlap && offset > 0) offset = Math.max(0, offset - opts.overlap);
        const limit = Math.min(Number(m[2]), opts.pageCap ?? Infinity);
        rows = sorted.slice(offset, offset + limit);
      }
      const body = { data: { shopifyqlQuery: { tableData: { columns: ds.columns.map((name) => ({ name })), rows }, parseErrors: [] } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  return { admin, queries };
}

const client = (admin: AdminGraphqlClient, paging?: { pageSize?: number; maxRows?: number }) =>
  createShopifyqlClient(admin, { sleep: async () => {}, now: () => 0, paging });

beforeEach(() => {
  db.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Query strings: a unique, total ORDER BY on every dataset query
// ---------------------------------------------------------------------------

describe("paged query strings", () => {
  const P = (key: readonly string[]): Paging => ({ orderBy: key, limit: PAGE_SIZE, offset: 10_000 });
  const GRAMMAR =
    /^FROM ([a-z_]+) SHOW ([a-z_]+(?:, [a-z_]+)*)(?: GROUP BY ([a-z_]+(?:, [a-z_]+)*))? TIMESERIES day SINCE \d{4}-\d{2}-\d{2} UNTIL \d{4}-\d{2}-\d{2} ORDER BY ([a-z_]+ ASC(?:, [a-z_]+ ASC)*) LIMIT (\d+) OFFSET (\d+)$/;
  const cases: Array<[string, (r: DayRange, t: string, o: BuildOptions) => string, readonly string[]]> = [
    ["sales (3 dimensions)", buildDailySalesQuery, SALES_KEY],
    ["sales by location", buildDailySalesByLocationQuery, SALES_BY_LOCATION_KEY],
    ["sales by channel", buildDailySalesByChannelQuery, SALES_BY_CHANNEL_KEY],
    ["sales by channel + returns", (r, t, o) => buildDailySalesByChannelQuery(r, t, { ...o, returns: true }), SALES_BY_CHANNEL_KEY],
    ["sales totals", buildDailySalesTotalsQuery, SALES_TOTALS_KEY],
    ["stock", buildDailyStockQuery, STOCK_KEY],
    ["sessions", buildDailySessionsQuery, SESSIONS_KEY],
    ["shop totals", buildDailyShopTotalsQuery, SHOP_TOTALS_KEY],
  ];

  for (const [label, build, key] of cases) {
    it(`${label}: ORDER BY = day + every GROUP BY dimension, then LIMIT / OFFSET`, () => {
      const q = build(SEPT, TODAY, { paging: P(key) });
      const m = GRAMMAR.exec(q);
      expect(m, q).not.toBeNull();
      const groupBy = m![3] ? m![3].split(", ") : [];
      const orderBy = m![4].split(", ").map((c) => c.replace(/ ASC$/, ""));
      expect(orderBy[0]).toBe("day"); // the time dimension leads
      expect(new Set(orderBy)).toEqual(new Set(["day", ...groupBy])); // total: the whole row key, nothing else
      expect(orderBy).toHaveLength(groupBy.length + 1);
      expect(m![5]).toBe(String(PAGE_SIZE));
      expect(m![6]).toBe("10000");
    });
  }

  it("the exact stock string", () => {
    expect(buildDailyStockQuery(SEPT, TODAY, { paging: { orderBy: STOCK_KEY, limit: 5000, offset: 5000 } })).toBe(
      "FROM inventory_by_location SHOW ending_inventory_units_at_location, days_out_of_stock_at_location GROUP BY product_variant_id, inventory_location_name TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30 ORDER BY day ASC, product_variant_id ASC, inventory_location_name ASC LIMIT 5000 OFFSET 5000",
    );
  });

  it("refuses bad columns, an empty ORDER BY and OFFSET without LIMIT", () => {
    expect(() => buildDailyStockQuery(SEPT, TODAY, { paging: { orderBy: ["x; DROP"] } })).toThrow(RangeError);
    expect(() => buildDailyStockQuery(SEPT, TODAY, { paging: { orderBy: [] } })).toThrow(RangeError);
    expect(() => buildDailyStockQuery(SEPT, TODAY, { paging: { offset: 10 } })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The client against the fake server
// ---------------------------------------------------------------------------

describe("C1: no silent truncation", () => {
  it("a query without LIMIT gets exactly 1,000 of 2,208 rows (the bug); the client reads all 2,208", async () => {
    const data = stockData(36, { since: "2026-09-01", until: "2026-09-30" }); // 30 × 36 × 2 = 2,160
    data.rows.push(...stockData(1, { since: "2026-09-01", until: "2026-09-24" }).rows.map((r) => ({ ...r, product_variant_id: "99" }))); // + 48
    expect(data.rows).toHaveLength(2208);
    const s = server(() => data);
    const raw = await client(s.admin).run(buildDailyStockQuery(SEPT, TODAY));
    expect((raw.table.rows as unknown[]).length).toBe(1000);

    const s2 = server(() => data);
    const r = await client(s2.admin).stockDaily(SEPT, TODAY);
    expect(r.rows).toHaveLength(2208);
    expect(r.pages).toBe(1);
    expect(r.duplicates).toBe(0);
    expect(s2.queries[0]).toMatch(/ORDER BY day ASC, product_variant_id ASC, inventory_location_name ASC LIMIT 5000 OFFSET 0$/);
  });

  it("a mid-size month (30,000+ stock rows) is read in full, 5,000 rows a page", async () => {
    const data = stockData(520); // 30 × 520 × 2 = 31,200
    const s = server(() => data);
    const r = await client(s.admin).stockDaily(SEPT, TODAY);
    expect(r.rows).toHaveLength(31_200);
    expect(s.queries.map((q) => /OFFSET (\d+)$/.exec(q)![1])).toEqual(["0", "5000", "10000", "15000", "20000", "25000", "30000"]);
  });

  it("exact page-size multiples fetch one more (empty) page", async () => {
    const data = stockData(50); // 3,000 rows
    const s = server(() => data);
    const r = await client(s.admin, { pageSize: 1000 }).stockDaily(SEPT, TODAY);
    expect(r.rows).toHaveLength(3000);
    expect(s.queries).toHaveLength(4);
    expect(s.queries[3]).toMatch(/LIMIT 1000 OFFSET 3000$/);
  });

  it("a server that silently caps every page at 1,000 (below LIMIT) is still read in full", async () => {
    const data = stockData(37); // 2,220 rows
    const s = server(() => data, { pageCap: 1000 });
    const r = await client(s.admin).stockDaily(SEPT, TODAY);
    expect(r.rows).toHaveLength(2220);
    expect(s.queries.map((q) => /OFFSET (\d+)$/.exec(q)![1])).toEqual(["0", "1000", "2000"]);
  });

  it("a page of exactly 1,000 rows is never trusted as the last one", async () => {
    const data = stockData(17); // 1,020 rows …
    data.rows = data.rows.slice(0, 1000); // … of which exactly 1,000 exist
    const s = server(() => data);
    const r = await client(s.admin).stockDaily(SEPT, TODAY);
    expect(r.rows).toHaveLength(1000);
    expect(s.queries).toHaveLength(2); // the second page came back empty: now it is the end
  });

  it("OFFSET ignored → ShopifyqlTruncatedError (retryable), never a partial result", async () => {
    const s = server(() => stockData(20), { ignoreOffset: true });
    const err = await client(s.admin, { pageSize: 1000 }).stockDaily(SEPT, TODAY).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlTruncatedError);
    expect(err.retryable).toBe(true);
    expect(syncErrorCode(err)).toBe("truncated");
  });

  it("more rows than the hard cap → ShopifyqlTruncatedError", async () => {
    const s = server(() => stockData(50));
    const err = await client(s.admin, { pageSize: 1000, maxRows: 2500 }).stockDaily(SEPT, TODAY).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlTruncatedError);
    expect(err.message).toContain("more than 2500 rows");
  });
});

describe("M10: overlapping pages never double count", () => {
  it("rows repeated across pages are replaced, so stored stock is not added twice", async () => {
    const data = stockData(37); // 2,220 rows
    const s = server(() => data, { overlap: 3 });
    const ql = client(s.admin, { pageSize: 1000 });
    const r = await ql.stockDaily(SEPT, TODAY);
    expect(r.rows).toHaveLength(2220);
    expect(r.duplicates).toBe(3); // page 2 starts 3 rows early and re-reads the last 3 rows of page 1

    await storeStock(S, ql, SEPT, TODAY, [WAREHOUSE, STORE]);
    expect(db.tables.stockDaily).toHaveLength(2220);
    const v5 = db.tables.stockDaily.filter((x) => x.variantId === V(5) && x.locationId === WAREHOUSE.id);
    expect(v5.every((x) => x.endUnits === 5)).toBe(true); // never 10
    expect(db.tables.stockDaily.filter((x) => x.locationId === STORE.id).every((x) => x.endUnits === -1)).toBe(true); // negative kept
  });

  it("fetchAllPages: a later copy of a key replaces the earlier one", async () => {
    const pages: ShopifyqlTableData[] = [
      { columns: [{ name: "day" }, { name: "n" }], rows: [{ day: "2026-09-01", n: 1 }, { day: "2026-09-02", n: 2 }] },
      { columns: [{ name: "day" }, { name: "n" }], rows: [["2026-09-02", 2], ["2026-09-03", 3]] }, // positional rows are mapped too
    ];
    let i = 0;
    const r = await fetchAllPages(async () => pages[i++] ?? { columns: [], rows: [] }, ["day"], { pageSize: 2, minPageSize: 2 });
    expect(r.table.rows).toEqual([{ day: "2026-09-01", n: 1 }, { day: "2026-09-02", n: 2 }, { day: "2026-09-03", n: 3 }]);
    expect(r).toMatchObject({ pages: 3, rawRows: 4, duplicates: 1 });
  });

  it("fetchAllPages: columns changing between pages, or a missing key column, fail the read", async () => {
    let i = 0;
    const changing = [
      { columns: [{ name: "day" }, { name: "a" }], rows: [{ day: "1", a: 1 }] },
      { columns: [{ name: "day" }, { name: "b" }], rows: [{ day: "2", b: 1 }] },
    ];
    await expect(fetchAllPages(async () => changing[i++], ["day"], { pageSize: 1, minPageSize: 1 })).rejects.toBeInstanceOf(ShopifyqlTruncatedError);
    await expect(fetchAllPages(async () => ({ columns: [{ name: "x" }], rows: [{ x: 1 }] }), ["day"])).rejects.toThrow("key column(s) day missing");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe("C1: sales reconcile with the store's daily total", () => {
  const R: DayRange = { since: "2026-09-01", until: "2026-09-03" };

  it("matches within rounding, counts rows without a variant (custom items), flags real gaps", () => {
    const parsed = parseSalesRows({
      columns: [{ name: "day" }, { name: "product_variant_id" }, { name: "sales_channel" }, { name: "net_items_sold" }],
      rows: [
        { day: "2026-09-01", product_variant_id: "1", sales_channel: "Online Store", net_items_sold: 4 },
        { day: "2026-09-01", product_variant_id: "", sales_channel: "Online Store", net_items_sold: 1 }, // custom item: skipped, still counted
        { day: "2026-09-02", product_variant_id: "1", sales_channel: "Online Store", net_items_sold: 2 },
      ],
    });
    expect(parsed.skipped).toBe(1);
    const got = unitsByDay(parsed);
    expect(reconcileDailyUnits(got, new Map([["2026-09-01", 5], ["2026-09-02", 2.2]]), R)).toEqual([]);
    expect(reconcileDailyUnits(got, new Map([["2026-09-01", 5], ["2026-09-02", 2], ["2026-09-03", 7], ["2026-10-01", 9]]), R)).toEqual([
      { day: "2026-09-03", expected: 7, got: 0 }, // a day the read lost entirely; 2026-10-01 is out of range
    ]);
    expect(() => assertReconciled("sales by channel", got, new Map([["2026-09-01", 6]]), R)).toThrow(ShopifyqlReconcileError);
  });

  it("storeSales: a truncated read (store sold more) fails and stores NOTHING for the range", async () => {
    const salesRows: Row[] = [];
    for (const day of days(SEPT)) for (let v = 1; v <= 40; v++) salesRows.push({ day, product_variant_id: String(v), pos_location_name: "", sales_channel: "Online Store", net_items_sold: 1, gross_sales: 10, quantity_returned: 0 });
    const s = server((q) => {
      if (q.startsWith("FROM sales SHOW net_items_sold TIMESERIES day"))
        return { columns: ["day", "net_items_sold"], rows: days(SEPT).map((day) => ({ day, net_items_sold: day === "2026-09-17" ? 41 : 40 })) };
      if (q.includes("GROUP BY product_variant_id, pos_location_name"))
        return { columns: ["day", "product_variant_id", "pos_location_name", "net_items_sold"], rows: salesRows };
      return { columns: ["day", "product_variant_id", "sales_channel", "net_items_sold", "gross_sales", "quantity_returned"], rows: salesRows };
    });
    const err = await storeSales(S, client(s.admin), SEPT, TODAY, [WAREHOUSE]).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyqlReconcileError);
    expect(err.mismatches).toEqual([{ day: "2026-09-17", expected: 41, got: 40 }]);
    expect(err.retryable).toBe(true);
    expect(db.tables.salesDaily ?? []).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
    // Each read paged past 1,000 rows (1,200 rows a view).
    expect(s.queries.filter((q) => /OFFSET 0$/.test(q))).toHaveLength(3);
  });

  it("storeSales: when everything adds up, both views are stored in full (1,200 rows each, past the 1,000 cap)", async () => {
    const salesRows: Row[] = [];
    for (const day of days(SEPT)) for (let v = 1; v <= 40; v++) salesRows.push({ day, product_variant_id: String(v), pos_location_name: "", sales_channel: "Online Store", net_items_sold: 1, gross_sales: 10, quantity_returned: 0 });
    const s = server((q) => {
      if (q.startsWith("FROM sales SHOW net_items_sold TIMESERIES day")) return { columns: ["day", "net_items_sold"], rows: days(SEPT).map((day) => ({ day, net_items_sold: 40 })) };
      if (q.includes("pos_location_name")) return { columns: ["day", "product_variant_id", "pos_location_name", "net_items_sold"], rows: salesRows };
      return { columns: ["day", "product_variant_id", "sales_channel", "net_items_sold", "gross_sales", "quantity_returned"], rows: salesRows };
    });
    const r = await storeSales(S, client(s.admin), SEPT, TODAY, [WAREHOUSE]);
    expect(r.rows).toBe(2400);
    expect(db.tables.salesDaily.filter((x) => x.locationKey === "online")).toHaveLength(1200);
    expect(db.tables.salesDaily.filter((x) => x.channel === "Online Store")).toHaveLength(1200);
  });
});
