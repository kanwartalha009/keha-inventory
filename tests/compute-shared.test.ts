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
  poolSalesKeys,
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
  const poolSales = [
    { variantId: "a", day: "2026-10-02", sold: 2, gross: 0 }, // online
    { variantId: "a", day: "2026-10-02", sold: 1, gross: 0 }, // a pool location's POS
    { variantId: "a", day: "2026-10-04", sold: 1, gross: 0 }, // no pool stock row that day
  ];
  const channelSales = [
    { variantId: "a", day: "2026-10-02", sold: 2, gross: 50 },
    { variantId: "a", day: "2026-10-02", sold: 1, gross: 25 },
    { variantId: "a", day: "2026-10-04", sold: 1, gross: 30 },
  ];
  const stock = [
    { variantId: "a", day: "2026-10-01", endUnits: 10, reported: 1, outReported: 0 },
    { variantId: "a", day: "2026-10-02", endUnits: 7, reported: 1, outReported: 0 },
    { variantId: "a", day: "2026-10-05", endUnits: 0, reported: 1, outReported: 1 },
  ];
  const s = buildSeries(poolSales, stock, channelSales).get("a")!;

  it("a day exists only with a pool stock row; sales on other days are missing", () => {
    expect(s.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05"]);
    expect(s.find((r) => r.day === "2026-10-04")).toBeUndefined();
  });

  it("sums pool sales, prices from the channel view, stock-only days sell 0", () => {
    expect(s[1]).toEqual({ day: "2026-10-02", sold: 3, endStock: 7, outOfStock: false, price: 25 });
    expect(s[0]).toEqual({ day: "2026-10-01", sold: 0, endStock: 10, outOfStock: false, price: null });
    expect(s[2].outOfStock).toBe(true);
  });

  it("H1: a day that ended at ≤ 0 units but still sold (backorders) is not a sold-out day", () => {
    const rows = buildSeries(
      [{ variantId: "b", day: "2026-10-03", sold: 4, gross: 0 }],
      [
        { variantId: "b", day: "2026-10-03", endUnits: -4, reported: 1, outReported: 1 }, // oversold, still selling
        { variantId: "b", day: "2026-10-04", endUnits: -4, reported: 1, outReported: 1 }, // out, nothing sold
      ],
    ).get("b")!;
    expect(rows.map((r) => [r.day, r.outOfStock])).toEqual([
      ["2026-10-03", false],
      ["2026-10-04", true],
    ]);
  });

  it("a variant with sales but no pool stock rows has no series at all", () => {
    expect(buildSeries([{ variantId: "z", day: "2026-10-02", sold: 1, gross: 0 }], []).get("z")).toBeUndefined();
  });

  it("pool sales keys are online + the pool location ids", () => {
    expect(poolSalesKeys(["L1", "L3"])).toEqual(["online", "L1", "L3"]);
  });

  it("revenue per variant (channel view)", () => {
    expect(revenueOf(channelSales).get("a")).toBe(105);
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
    expect(engineSettingsFrom({ ...DEFAULT_SETTINGS, leadTimeDays: 21 })).toEqual({
      leadTimeDays: 21,
      cycleDays: 14,
      tooMuchDays: 180,
      deadDays: 90,
      z: { A: 1.65, B: 1.28, C: 1.04 },
    });
  });

  it("maps the safety level to z per role", () => {
    expect(engineSettingsFrom({ ...DEFAULT_SETTINGS, safetyLevel: "lean" }).z).toEqual({ A: 1.04, B: 0.84, C: 0.67 });
    expect(engineSettingsFrom({ ...DEFAULT_SETTINGS, safetyLevel: "safe" }).z).toEqual({ A: 2.05, B: 1.65, C: 1.28 });
  });
});

