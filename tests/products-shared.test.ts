/**
 * Products helpers (app/lib/products-shared.ts, task 1.7): status labels,
 * filters, paging maths, row mapping, CSV escaping and the detail series.
 */
import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  STATUS_ORDER,
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
  recentDays,
  statusLabel,
  statusTone,
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

describe("status", () => {
  it("labels every engine status with the spec wording", () => {
    expect(VARIANT_STATUSES.map((s) => statusLabel(s, id))).toEqual([
      "Out",
      "Not enough data",
      "Dead",
      "Running low",
      "Too much",
      "Healthy",
    ]);
  });
  it("orders the filter Out → Not enough data and covers every status", () => {
    expect([...STATUS_ORDER].sort()).toEqual([...VARIANT_STATUSES].sort());
    expect(STATUS_ORDER[0]).toBe("out");
  });
  it("tones", () => {
    expect(statusTone("out")).toBe("critical");
    expect(statusTone("running_low")).toBe("warning");
    expect(statusTone("healthy")).toBe("success");
  });
});

describe("filters and paging", () => {
  it("parses known values and drops unknown statuses", () => {
    const f = parseFilters(new URLSearchParams("status=bogus&vendor=%20Acme%20&q=&collection=Summer"));
    expect(f).toEqual({ status: null, collection: "Summer", vendor: "Acme", q: null });
    expect(parseFilters(new URLSearchParams("status=too_much")).status).toBe("too_much");
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
  it("days left: ∞ when never runs out, dash when unknown, whole days rounded down", () => {
    expect(daysLeftView({ daysLeft: null, neverRunsOut: true })).toEqual({ kind: "never" });
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
  it("products CSV: Growth includes forecast columns, ∞ for never", () => {
    const rows: ProductRow[] = [
      toProductRow(variant, metric, { onHand: 12, incoming: 0 }, true),
      toProductRow({ ...variant, id: "gid://shopify/ProductVariant/7", variantTitle: "Default Title", productTitle: "=cmd" }, { ...metric, status: "too_much", neverRunsOut: true, daysLeft: null }, null, true),
    ];
    const lines = productsCsv(rows, id, true).replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Product,Variant,SKU,Vendor,Status,Stock now,Incoming,Sales per day while in stock,Days of stock left,Order by,Suggested qty");
    expect(lines[1]).toBe("Linen shirt,M / Blue,LS-M-B,Acme,Running low,12,0,2.3,9,2026-10-20,30");
    expect(lines[2]).toBe("'=cmd,,LS-M-B,Acme,Too much,,,2.3,∞,2026-10-20,30");
    const free = productsCsv([toProductRow(variant, metric, null, false)], id, false).trim().split("\r\n");
    expect(free[1]).toBe("Linen shirt,M / Blue,LS-M-B,Acme,Running low,,,2.3,,,");
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
  it("forecast inputs: read defensively, safety = z × σ × √lead time", () => {
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
    expect(v?.safety).toBeCloseTo(1.65 * 2 * 4);
    expect(v?.leadTimeSource).toBe("default");
    expect(readForecastInputs({ z: 1.65, leadTimeDays: 14 }, null)?.safety).toBeNull();
    expect(readForecastInputs(null, 1)).toBeNull();
    expect(readForecastInputs({ windows: "nope" }, null)?.windows).toEqual([]);
  });
});
