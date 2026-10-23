/**
 * Products helpers (app/lib/products-shared.ts, task 1.7): status labels,
 * filters, paging maths, row mapping, CSV escaping and the detail series.
 */
import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  csvCell,
  csvLine,
  dailySeries,
  daysLeftView,
  filtersToParams,
  formatRate,
  monthlyTotals,
  pageInfo,
  parseFilters,
  parsePage,
  productsCsv,
  readForecastInputs,
  readSeasonSource,
  recentDays,
  toCsv,
  toProductRow,
  variantGid,
  variantName,
  variantNumericId,
  type ProductRow,
} from "../app/lib/products-shared";
import { VARIANT_STATUSES } from "../app/lib/engine/types-shared";

const id = (s: string) => s;

const variant = {
  id: "gid://shopify/ProductVariant/42",
  productTitle: "Linen shirt",
  variantTitle: "M / Blue",
  sku: "LS-M-B",
  vendor: "Acme",
  image: null,
};
const metric = { status: "running_low", rate: 2.345, daysLeft: 9.7, neverRunsOut: false, orderQty: 30, orderBy: new Date("2026-10-20T00:00:00Z") };

describe("status words (clarity pass 2026-10-23)", () => {
  it("every row carries the outcome word worked out from the nightly numbers; withPlan refines it", () => {
    const row = (status: string, over: { orderBy?: Date | null } = {}, onHand = 12) =>
      toProductRow({ id: "gid://shopify/ProductVariant/1", productTitle: "Shirt", variantTitle: "M", sku: null, vendor: null, image: null }, { ...metric, status, ...over }, { onHand, incoming: 0 }, true, null, "2026-10-16");
    expect(row("running_low").outcome).toEqual({ key: "orderSoon", reason: { kind: "orderBy", orderBy: "2026-10-20", lasts: "2026-10-25" } });
    expect(row("out", {}, 0).outcome?.key).toBe("orderNow");
    expect(row("healthy", { orderBy: new Date("2026-12-01T00:00:00Z") }).outcome?.key).toBe("ok");
    expect(row("too_much", { orderBy: null }).outcome?.key).toBe("tooMuch");
    expect(row("dead", { orderBy: null }).outcome?.key).toBe("notSelling");
    expect(row("not_enough_data").outcome?.key).toBe("learning");
    expect(toProductRow({ id: "gid://shopify/ProductVariant/2", productTitle: "Cap", variantTitle: "", sku: null, vendor: null, image: null }, null, null, true).outcome?.key).toBe("learning");
  });
});

describe("filters and paging", () => {
  it("parses known values and drops unknown statuses", () => {
    const f = parseFilters(new URLSearchParams("status=bogus&vendor=%20Acme%20&q=&collection=Summer"));
    expect(f).toEqual({ status: null, outcome: null, collection: "Summer", vendor: "Acme", productType: null, q: null, supplier: null, sort: null });
    expect(parseFilters(new URLSearchParams("status=too_much")).status).toBe("too_much");
    // Clarity pass: the status-word filter (?outcome=orderNow), unknown words dropped, round-trips.
    expect(parseFilters(new URLSearchParams("outcome=orderNow")).outcome).toBe("orderNow");
    expect(parseFilters(new URLSearchParams("outcome=bogus")).outcome).toBeNull();
    expect(filtersToParams({ status: null, outcome: "tooMuch", collection: null, vendor: null, q: null, supplier: null, sort: null }).toString()).toBe("outcome=tooMuch");
  });
  it("supplier filter and sort (order-by date is the default; product name on request)", () => {
    expect(parseFilters(new URLSearchParams("supplier=s1&sort=title"))).toMatchObject({ supplier: "s1", sort: "title" });
    expect(parseFilters(new URLSearchParams("sort=bogus")).sort).toBeNull();
    expect(filtersToParams({ status: null, collection: null, vendor: null, q: null, supplier: "none", sort: "title" }).toString()).toBe("supplier=none&sort=title");
  });
  it("product type filter: ?type, trimmed, round-trips", () => {
    expect(parseFilters(new URLSearchParams("type=%20Jackets%20")).productType).toBe("Jackets");
    expect(parseFilters(new URLSearchParams("type=")).productType).toBeNull();
    expect(filtersToParams({ status: null, collection: null, vendor: null, productType: "Coats & Jackets", q: null }).toString()).toBe("type=Coats+%26+Jackets");
  });
  it("season source from inputs.season (the product page's Season from)", () => {
    expect(readSeasonSource({ level: "collection", collectionId: "gid://shopify/Collection/1" })).toEqual({ level: "collection", collectionId: "gid://shopify/Collection/1" });
    expect(readSeasonSource({ level: "productType", productType: "Jackets", collectionId: null })).toEqual({ level: "productType", productType: "Jackets" });
    expect(readSeasonSource({ level: "store", collectionId: null })).toEqual({ level: "store" });
    expect(readSeasonSource({ level: "productType", productType: "" })).toBeNull();
    expect(readSeasonSource(null)).toBeNull();
    expect(readForecastInputs({ season: { level: "productType", productType: "Jackets" } }, null)?.seasonSource).toEqual({ level: "productType", productType: "Jackets" });
    expect(readForecastInputs({}, null)?.seasonSource).toBeNull();
  });
  it("round-trips to a query string without the page", () => {
    const p = filtersToParams({ status: "dead", collection: null, vendor: "A&B", q: "shirt" });
    expect(p.toString()).toBe("status=dead&vendor=A%26B&q=shirt");
  });
  it("page parameter: positive integers only", () => {
    expect(parsePage(new URLSearchParams("page=3"))).toBe(3);
    expect(parsePage(new URLSearchParams("page=0"))).toBe(1);
    expect(parsePage(new URLSearchParams("page=2.5"))).toBe(1);
    expect(parsePage(new URLSearchParams("page=abc"))).toBe(1);
  });
  it("pages of 50, clamped to the last page", () => {
    expect(PAGE_SIZE).toBe(50);
    expect(pageInfo(0, 1)).toEqual({ page: 1, pageCount: 1, skip: 0, take: 50, hasPrev: false, hasNext: false });
    expect(pageInfo(120, 2)).toEqual({ page: 2, pageCount: 3, skip: 50, take: 50, hasPrev: true, hasNext: true });
    expect(pageInfo(120, 3)).toMatchObject({ skip: 100, hasNext: false });
    expect(pageInfo(120, 99)).toMatchObject({ page: 3, skip: 100 });
    expect(pageInfo(50, 1)).toMatchObject({ pageCount: 1, hasNext: false });
    expect(pageInfo(51, 1)).toMatchObject({ pageCount: 2, hasNext: true });
  });
});

