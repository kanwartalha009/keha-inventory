/**
 * ShopifyQL pure layer (spec §6.1/§6.2): exact query strings, the "today is partial" guard
 * (invariant I-12), parsers against recorded-shape fixtures, monthly chunking and runChunked.
 */
import { describe, it, expect } from "vitest";

import {
  ShopifyqlTooLargeError,
  addDays,
  assertPastRange,
  buildDailySalesByChannelQuery,
  buildDailySalesByLocationQuery,
  buildDailySalesQuery,
  buildDailySessionsQuery,
  buildDailyShopTotalsQuery,
  buildDailyStockQuery,
  classifyResponse,
  classifyThrown,
  dayCount,
  halveRange,
  isDay,
  monthChunks,
  normaliseDay,
  normaliseVariantId,
  parseSalesRows,
  parseSessionsRows,
  parseShopDayRows,
  parseStockRows,
  readShopifyqlCost,
  runChunked,
  throttleWaitMs,
  toNumber,
  type DayRange,
  type ShopifyqlTableData,
} from "../../app/lib/sync/shopifyql-shared";

import salesFixture from "./fixtures/sales-daily.json";
import salesByLocationFixture from "./fixtures/sales-by-location.json";
import stockFixture from "./fixtures/stock-daily.json";
import sessionsFixture from "./fixtures/sessions-daily.json";
import shopFixture from "./fixtures/shop-daily.json";
import parseErrorsFixture from "./fixtures/parse-errors.json";
import tooLargeFixture from "./fixtures/too-large.json";
import throttledGraphqlFixture from "./fixtures/throttled-graphql.json";

const SEPT: DayRange = { since: "2026-09-01", until: "2026-09-30" };
const TODAY = "2026-10-16";

function table(fixture: unknown): ShopifyqlTableData {
  const c = classifyResponse(200, fixture);
  if (c.kind !== "ok") throw new Error(`fixture did not classify as ok: ${c.kind}`);
  return c.table;
}