describe("task 2.1 helpers", () => {
  it("salesCoverage reads the sales dataset's stored range and skipped months", async () => {
    const { salesCoverage } = await import("../app/lib/compute-shared");
    expect(salesCoverage({})).toEqual({ from: null, to: null });
    expect(
      salesCoverage({ syncedThrough: "2026-10-15", datasets: { sales: { done: 13, total: 13, doneThrough: "2025-10-01", skippedMonths: ["2026-02-01"] } } }),
    ).toEqual({ from: "2025-10-01", to: "2026-10-15", skippedMonths: ["2026-02"] });
    expect(salesCoverage({ datasets: { sales: { done: 1, total: 13, doneThrough: "2026-10-01", syncedThrough: "2026-10-15" } } })).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
  });

  it("planActionWrites reopens a done row only when it still triggers 30+ days after done", async () => {
    const { planActionWrites } = await import("../app/lib/compute-shared");
    const now = new Date("2026-12-01T00:00:00Z");
    const draft = (productId: string) => ({ kind: "clear" as const, productId, variantIds: ["v"], amount: 100, reason: { key: "clear_dead", params: {} } });
    const plan = planActionWrites(
      [
        { dedupeKey: "clear:old", state: "done", doneAt: new Date("2026-10-31T00:00:00Z") },
        { dedupeKey: "clear:recent", state: "done", doneAt: new Date("2026-11-20T00:00:00Z") },
        { dedupeKey: "clear:gone", state: "done", doneAt: new Date("2026-01-01T00:00:00Z") },
      ],
      [draft("old"), draft("recent")],
      now,
    );
    expect(plan.reopenKeys).toEqual(["clear:old"]);
    expect(planActionWrites([{ dedupeKey: "clear:old", state: "done", doneAt: null }], [draft("old")]).reopenKeys).toEqual([]);
  });

  it("planActionWrites deletes open AND snoozed rows that stopped triggering; keeps dismissed and done (review fix)", async () => {
    const { planActionWrites } = await import("../app/lib/compute-shared");
    const draft = (productId: string) => ({ kind: "clear" as const, productId, variantIds: ["v"], amount: 1, reason: { key: "k", params: {} } });
    const plan = planActionWrites(
      [
        { dedupeKey: "clear:P1", state: "snoozed", productId: "P1" },
        { dedupeKey: "clear:P2", state: "dismissed", productId: "P2" },
        { dedupeKey: "clear:P3", state: "done", productId: "P3" },
        { dedupeKey: "clear:P4", state: "snoozed", productId: "P4" },
        // Archived / untracked / bundle products (not live): purged whatever the state.
        { dedupeKey: "clear:GONE1", state: "dismissed", productId: "GONE1" },
        { dedupeKey: "clear:GONE2", state: "done", productId: "GONE2" },
        { dedupeKey: "clear:GONE3", state: "snoozed", productId: "GONE3" },
      ],
      [draft("P4")],
      undefined,
      new Set(["P1", "P2", "P3", "P4"]),
    );
    expect(plan.deleteKeys).toEqual(["clear:P1"]);
    expect(plan.purgeKeys).toEqual(["clear:GONE1", "clear:GONE2", "clear:GONE3"]);
  });

  it("planActionWrites upserts every draft once and deletes open / snoozed rows that stopped triggering", async () => {
    const { planActionWrites } = await import("../app/lib/compute-shared");
    const draft = (kind: "reorder" | "clear", productId: string) => ({ kind, productId, variantIds: ["v"], amount: 1, reason: { key: "k", params: {} } });
    const plan = planActionWrites(
      [
        { dedupeKey: "reorder:P1", state: "open" },
        { dedupeKey: "clear:P2", state: "open" },
        { dedupeKey: "clear:P3", state: "snoozed" },
        { dedupeKey: "clear:P4", state: "done" },
      ],
      [draft("reorder", "P1"), draft("reorder", "P1"), draft("clear", "P9")],
    );
    expect(plan.upserts.map((u) => u.dedupeKey)).toEqual(["reorder:P1", "clear:P9"]);
    expect(plan.deleteKeys).toEqual(["clear:P2", "clear:P3"]);
    expect(plan.purgeKeys).toEqual([]);
  });

  it("soldOver counts only days with data; null when none", async () => {
    const { soldOver } = await import("../app/lib/compute-shared");
    const rows = [
      { day: "2026-09-17", sold: 100, endStock: 1, outOfStock: false },
      { day: "2026-09-18", sold: 2, endStock: 1, outOfStock: false },
      { day: "2026-10-15", sold: 3, endStock: 1, outOfStock: true },
      { day: "2026-10-16", sold: 50, endStock: 1, outOfStock: false },
    ];
    expect(soldOver(rows, "2026-10-16", 28)).toBe(5);
    expect(soldOver([], "2026-10-16", 28)).toBeNull();
    expect(soldOver([rows[0]], "2026-10-16", 28)).toBeNull();
  });

  it("kehaOpenUnits: ordered minus received per variant, across orders", async () => {
    const { kehaOpenUnits } = await import("../app/lib/compute-shared");
    const m = kehaOpenUnits([
      { lines: [{ variantId: "a", qty: 10, received: 4 }, { variantId: "b", qty: 3, received: 5 }] },
      { lines: [{ variantId: "a", qty: 2 }] },
    ]);
    expect([...m]).toEqual([["a", 8]]);
  });

  it("review fix: withLandedEstimate subtracts units that landed early or in part (auto-receive maths)", async () => {
    const { withLandedEstimate, kehaOpenUnits } = await import("../app/lib/compute-shared");
    const facts = (onHand: Record<string, number>, sold: Record<string, number> = {}, base: Record<string, number> = {}) => ({
      onHand: new Map(Object.entries(onHand)),
      baseline: (v: string, d: string) => base[`${v}|${d}`],
      soldSince: (v: string) => sold[v] ?? 0,
    });
    // 100 ordered, base 10 at send; now 50 on hand after 20 sold → 60 landed → 40 still to come.
    const pos: import("../app/lib/compute-shared").OpenPo[] = [{ source: "keha", arrival: "2026-11-30", sentDay: "2026-10-01", lines: [{ variantId: "a", qty: 100, baseOnHand: 10 }] }];
    const after = withLandedEstimate(pos, facts({ a: 50 }, { a: 20 }));
    expect(kehaOpenUnits(after).get("a")).toBe(40);
    expect(pos[0]!.lines[0]!.received).toBeUndefined(); // input untouched
    // Capped at the open units; a fall in stock is never negative.
    expect(kehaOpenUnits(withLandedEstimate(pos, facts({ a: 500 }))).get("a") ?? 0).toBe(0);
    expect(kehaOpenUnits(withLandedEstimate(pos, facts({ a: 0 }))).get("a")).toBe(100);
    // No baseline (no baseOnHand, no StockDaily the day before) or no on-hand now: unchanged.
    const noBase = [{ source: "keha", arrival: null, sentDay: "2026-10-01", lines: [{ variantId: "a", qty: 100 }] }];
    expect(kehaOpenUnits(withLandedEstimate(noBase, facts({ a: 90 }))).get("a")).toBe(100);
    expect(kehaOpenUnits(withLandedEstimate(pos, facts({}))).get("a")).toBe(100);
    // StockDaily baseline (the caller looks up the day before the send day).
    expect(kehaOpenUnits(withLandedEstimate(noBase, facts({ a: 90 }, {}, { "a|2026-10-01": 30 }))).get("a")).toBe(40);
    // Shopify orders are untouched.
    const shopify: import("../app/lib/compute-shared").OpenPo[] = [{ source: "shopify", arrival: null, sentDay: "2026-10-01", lines: [{ variantId: "a", qty: 100, baseOnHand: 0 }] }];
    expect(withLandedEstimate(shopify, facts({ a: 100 }))[0]!.lines[0]!.received).toBeUndefined();
  });

  it("review fix: two open orders of one variant share one delivery (never subtracted twice)", async () => {
    const { withLandedEstimate, kehaOpenUnits } = await import("../app/lib/compute-shared");
    const facts = { onHand: new Map([["a", 60]]), baseline: () => undefined, soldSince: () => 0 };
    const pos: import("../app/lib/compute-shared").OpenPo[] = [
      { source: "keha", arrival: "2026-10-20", sentDay: "2026-10-01", lines: [{ variantId: "a", qty: 50, baseOnHand: 10 }] },
      { source: "keha", arrival: "2026-10-25", sentDay: "2026-10-02", lines: [{ variantId: "a", qty: 50, baseOnHand: 10 }] },
    ];
    const after = withLandedEstimate(pos, facts);
    expect(kehaOpenUnits(after).get("a")).toBe(50);
    expect(after[0]!.lines[0]!.received).toBe(50); // oldest first
    expect(after[1]!.lines[0]!.received).toBeUndefined();
  });

  it("datedIncoming: one entry per dated order; undated orders left out", async () => {
    const { datedIncoming } = await import("../app/lib/compute-shared");
    const m = datedIncoming([
      { arrival: "2026-11-01", lines: [{ variantId: "a", qty: 10, received: 4 }] },
      { arrival: "2026-12-01", lines: [{ variantId: "a", qty: 5 }] },
      { arrival: null, lines: [{ variantId: "a", qty: 9 }] },
    ]);
    expect(m.get("a")).toEqual([{ arrival: "2026-11-01", units: 6 }, { arrival: "2026-12-01", units: 5 }]);
  });

  it("poArrivals: earliest dated arrival and open units per variant; undated orders ignored", async () => {
    const { poArrivals } = await import("../app/lib/compute-shared");
    const m = poArrivals([
      { arrival: "2026-11-01", lines: [{ variantId: "a", qty: 10 }, { variantId: "b", qty: 5, received: 5 }] },
      { arrival: "2026-10-25", lines: [{ variantId: "a", qty: 4, received: 1 }] },
      { arrival: null, lines: [{ variantId: "c", qty: 9 }] },
    ]);
    expect(m.get("a")).toEqual({ arrival: "2026-10-25", units: 13 });
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(false);
  });
});
