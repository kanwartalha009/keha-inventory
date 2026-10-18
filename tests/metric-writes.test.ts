/**
 * VariantMetric change-only writes (DB scale "before 1,000 stores", services/metric-writes.server
 * + lib/metric-store-shared): a second run with the same content rewrites nothing, a changed
 * row is the only one rewritten, the sweep removes variants the run did not confirm, MetricRun
 * records each run, and the stored inputs are slim (nothing that only moves with the calendar).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], metricRun: ["shop", "scope"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { forgetMetricRuns, latestMetricRun, sweepVariantMetrics, writeVariantMetrics, type MetricData } from "../app/services/metric-writes.server";
import { ERROR_KEEP, STORED_INPUTS_OMIT, metricContentText, roundDeep, slimInputs, stableJson, storedMetric, storedNumber } from "../app/lib/metric-store-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const RUN1 = new Date("2026-10-16T03:00:00Z");
const RUN2 = new Date("2026-10-17T03:00:00Z");

const row = (n: number, at: Date, over: Partial<MetricData> = {}, inputs: Record<string, unknown> = {}): MetricData => ({
  variantId: V(n),
  rate: 1 + n / 10,
  sigma: 0.5,
  daysLeft: 30,
  neverRunsOut: false,
  status: "healthy",
  role: "B",
  orderQty: null,
  orderBy: null,
  computedAt: at,
  inputs: { today: at.toISOString().slice(0, 10), productAgeDays: at === RUN1 ? 100 : 101, noSaleDays: 0, leadTimeDays: 14, onHand: 20, ...inputs },
  ...over,
});
const writes = () => db.calls.filter((c) => c.table === "variantMetric" && (c.op === "createMany" || c.op === "deleteMany"));

beforeEach(() => {
  db.reset();
  forgetMetricRuns();
});

describe("change-only VariantMetric writes", () => {
  it("a run whose content did not change rewrites nothing (the calendar alone changes nothing)", async () => {
    expect(await writeVariantMetrics(S, "online", [1, 2, 3].map((n) => row(n, RUN1)))).toBe(3);
    await sweepVariantMetrics(S, "online", RUN1, RUN1);
    expect(db.tables.metricRun).toEqual([{ shop: S, scope: "online", startedAt: RUN1, finishedAt: RUN1, rows: 3, changed: 3, curves: {} }]);
    db.calls.length = 0;
    // Next night: same numbers; today and the product's age moved — not stored, so no change.
    expect(await writeVariantMetrics(S, "online", [1, 2, 3].map((n) => row(n, RUN2)))).toBe(0);
    expect(await sweepVariantMetrics(S, "online", RUN2, RUN2)).toBe(0);
    expect(writes()).toEqual([]);
    expect(db.tables.variantMetric.every((m) => (m.computedAt as Date).getTime() === RUN1.getTime())).toBe(true);
    expect(db.tables.metricRun).toEqual([{ shop: S, scope: "online", startedAt: RUN2, finishedAt: RUN2, rows: 3, changed: 0, curves: {} }]);
    expect(await latestMetricRun(S, "online")).toEqual(RUN2);
  });

  it("only the changed row is rewritten; the sweep removes variants the run did not confirm", async () => {
    await writeVariantMetrics(S, "online", [1, 2, 3].map((n) => row(n, RUN1)));
    await sweepVariantMetrics(S, "online", RUN1);
    db.calls.length = 0;
    expect(await writeVariantMetrics(S, "online", [row(1, RUN2), row(2, RUN2, { status: "low" })])).toBe(1);
    expect(writes().map((c) => c.op)).toEqual(["deleteMany", "createMany"]);
    expect(await sweepVariantMetrics(S, "online", RUN2)).toBe(1); // V(3) is no longer computed
    const by = new Map(db.tables.variantMetric.map((m) => [m.variantId, m]));
    expect([...by.keys()].sort()).toEqual([V(1), V(2)]);
    expect(by.get(V(2))).toMatchObject({ status: "low", computedAt: RUN2 });
    expect(by.get(V(1))).toMatchObject({ status: "healthy", computedAt: RUN1 });
    expect(db.tables.metricRun[0]).toMatchObject({ startedAt: RUN2, rows: 2, changed: 1 });
  });

  it("scopes are separate runs; a run that wrote nothing for a scope empties it", async () => {
    await writeVariantMetrics(S, "online", [row(1, RUN1)]);
    await writeVariantMetrics(S, "gid://shopify/Location/1", [row(1, RUN1)]);
    await sweepVariantMetrics(S, "online", RUN1);
    await sweepVariantMetrics(S, "gid://shopify/Location/1", RUN1);
    await writeVariantMetrics(S, "online", [row(1, RUN2)]);
    await sweepVariantMetrics(S, "online", RUN2);
    expect(await sweepVariantMetrics(S, "gid://shopify/Location/1", RUN2)).toBe(1);
    expect(db.tables.variantMetric.map((m) => m.scope)).toEqual(["online"]);
    expect(db.tables.metricRun.map((r) => r.scope)).toEqual(["online"]);
  });

  it("stores slim inputs and a content hash", async () => {
    await writeVariantMetrics(S, "online", [row(1, RUN1, {}, { seasonCurve: null, windows: [{ days: 28, weight: 0.5, inStockDays: 28, soldInStock: 30.5, rate: 1.1, used: true }] })]);
    const m = db.tables.variantMetric[0]!;
    const inputs = m.inputs as Record<string, unknown>;
    for (const k of STORED_INPUTS_OMIT) expect(inputs).not.toHaveProperty(k);
    expect(inputs).not.toHaveProperty("today"); // no seasonal curve: the forward plan reads no date
    expect(inputs.productCreatedDay).toBe("2026-07-08"); // 100 days before 16 Oct
    expect(inputs.windows).toEqual([{ days: 28, weight: 0.5, inStockDays: 28, rate: 1.1, used: true }]);
    expect(m.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("perf 2026-10-18: float noise alone rewrites nothing (floats stored at 12 significant digits)", async () => {
    const noisy = (at: Date, eps: number) =>
      row(1, at, { rate: 0.17950549357115034 + eps, sigma: 0.5837366805501096 - eps, daysLeft: 47.926384962899256 + 10 * eps }, { safety: 3.0000000000000004 - eps, windows: [{ days: 28, weight: 0.5, inStockDays: 28, rate: 1.2000000000000002 + eps, used: true }] });
    expect(await writeVariantMetrics(S, "online", [noisy(RUN1, 0)])).toBe(1);
    await sweepVariantMetrics(S, "online", RUN1);
    const m = db.tables.variantMetric[0]!;
    expect(m.rate).toBe(0.179505493571);
    expect((m.inputs as Record<string, unknown>).safety).toBe(3);
    // Next night the same figures with a couple of ulps of noise (sums in another order).
    expect(await writeVariantMetrics(S, "online", [noisy(RUN2, 2 * Number.EPSILON)])).toBe(0);
    // A real change is still written.
    expect(await writeVariantMetrics(S, "online", [row(1, RUN2, { rate: 0.1796 })])).toBe(1);
  });

  it("perf 2026-10-18: inputs.error keeps what the product page and Why show, not the backtest internals", async () => {
    const error = { horizonDays: 44, model: 12.1, sigma: 12.6, ratio: 1.04, prior: 1.1, used: 1.07, samples: 13, windows: 3.2, bias: -0.08, fill: 0.95, k: 0.89 };
    await writeVariantMetrics(S, "online", [row(1, RUN1, {}, { error })]);
    const stored = (db.tables.variantMetric[0]!.inputs as Record<string, unknown>).error as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([...ERROR_KEEP].sort());
    expect(stored).toEqual({ horizonDays: 44, sigma: 12.6, ratio: 1.04, used: 1.07, samples: 13, fill: 0.95, k: 0.89 });
  });
});

describe("metric-store-shared", () => {
  it("keeps today with a seasonal curve (the forward plan offsets the curve from it)", () => {
    expect(slimInputs({ today: "2026-10-16", seasonCurve: [1, 1.2], z: 1.65 })).toEqual({ today: "2026-10-16", seasonCurve: [1, 1.2], z: 1.65 });
  });

  it("keeps the season's source and flags, not its day-relative spans", () => {
    const season = { level: "collection", collectionId: "gid://shopify/Collection/7", productType: null, seasonalApplied: true, seasonalRaw: 1.3, horizonDays: 28, lastYearSpan: { from: "2025-10-17" }, trendMeasured: 1.1, trendNote: null };
    expect(slimInputs({ season })).toEqual({ season: { level: "collection", collectionId: "gid://shopify/Collection/7", productType: null, seasonalApplied: true, horizonDays: 28, trendMeasured: 1.1, trendNote: null } });
  });

  it("hashes content, not key order or computedAt", () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    const base = { rate: 1, sigma: null, daysLeft: null, neverRunsOut: true, status: "healthy", role: "A", orderQty: null, orderBy: new Date("2026-11-01T00:00:00Z"), inputs: { x: 1, y: 2 } };
    expect(metricContentText(base)).toBe(metricContentText({ ...base, inputs: { y: 2, x: 1 } }));
    expect(metricContentText(base)).not.toBe(metricContentText({ ...base, orderQty: 1 }));
  });

  it("rounds floats only: integers, null, strings, dates and non-finite values are kept", () => {
    expect(storedNumber(1 / 3)).toBe(0.333333333333);
    expect(storedNumber(123456789.123456789)).toBe(123456789.123);
    expect(storedNumber(42)).toBe(42);
    expect(storedNumber(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundDeep({ a: [1 / 3, null, "x"], b: { c: 2 / 3 }, d: true })).toEqual({ a: [0.333333333333, null, "x"], b: { c: 0.666666666667 }, d: true });
    const m = { rate: 1 / 7, sigma: null, daysLeft: 1e-20 / 3, inputs: { z: 1.65 } };
    expect(storedMetric(m)).toEqual({ rate: 0.142857142857, sigma: null, daysLeft: 3.33333333333e-21, inputs: { z: 1.65 } });
    expect(m.rate).toBe(1 / 7); // the input is untouched
  });

  it("anything else is stored as is", () => {
    expect(slimInputs(null)).toBeNull();
    expect(slimInputs({ kehaOrders: [{ po: "a", open: 1 }], safety: 3, arrivals: [] })).toEqual({ kehaOrders: [{ po: "a", open: 1 }], safety: 3, arrivals: [] });
  });
});