describe("query builders (exact strings)", () => {
  it("query 1 — daily sales by variant, POS location and channel", () => {
    expect(buildDailySalesQuery(SEPT, TODAY)).toBe(
      "FROM sales SHOW net_items_sold, gross_sales, quantity_returned GROUP BY product_variant_id, pos_location_name, sales_channel TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
  });

  it("query 1 verified fallbacks", () => {
    expect(buildDailySalesByLocationQuery(SEPT, TODAY)).toBe(
      "FROM sales SHOW net_items_sold GROUP BY product_variant_id, pos_location_name TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
    expect(buildDailySalesByChannelQuery(SEPT, TODAY)).toBe(
      "FROM sales SHOW net_items_sold, gross_sales GROUP BY product_variant_id, sales_channel TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
  });

  it("channel query with returns (task 2.4; verified live 2026-10-17) keeps paging last", () => {
    expect(buildDailySalesByChannelQuery(SEPT, TODAY, { returns: true })).toBe(
      "FROM sales SHOW net_items_sold, gross_sales, quantity_returned GROUP BY product_variant_id, sales_channel TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
    expect(buildDailySalesByChannelQuery(SEPT, TODAY, { returns: true, paging: { orderBy: ["day", "product_variant_id", "sales_channel"], limit: 10, offset: 20 } })).toBe(
      "FROM sales SHOW net_items_sold, gross_sales, quantity_returned GROUP BY product_variant_id, sales_channel TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30 ORDER BY day ASC, product_variant_id ASC, sales_channel ASC LIMIT 10 OFFSET 20",
    );
  });

  it("query 2 — daily stock per variant per location", () => {
    expect(buildDailyStockQuery(SEPT, TODAY)).toBe(
      "FROM inventory_by_location SHOW ending_inventory_units_at_location, days_out_of_stock_at_location GROUP BY product_variant_id, inventory_location_name TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
  });

  it("query 3 — sessions by landing page and referrer source", () => {
    expect(buildDailySessionsQuery(SEPT, TODAY)).toBe(
      "FROM sessions SHOW sessions, sessions_that_completed_checkout GROUP BY landing_page_path, referrer_source TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
  });

  it("query 4 — store totals", () => {
    expect(buildDailyShopTotalsQuery(SEPT, TODAY)).toBe(
      "FROM sales SHOW orders, gross_sales TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30",
    );
  });

  it("appends LIMIT and OFFSET", () => {
    expect(buildDailySalesQuery(SEPT, TODAY, { paging: { limit: 1000, offset: 2000 } })).toBe(
      "FROM sales SHOW net_items_sold, gross_sales, quantity_returned GROUP BY product_variant_id, pos_location_name, sales_channel TIMESERIES day SINCE 2026-09-01 UNTIL 2026-09-30 LIMIT 1000 OFFSET 2000",
    );
    expect(buildDailyStockQuery(SEPT, TODAY, { paging: { limit: 500 } })).toMatch(/UNTIL 2026-09-30 LIMIT 500$/);
  });

  it("rejects bad paging values", () => {
    expect(() => buildDailySalesQuery(SEPT, TODAY, { paging: { limit: 0 } })).toThrow(RangeError);
    expect(() => buildDailySalesQuery(SEPT, TODAY, { paging: { limit: 1.5 } })).toThrow(RangeError);
    expect(() => buildDailySalesQuery(SEPT, TODAY, { paging: { offset: -1 } })).toThrow(RangeError);
  });

  it("until on or after today throws (today is partial)", () => {
    expect(() => buildDailySalesQuery({ since: "2026-10-01", until: TODAY }, TODAY)).toThrow(/before today/);
    expect(() => buildDailyStockQuery({ since: "2026-10-01", until: "2026-10-17" }, TODAY)).toThrow(RangeError);
    expect(() => buildDailySessionsQuery({ since: "2026-10-15", until: "2026-10-15" }, TODAY)).not.toThrow();
  });

  it("rejects malformed days and inverted ranges", () => {
    expect(() => assertPastRange({ since: "2026-9-1", until: "2026-09-30" }, TODAY)).toThrow(RangeError);
    expect(() => assertPastRange({ since: "2026-02-30", until: "2026-03-01" }, TODAY)).toThrow(RangeError);
    expect(() => assertPastRange({ since: "2026-09-30", until: "2026-09-01" }, TODAY)).toThrow(/after/);
    expect(() => assertPastRange(SEPT, "16/10/2026")).toThrow(RangeError);
  });
});

describe("value helpers", () => {
  it("toNumber parses numeric strings and rejects junk", () => {
    expect(toNumber("123.456")).toBe(123.456);
    expect(toNumber(" 7 ")).toBe(7);
    expect(toNumber(4)).toBe(4);
    expect(toNumber("abc")).toBeUndefined();
    expect(toNumber("")).toBeUndefined();
    expect(toNumber(null)).toBeUndefined();
    expect(toNumber(Number.NaN)).toBeUndefined();
  });

  it("normaliseDay keeps the date part as given, no time-zone shift", () => {
    expect(normaliseDay("2026-09-01")).toBe("2026-09-01");
    expect(normaliseDay("2026-09-01T00:00:00Z")).toBe("2026-09-01");
    expect(normaliseDay("2026-09-01T00:00:00-05:00")).toBe("2026-09-01");
    expect(normaliseDay("2026-09-01T23:30:00+14:00")).toBe("2026-09-01");
    expect(normaliseDay("2026-13-01")).toBeUndefined();
    expect(normaliseDay(null)).toBeUndefined();
  });

  it("normaliseVariantId accepts numeric ids and variant gids only", () => {
    const gid = "gid://shopify/ProductVariant/44012345678901";
    expect(normaliseVariantId("44012345678901")).toBe(gid);
    expect(normaliseVariantId(44012345678901)).toBe(gid);
    expect(normaliseVariantId(gid)).toBe(gid);
    expect(normaliseVariantId("gid://shopify/Product/1")).toBeUndefined();
    expect(normaliseVariantId("0")).toBeUndefined();
    expect(normaliseVariantId(null)).toBeUndefined();
    expect(normaliseVariantId("")).toBeUndefined();
  });

  it("isDay validates real calendar days", () => {
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
  });
});

describe("parsers", () => {
  it("sales: shuffled columns, null/empty POS → online, numeric strings, gid normalisation, skips counted", () => {
    const res = parseSalesRows(table(salesFixture));
    expect(res.skipped).toBe(3); // null day, null variant id, non-variant gid
    expect(res.missingColumns).toEqual([]);
    expect(res.rows).toEqual([
      {
        day: "2026-09-01",
        variantId: "gid://shopify/ProductVariant/44012345678901",
        locationKey: "online",
        channel: "Online Store",
        sold: 3,
        gross: 123.456,
        returned: 1,
      },
      {
        day: "2026-09-01",
        variantId: "gid://shopify/ProductVariant/44012345678902",
        locationKey: "Madrid Centro",
        channel: "Point of Sale",
        sold: 2,
        gross: 80,
        returned: 0,
      },
      {
        day: "2026-09-02",
        variantId: "gid://shopify/ProductVariant/44012345678903",
        locationKey: "online",
        channel: "Shop",
        sold: 1,
        gross: 0, // "not-a-number" → missing → 0 for a metric
        returned: 0,
      },
    ]);
  });

  it("sales: verified 2-dimension fallback reports the columns it lacks", () => {
    const res = parseSalesRows(table(salesByLocationFixture));
    expect(res.skipped).toBe(0);
    expect(res.missingColumns).toEqual(["sales_channel", "gross_sales", "quantity_returned"]);
    expect(res.rows.map((r) => [r.locationKey, r.channel, r.sold, r.gross])).toEqual([
      ["online", "unknown", 4, 0],
      ["Barcelona", "unknown", 2, 0],
    ]);
  });

  it("sales by channel with returns: quantity_returned read when present, 0 and reported when absent", () => {
    const cols = [
      { name: "day", dataType: "DAY_TIMESTAMP" },
      { name: "product_variant_id", dataType: "INTEGER" },
      { name: "sales_channel", dataType: "STRING" },
      { name: "net_items_sold", dataType: "INTEGER" },
      { name: "gross_sales", dataType: "MONEY" },
    ];
    const row = { day: "2026-09-01", product_variant_id: 7, sales_channel: "Online Store", net_items_sold: 8, gross_sales: "200.00" };
    const withReturns = parseSalesRows({ columns: [...cols, { name: "quantity_returned", dataType: "INTEGER" }], rows: [{ ...row, quantity_returned: -2 }] });
    expect(withReturns.rows[0]).toMatchObject({ sold: 8, gross: 200, returned: -2 });
    expect(withReturns.missingColumns).toEqual(["pos_location_name"]);
    const without = parseSalesRows({ columns: cols, rows: [row] });
    expect(without.rows[0].returned).toBe(0);
    expect(without.missingColumns).toEqual(["pos_location_name", "quantity_returned"]);
  });

  it("sales: a missing location column is 'unknown', not 'online'", () => {
    const res = parseSalesRows({
      columns: [{ name: "day" }, { name: "product_variant_id" }, { name: "sales_channel" }, { name: "net_items_sold" }],
      rows: [{ day: "2026-09-01", product_variant_id: "1", sales_channel: "Online Store", net_items_sold: "2" }],
    });
    expect(res.rows[0].locationKey).toBe("unknown");
    expect(res.missingColumns).toContain("pos_location_name");
  });

  it("parsers locate fields by column metadata, also for positional array rows", () => {
    const res = parseShopDayRows({
      columns: [{ name: "gross_sales" }, { name: "orders" }, { name: "day" }],
      rows: [["99.5", "3", "2026-09-05"]],
    });
    expect(res.rows).toEqual([{ day: "2026-09-05", orders: 3, gross: 99.5 }]);
  });

  it("a row key that is not in the columns metadata is ignored", () => {
    const res = parseShopDayRows({
      columns: [{ name: "day" }, { name: "orders" }],
      rows: [{ day: "2026-09-05", orders: "3", gross_sales: "10" }],
    });
    expect(res.rows[0].gross).toBe(0);
    expect(res.missingColumns).toEqual(["gross_sales"]);
  });

  it("stock: out-of-stock flag, negative units kept, missing location skipped", () => {
    const res = parseStockRows(table(stockFixture));
    expect(res.skipped).toBe(1);
    expect(res.rows).toEqual([
      { day: "2026-09-01", variantId: "gid://shopify/ProductVariant/44012345678901", locationName: "Main Warehouse", endUnits: 12, outOfStock: false },
      { day: "2026-09-01", variantId: "gid://shopify/ProductVariant/44012345678901", locationName: "Madrid Centro", endUnits: 0, outOfStock: true },
      { day: "2026-09-02", variantId: "gid://shopify/ProductVariant/44012345678902", locationName: "Main Warehouse", endUnits: -2, outOfStock: false },
    ]);
  });

  it("sessions: referrer_source stored as trafficType, nulls → unknown, missing day skipped", () => {
    const res = parseSessionsRows(table(sessionsFixture));
    expect(res.skipped).toBe(1);
    expect(res.rows).toEqual([
      { day: "2026-09-01", landingPath: "/products/red-sneaker", trafficType: "Search", sessions: 120, checkouts: 4 },
      { day: "2026-09-01", landingPath: "/", trafficType: "unknown", sessions: 300, checkouts: 9 },
      { day: "2026-09-01", landingPath: "unknown", trafficType: "Direct", sessions: 7, checkouts: 0 },
    ]);
  });

  it("shop totals", () => {
    const res = parseShopDayRows(table(shopFixture));
    expect(res).toEqual({
      rows: [
        { day: "2026-09-01", orders: 14, gross: 1234.5 },
        { day: "2026-09-02", orders: 0, gross: 0 },
      ],
      skipped: 0,
      missingColumns: [],
    });
  });

  it("rows delivered as a JSON string are accepted; junk rows give an empty result", () => {
    const res = parseShopDayRows({
      columns: [{ name: "day" }, { name: "orders" }, { name: "gross_sales" }],
      rows: JSON.stringify([{ day: "2026-09-01", orders: "1", gross_sales: "2" }]),
    });
    expect(res.rows).toHaveLength(1);
    expect(parseShopDayRows({ columns: [], rows: "not json" }).rows).toEqual([]);
  });
});

describe("classification", () => {
  it("ok / parse / tooLarge / throttled / error", () => {
    expect(classifyResponse(200, salesFixture).kind).toBe("ok");
    const parse = classifyResponse(200, parseErrorsFixture);
    expect(parse).toMatchObject({ kind: "parse", messages: ["Column 'net_itemz_sold' does not exist in dataset 'sales'"] });
    expect(classifyResponse(200, tooLargeFixture).kind).toBe("tooLarge");
    expect(classifyResponse(200, throttledGraphqlFixture).kind).toBe("throttled");
    expect(classifyResponse(429, null).kind).toBe("throttled");
    expect(classifyResponse(500, null)).toMatchObject({ kind: "error", status: 500 });
    expect(classifyResponse(200, { data: { shopifyqlQuery: null } }).kind).toBe("error");
  });

  it("accepts legacy object-shaped parseErrors", () => {
    const c = classifyResponse(200, { data: { shopifyqlQuery: { tableData: null, parseErrors: [{ code: "X", message: "bad" }] } } });
    expect(c).toMatchObject({ kind: "parse", messages: ["bad"] });
  });

  it("classifies what the Shopify library throws", () => {
    // GraphqlQueryError-like: body.errors.graphQLErrors
    const gqlErr = Object.assign(new Error("GraphQL"), {
      body: { errors: { message: "GraphQL Client: An error occurred", graphQLErrors: tooLargeFixture.errors }, extensions: tooLargeFixture.extensions },
    });
    expect(classifyThrown(gqlErr)?.kind).toBe("tooLarge");
    // HttpThrottlingError-like with Retry-After
    const httpErr = Object.assign(new Error("throttled"), { response: { code: 429, retryAfter: 2, body: {} } });
    expect(classifyThrown(httpErr)).toMatchObject({ kind: "throttled", retryAfterMs: 2000 });
    // Thrown Response 429 (handleClientError)
    expect(classifyThrown(new Response("{}", { status: 429 }), {})?.kind).toBe("throttled");
    // Unrecognised → null (caller rethrows)
    expect(classifyThrown(new Response("{}", { status: 401 }), {})).toBeNull();
    expect(classifyThrown(new Error("boom"))).toBeNull();
  });

  it("reads extensions.shopifyqlCost", () => {
    expect(readShopifyqlCost(salesFixture)).toEqual({
      requestedQueryCost: 12,
      maximumAvailable: 1000,
      currentlyAvailable: 988,
      windowResetAt: "2026-10-16T10:01:00Z",
    });
    expect(readShopifyqlCost({})).toBeNull();
  });

  it("throttleWaitMs: until reset, 60 s fallback, clamped", () => {
    const now = Date.parse("2026-10-16T10:00:00Z");
    expect(throttleWaitMs("2026-10-16T10:00:30Z", now)).toBe(30_000);
    expect(throttleWaitMs(null, now)).toBe(60_000);
    expect(throttleWaitMs("garbage", now)).toBe(60_000);
    expect(throttleWaitMs("2026-10-16T09:00:00Z", now)).toBe(1_000);
    expect(throttleWaitMs("2026-10-16T12:00:00Z", now)).toBe(600_000);
  });
});

describe("monthChunks (newest first)", () => {
  it("partial months at both ends", () => {
    expect(monthChunks("2026-07-15", "2026-10-15")).toEqual([
      { since: "2026-10-01", until: "2026-10-15" },
      { since: "2026-09-01", until: "2026-09-30" },
      { since: "2026-08-01", until: "2026-08-31" },
      { since: "2026-07-15", until: "2026-07-31" },
    ]);
  });

  it("crosses a year boundary and leap February", () => {
    expect(monthChunks("2027-12-20", "2028-03-02")).toEqual([
      { since: "2028-03-01", until: "2028-03-02" },
      { since: "2028-02-01", until: "2028-02-29" },
      { since: "2028-01-01", until: "2028-01-31" },
      { since: "2027-12-20", until: "2027-12-31" },
    ]);
  });

  it("single-day range and within-one-month range", () => {
    expect(monthChunks("2026-09-30", "2026-09-30")).toEqual([{ since: "2026-09-30", until: "2026-09-30" }]);
    expect(monthChunks("2026-09-03", "2026-09-10")).toEqual([{ since: "2026-09-03", until: "2026-09-10" }]);
  });

  it("empty when from > to; throws on malformed days", () => {
    expect(monthChunks("2026-10-01", "2026-09-30")).toEqual([]);
    expect(() => monthChunks("2026-9-1", "2026-09-30")).toThrow(RangeError);
  });
});

describe("range helpers and runChunked", () => {
  it("dayCount / addDays / halveRange", () => {
    expect(dayCount(SEPT)).toBe(30);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(halveRange({ since: "2026-09-01", until: "2026-09-15" })).toEqual([
      { since: "2026-09-01", until: "2026-09-07" },
      { since: "2026-09-08", until: "2026-09-15" },
    ]);
    expect(() => halveRange({ since: "2026-09-01", until: "2026-09-01" })).toThrow(RangeError);
  });

  it("splits a 30-day range until every chunk fits, newest first, full coverage", async () => {
    const MAX_DAYS = 8;
    const calls: DayRange[] = [];
    const runner = async (r: DayRange) => {
      calls.push(r);
      if (dayCount(r) > MAX_DAYS) throw new ShopifyqlTooLargeError("too big", "q");
      return dayCount(r);
    };
    const out = await runChunked(SEPT, runner);
    expect(out.every((c) => dayCount(c.range) <= MAX_DAYS)).toBe(true);
    expect(out.map((c) => c.range)).toEqual([
      { since: "2026-09-23", until: "2026-09-30" },
      { since: "2026-09-16", until: "2026-09-22" },
      { since: "2026-09-08", until: "2026-09-15" },
      { since: "2026-09-01", until: "2026-09-07" },
    ]);
    expect(out.reduce((s, c) => s + c.result, 0)).toBe(30);
    // contiguous, no overlap
    for (let i = 1; i < out.length; i++) {
      expect(addDays(out[i].range.until, 1)).toBe(out[i - 1].range.since);
    }
    expect(calls.length).toBe(7); // 30 → 15+15 → 7+8 each
  });

  it("rethrows when a single day is still too large", async () => {
    const runner = async () => {
      throw new ShopifyqlTooLargeError("too big", "q");
    };
    await expect(runChunked({ since: "2026-09-01", until: "2026-09-04" }, runner)).rejects.toBeInstanceOf(
      ShopifyqlTooLargeError,
    );
  });

  it("does not split on other errors", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      throw new Error("network");
    };
    await expect(runChunked(SEPT, runner)).rejects.toThrow("network");
    expect(calls).toBe(1);
  });
});