describe("rows", () => {
  it("maps metric and summed stock", () => {
    const r = toProductRow(variant, metric, { onHand: 12, incoming: 0 }, true);
    expect(r).toMatchObject({
      numericId: "42",
      status: "running_low",
      onHand: 12,
      incoming: 0,
      rate: 2.345,
      daysLeft: 9.7,
      orderBy: "2026-10-20",
      orderQty: 30,
    });
  });
  it("blanks the forecast columns when the plan doesn't include them", () => {
    const r = toProductRow(variant, { ...metric, neverRunsOut: true }, { onHand: 12, incoming: 0 }, false);
    expect(r).toMatchObject({ daysLeft: null, neverRunsOut: false, orderBy: null, orderQty: null, rate: 2.345 });
  });
  it("unknown is null, never 0", () => {
    const r = toProductRow(variant, null, undefined, true);
    expect(r).toMatchObject({ status: null, onHand: null, incoming: null, rate: null, daysLeft: null, orderQty: null });
    expect(toProductRow(variant, { ...metric, status: "weird" }, null, true).status).toBeNull();
  });
  it("days left: no recent sales (shown as a dash) when the pace is zero, dash when unknown, whole days rounded down", () => {
    expect(daysLeftView({ daysLeft: null, neverRunsOut: true })).toEqual({ kind: "noSales" });
    expect(daysLeftView({ daysLeft: null, neverRunsOut: false })).toEqual({ kind: "none" });
    expect(daysLeftView({ daysLeft: 9.7, neverRunsOut: false })).toEqual({ kind: "days", days: 9 });
    expect(daysLeftView({ daysLeft: 0, neverRunsOut: false })).toEqual({ kind: "days", days: 0 });
  });
  it("rate with one decimal", () => {
    expect(formatRate(2.345, "en")).toBe("2.3");
    expect(formatRate(2, "de")).toBe("2,0");
    expect(formatRate(null, "en")).toBe("—");
  });
  it("variant ids and names", () => {
    expect(variantNumericId("gid://shopify/ProductVariant/123")).toBe("123");
    expect(variantGid("123")).toBe("gid://shopify/ProductVariant/123");
    expect(variantGid("12a")).toBeNull();
    expect(variantGid("")).toBeNull();
    expect(variantName("Default Title")).toBeNull();
    expect(variantName("M")).toBe("M");
  });
});

