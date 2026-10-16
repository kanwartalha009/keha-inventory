/**
 * Compute helpers (task 1.5): online pool, pooled out-of-stock rule, series building (missing
 * days stay missing), product path matching (locale prefixes), sold-out traffic days, store
 * conversion / AOV, metric rows (Infinity → neverRunsOut), Free-plan money refresh.
 */
import { describe, expect, it } from "vitest";
import {
  buildSeries,
  engineSettingsFrom,
  jsonSafe,
  metricRow,
  moneyDue,
  poolLocationIds,
  pooledOutOfStock,
  productHandleFromPath,
  productTraffic,
  revenueOf,
  sessionsByHandle,
  storeConversion,
} from "../app/lib/compute-shared";
import { DEFAULT_SETTINGS } from "../app/lib/settings-shared";
import type { VariantResult } from "../app/lib/engine/index-shared";

describe("pool", () => {
  it("is the active locations that fulfil online orders", () => {
    expect(
      poolLocationIds([
        { id: "L1", active: true, online: true },
        { id: "L2", active: true, online: false },
        { id: "L3", active: false, online: true },
      ]),
    ).toEqual(["L1"]);
  });

  it("a day is out when pooled units ≤ 0 or every reporting location is out", () => {
    expect(pooledOutOfStock({ endUnits: 0, reported: 2, outReported: 0 })).toBe(true);
    expect(pooledOutOfStock({ endUnits: 5, reported: 2, outReported: 2 })).toBe(true);
    expect(pooledOutOfStock({ endUnits: 5, reported: 2, outReported: 1 })).toBe(false);
    expect(pooledOutOfStock({ endUnits: -3, reported: 1, outReported: 0 })).toBe(true);
  });
});

