/**
 * The order plan's typed columns (perf 2026-10-18, lib/plan-columns-shared): what the order plan
 * rebuilds from the columns and the run's curves gives the forward plan, the Keha "since the run"
 * rule and the order plan's own reads exactly what the stored inputs give — on every metric the
 * scale fixture's compute writes (pool and locations, seasonal curves, an open Keha order) — and
 * the order plan reads only the columns (computeOrderPlan equal with and without them).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ variantMetric: ["shop", "variantId", "scope"], moneyAtStake: ["shop", "day"], action: ["shop", "dedupeKey"], metricRun: ["shop", "scope"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/services/entitlements.server", () => ({ planFor: async () => "pro" }));

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { computeShop } from "../app/services/compute.server";
import { computeOrderPlan } from "../app/models/order-plan.server";
import { storedInputs } from "../app/lib/metric-store-shared";
import { PLAN_COLUMNS_VERSION, curveOf, planColumnsOf, planInputsOf, readCurves } from "../app/lib/plan-columns-shared";
import { forwardInputFromMetric } from "../app/lib/engine/forward-plan-shared";
import { kehaSinceRun, readKehaShares } from "../app/lib/keha-since-run-shared";
import { FX_NOW, FX_SHOP, seedScaleFixture } from "./fixtures/scale-compute-fixture";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(db);
const golden = JSON.parse(readFileSync(join(__dirname, "fixtures", "scale-compute-golden.json"), "utf8")) as Record<string, { output: { metrics: { status: string; rate: number | null; sigma: number | null; orderQty: number | null; inputs: unknown }[] } }>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const num = (inputs: unknown, k: string) => {
  const v = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>)[k] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

describe("plan columns ↔ inputs", () => {
  const metrics = Object.values(golden).flatMap((g) => g.output.metrics);
  it("rebuild the inputs the order plan reads, for every metric the fixture's compute writes", () => {
    expect(metrics.length).toBeGreaterThan(100);
    let curves = 0;
    let keha = 0;
    for (const m of metrics) {
      const inputs = storedInputs(m.inputs);
      const cols = planColumnsOf(inputs);
      const c = curveOf(inputs);
      if (c) curves++;
      const rebuilt = planInputsOf(cols, new Map(c ? [[c.key, c.curve]] : []));
      expect(rebuilt).not.toBeNull();
      const stored = { status: m.status, rate: m.rate, sigma: m.sigma, orderQty: m.orderQty };
      for (const x of [
        { today: "2026-10-16", pack: null, moq: null, notCounted: 0, days: 91 },
        { today: "2026-10-23", pack: 6, moq: 10, notCounted: 4, days: 91, removed: [{ day: null, units: 3 }] },
      ])
        expect(forwardInputFromMetric({ ...stored, inputs: rebuilt }, x)).toEqual(forwardInputFromMetric({ ...stored, inputs }, x));
      const orders = new Map([["po1", { counts: true, sent: true, remaining: 5, closedSinceRun: false }], ["po2", { counts: false, sent: false, remaining: 0, closedSinceRun: true }]]);
      expect(kehaSinceRun(rebuilt, orders)).toEqual(kehaSinceRun(inputs, orders));
      expect(readKehaShares(rebuilt)).toEqual(readKehaShares(inputs));
      if (readKehaShares(inputs)?.length) keha++;
      for (const k of ["seasonal", "trend", "cycleDays"]) expect(num(rebuilt, k)).toBe(num(inputs, k));
    }
    expect(curves).toBeGreaterThan(10);
  });

  it("an older row (no version) or a curve missing from the run is read the old way", () => {
    expect(planInputsOf({ planVersion: null }, new Map())).toBeNull();
    expect(planInputsOf({ planVersion: PLAN_COLUMNS_VERSION - 1 }, new Map())).toBeNull();
    expect(planInputsOf({ planVersion: PLAN_COLUMNS_VERSION, planCurveKey: "gone" }, new Map())).toBeNull();
    expect(readCurves({ a: { today: "2026-10-16", curve: [1, null] }, b: "x" })).toEqual(new Map([["a", { today: "2026-10-16", curve: [1, null] }]]));
  });
});

describe("the order plan reads the columns", () => {
  it("the same plan as from the inputs; the inputs JSON is not read", async () => {
    seedScaleFixture(db);
    await computeShop(FX_SHOP, { now: () => FX_NOW });
    const now = new Date(FX_NOW);
    expect(db.tables.variantMetric!.every((m) => m.planVersion === PLAN_COLUMNS_VERSION)).toBe(true);
    expect(readCurves(db.tables.metricRun!.find((r) => r.scope === "online")!.curves).size).toBeGreaterThan(0);
    let events = 0;
    for (const scope of ["online", "gid://shopify/Location/11"]) {
      db.calls.length = 0;
      const fromColumns = await computeOrderPlan(FX_SHOP, now, { scope });
      const readInputs = db.calls.filter((c) => c.table === "variantMetric" && c.op === "findMany" && (c.args as { select?: { inputs?: boolean } }).select?.inputs);
      expect(readInputs, scope).toEqual([]);
      // The same rows written before the columns existed: read the old way.
      const saved = db.tables.variantMetric!.map((m) => ({ ...m }));
      for (const m of db.tables.variantMetric!) m.planVersion = null;
      const fromInputs = await computeOrderPlan(FX_SHOP, now, { scope });
      db.tables.variantMetric = saved;
      expect(fromColumns.data, scope).toEqual(fromInputs.data);
      expect([...fromColumns.state], scope).toEqual([...fromInputs.state]);
      expect(fromColumns.state.size, scope).toBeGreaterThan(0);
      events += fromColumns.data.events.length;
    }
    expect(events).toBeGreaterThan(0); // the plan has orders: the equality covers them
  }, 60_000);
});