describe("CSV", () => {
  it("neutralises formula injection", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("Shirt")).toBe("Shirt");
  });
  it("quotes commas, quotes and newlines; numbers raw; null empty", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvLine(["a", 1, null])).toBe("a,1,");
  });
  it("file has a BOM and CRLF line ends", () => {
    expect(toCsv(["h"], [["v"]])).toBe("﻿h\r\nv\r\n");
  });
  it("products CSV: Growth includes forecast columns, a dash (never ∞) when there are no recent sales", () => {
    const rows: ProductRow[] = [
      toProductRow(variant, metric, { onHand: 12, incoming: 0 }, true, null, "2026-10-16"),
      toProductRow({ ...variant, id: "gid://shopify/ProductVariant/7", variantTitle: "Default Title", productTitle: "=cmd" }, { ...metric, status: "too_much", neverRunsOut: true, daysLeft: null, orderBy: null, orderQty: null }, null, true, null, "2026-10-16"),
    ];
    const lines = productsCsv(rows, id, true).replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Product,Variant,SKU,Vendor,Status,On hand,Incoming,Sales per day while in stock,Days of stock,Order by,Suggested qty");
    // The status column says the screen's status words (clarity pass 2026-10-23).
    expect(lines[1]).toBe("Linen shirt,M / Blue,LS-M-B,Acme,Order soon,12,0,2.3,9,2026-10-20,30");
    expect(lines[2]).toBe("'=cmd,,LS-M-B,Acme,Too much,,,2.3,—,,");
    const free = productsCsv([toProductRow(variant, metric, null, false, null, "2026-10-16")], id, false).trim().split("\r\n");
    expect(free[1]).toBe("Linen shirt,M / Blue,LS-M-B,Acme,Order soon,,,2.3,,,");
  });
});

describe("detail series", () => {
  const today = "2026-10-16";
  it("one entry per day, missing days stay null, sold-out only when every location is out", () => {
    const s = dailySeries(
      [
        { day: "2026-10-15", sold: 2 },
        { day: new Date("2026-10-15T00:00:00Z"), sold: 3 },
        { day: "2026-10-13", sold: 0 },
      ],
      [
        { day: "2026-10-15", outOfStock: true },
        { day: "2026-10-15", outOfStock: false },
        { day: "2026-10-14", outOfStock: true },
        { day: "2026-10-14", outOfStock: true },
      ],
      today,
      4,
    );
    expect(s).toEqual([
      { day: "2026-10-12", sold: null, out: null },
      { day: "2026-10-13", sold: 0, out: null },
      { day: "2026-10-14", sold: null, out: true },
      { day: "2026-10-15", sold: 5, out: false },
    ]);
    expect(recentDays(s, 2).map((d) => d.day)).toEqual(["2026-10-15", "2026-10-14"]);
  });
  it("13 months by default, ending yesterday", () => {
    const s = dailySeries([], [], today);
    expect(s).toHaveLength(395);
    expect(s.at(-1)!.day).toBe("2026-10-15");
  });
  it("month totals: null when a month has no sales data", () => {
    const months = monthlyTotals([
      { day: "2026-09-30", sold: null, out: true },
      { day: "2026-10-01", sold: 2, out: false },
      { day: "2026-10-02", sold: 3, out: true },
    ]);
    expect(months).toEqual([
      { month: "2026-10", sold: 5, outDays: 1, dataDays: 2 },
      { month: "2026-09", sold: null, outDays: 1, dataDays: 0 },
    ]);
  });
  it("forecast inputs: read defensively, safety = the stored engine safety, else z × σ × √(lead + cycle)", () => {
    const v = readForecastInputs(
      {
        windows: [
          { days: 28, weight: 0.5, inStockDays: 20, soldInStock: 40, rate: 2, used: true },
          { days: 56, weight: 0.3, inStockDays: 5, soldInStock: 5, rate: 1, used: false },
        ],
        inStockDays: 60,
        historyDays: 90,
        seasonal: 1,
        trend: 1,
        leadTimeDays: 16,
        leadTimeSource: "default",
        cycleDays: 14,
        z: 1.65,
      },
      2,
    );
    expect(v?.windows).toHaveLength(2);
    expect(v?.windows[1]!.used).toBe(false);
    expect(v?.safety).toBeCloseTo(1.65 * 2 * Math.sqrt(16 + 14));
    // The engine's stored figure wins (it is what the order quantity used).
    expect(readForecastInputs({ z: 1.65, leadTimeDays: 16, cycleDays: 14, safety: 21.5 }, 2)?.safety).toBe(21.5);
    expect(v?.leadTimeSource).toBe("default");
    expect(readForecastInputs({ z: 1.65, leadTimeDays: 14 }, null)?.safety).toBeNull();
    expect(readForecastInputs(null, 1)).toBeNull();
    expect(readForecastInputs({ windows: "nope" }, null)?.windows).toEqual([]);
  });
});