describe("buildSeries", () => {
  const sales = [
    { variantId: "a", day: "2026-10-02", sold: 2, gross: 50 },
    { variantId: "a", day: "2026-10-02", sold: 1, gross: 25 }, // second channel, same day
    { variantId: "a", day: "2026-10-04", sold: 1, gross: 30 },
  ];
  const stock = [
    { variantId: "a", day: "2026-10-01", endUnits: 10, reported: 1, outReported: 0 },
    { variantId: "a", day: "2026-10-02", endUnits: 7, reported: 1, outReported: 0 },
    { variantId: "a", day: "2026-10-05", endUnits: 0, reported: 1, outReported: 1 },
  ];
  const s = buildSeries(sales, stock).get("a")!;

  it("joins sales and stock by day, sorted, missing days absent", () => {
    expect(s.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05"]);
    expect(s.find((r) => r.day === "2026-10-03")).toBeUndefined();
  });

  it("sums channels, prices as gross ÷ units, stock-only days sell 0", () => {
    expect(s[1]).toEqual({ day: "2026-10-02", sold: 3, endStock: 7, outOfStock: false, price: 25 });
    expect(s[0]).toEqual({ day: "2026-10-01", sold: 0, endStock: 10, outOfStock: false, price: null });
    expect(s[3].outOfStock).toBe(true);
  });

  it("a sales day with no stock row counts as in stock", () => {
    expect(s[2]).toMatchObject({ day: "2026-10-04", sold: 1, outOfStock: false, price: 30 });
  });

  it("revenue per variant", () => {
    expect(revenueOf(sales).get("a")).toBe(105);
  });
});

describe("product paths", () => {
  it.each([
    ["/products/basic-tee", "basic-tee"],
    ["/products/basic-tee/", "basic-tee"],
    ["/products/Basic-Tee?variant=1#x", "basic-tee"],
    ["/es/products/basic-tee", "basic-tee"],
    ["/en-us/products/basic-tee", "basic-tee"],
    ["/collections/summer/products/basic-tee", "basic-tee"],
    ["/fr/collections/summer/products/basic-tee", "basic-tee"],
    ["/products/caf%C3%A9", "café"],
  ])("%s → %s", (path, handle) => {
    expect(productHandleFromPath(path)).toBe(handle);
  });

  it.each(["/", "/collections/summer", "/products", "/products/", "/pages/products/x", "/blogs/news/products/x", "unknown"])(
    "%s is not a product page",
    (path) => {
      expect(productHandleFromPath(path)).toBeNull();
    },
  );

  it("sums sessions per handle per day across locale variants", () => {
    const m = sessionsByHandle([
      { landingPath: "/products/mug", day: "2026-10-06", sessions: 10 },
      { landingPath: "/es/products/mug", day: "2026-10-06", sessions: 5 },
      { landingPath: "/", day: "2026-10-06", sessions: 100 },
    ]);
    expect(m.get("mug")?.get("2026-10-06")).toBe(15);
    expect(m.size).toBe(1);
  });
});

describe("productTraffic", () => {
  const series = buildSeries(
    [],
    [
      { variantId: "s", day: "2026-10-06", endUnits: 0, reported: 1, outReported: 1 },
      { variantId: "m", day: "2026-10-06", endUnits: 0, reported: 1, outReported: 1 },
      { variantId: "s", day: "2026-10-07", endUnits: 0, reported: 1, outReported: 1 },
      { variantId: "m", day: "2026-10-07", endUnits: 3, reported: 1, outReported: 0 },
      { variantId: "s", day: "2026-10-08", endUnits: 0, reported: 1, outReported: 1 }, // m missing → unknown day
    ],
  );
  const sessions = new Map([["tee", new Map([["2026-10-06", 12], ["2026-10-07", 9]])]]);

  it("fully out only when every variant is out; days with a missing variant are skipped", () => {
    const [p] = productTraffic([{ productId: "P", handle: "Tee", variantIds: ["s", "m"] }], series, sessions, "2026-10-01", "2026-10-15");
    expect(p.days).toEqual([
      { day: "2026-10-06", fullyOutOfStock: true, sessions: 12 },
      { day: "2026-10-07", fullyOutOfStock: false, sessions: 9 },
    ]);
  });

  it("respects the window", () => {
    const [p] = productTraffic([{ productId: "P", handle: "tee", variantIds: ["s", "m"] }], series, sessions, "2026-10-07", "2026-10-15");
    expect(p.days.map((d) => d.day)).toEqual(["2026-10-07"]);
  });
});

describe("store conversion", () => {
  it("is null when unknown, never 0 by default", () => {
    expect(storeConversion({ sessions: 1000, checkouts: 20, orders: 10, gross: 500 })).toEqual({ conversionRate: 0.02, aov: 50 });
    expect(storeConversion({ sessions: 0, checkouts: 0, orders: 0, gross: 0 })).toEqual({ conversionRate: null, aov: null });
  });
});

describe("rows and refresh", () => {
  const base = { rate: 0, sigma: 0, status: "dead", role: "C", orderQty: null, orderBy: null } as unknown as VariantResult;

  it("Infinity days left → null + neverRunsOut", () => {
    const m = metricRow({ ...base, daysLeft: Infinity, inputs: { x: Infinity } } as unknown as VariantResult);
    expect(m).toMatchObject({ daysLeft: null, neverRunsOut: true, inputs: { x: null } });
    expect(metricRow({ ...base, daysLeft: 12.5, inputs: {} } as unknown as VariantResult)).toMatchObject({ daysLeft: 12.5, neverRunsOut: false });
    expect(metricRow({ ...base, daysLeft: null, inputs: {} } as unknown as VariantResult)).toMatchObject({ daysLeft: null, neverRunsOut: false });
    expect(jsonSafe({ a: NaN, b: [1, -Infinity] })).toEqual({ a: null, b: [1, null] });
  });

  it("Free refreshes money once per calendar month; paid plans daily", () => {
    expect(moneyDue("daily", "2026-10-16", "2026-10-16")).toBe(true);
    expect(moneyDue("monthly", null, "2026-10-16")).toBe(true);
    expect(moneyDue("monthly", "2026-10-01", "2026-10-16")).toBe(false);
    expect(moneyDue("monthly", "2026-09-30", "2026-10-01")).toBe(true);
  });

  it("maps shop settings to engine settings", () => {
    expect(engineSettingsFrom({ ...DEFAULT_SETTINGS, leadTimeDays: 21 })).toEqual({ leadTimeDays: 21, cycleDays: 14, tooMuchDays: 180, deadDays: 90 });
  });
});
