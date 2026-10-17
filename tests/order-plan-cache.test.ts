/**
 * The forward plan cache behind Products and Sidekick (models/order-plan.server cachedOrderPlan):
 * Products sorts every variant by the plan's order-by date, so each page load needs the whole
 * plan; it is reused only while nothing the plan reads changed (integration 2026-10-17, W2b).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] }, ["purchaseOrder", "variant", "supplier"]);
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { cachedOrderPlan, clearOrderPlanCache } from "../app/models/order-plan.server";
import { safetyStock } from "../app/lib/engine/order-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const client = fake.client as unknown as Record<string, { create: (a: { data: Record<string, unknown> }) => Promise<unknown>; updateMany: (a: unknown) => Promise<unknown> }>;
const S = "acme.myshopify.com";
const NOW = new Date("2026-10-16T10:00:00Z");
const TODAY = "2026-10-16";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const RUN = new Date("2026-10-16T03:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

function metric(n: number, onHand: number, computedAt: Date | null = RUN) {
  return {
    shop: S, variantId: V(n), scope: "online", status: "healthy", computedAt, rate: 2, sigma: 1, daysLeft: onHand / 2, neverRunsOut: false, orderQty: 10, orderBy: new Date(`${TODAY}T00:00:00Z`),
    inputs: { today: TODAY, seasonal: 1, trend: 1, plan: 1, leadTimeDays: 14, cycleDays: 14, z: 1.28, safety: safetyStock(1.28, 1, 28), onHand, incoming: 0, kehaOnOrder: 0, arrivals: [], seasonCurve: null },
  };
}

beforeEach(() => {
  fake.reset();
  clearOrderPlanCache();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: { leadTimeDays: 14 }, uninstalledAt: null }];
  fake.tables.variant = [1, 2].map((n) => ({ id: V(n), shop: S, productId: `P${n}`, productTitle: `Shirt ${n}`, variantTitle: "M", sku: null, vendor: "Acme", image: null, tracked: true, isBundle: false, supplierId: null, caseQty: null, cost: 2, costCurrency: null, price: 10, noReorder: false, updatedAt: RUN }));
  fake.tables.variantMetric = [metric(1, 10), metric(2, 80)];
  fake.tables.purchaseOrder = [];
  fake.tables.supplier = [];
});

const qtyOf = async (at: Date, n = 1) => (await cachedOrderPlan(S, at)).data.events.filter((e) => e.variantId === V(n)).reduce((a, e) => a + e.qty, 0);

describe("cachedOrderPlan", () => {
  it("reuses the plan while nothing it reads changed", async () => {
    const a = await cachedOrderPlan(S, NOW);
    expect(await cachedOrderPlan(S, later(60_000))).toBe(a);
    // Another scope is its own entry.
    expect(await cachedOrderPlan(S, NOW, { scope: "gid://shopify/Location/9" })).not.toBe(a);
  });

  it("recomputes after a Keha order changes (a fresh draft nets off the plan)", async () => {
    const before = await qtyOf(NOW);
    expect(before).toBeGreaterThan(0);
    await client.purchaseOrder!.create({ data: { id: "po1", shop: S, source: "keha", status: "draft", createdAt: NOW, supplierId: null, confirmedShipDate: null, expectedDate: null, lines: [{ variantId: V(1), qty: 5 }] } });
    expect(await qtyOf(later(1000))).toBeLessThan(before);
  });

  it("recomputes after a new metric run, a catalog or supplier change, a new store day, or 10 minutes", async () => {
    const a = await cachedOrderPlan(S, NOW);
    fake.tables.variantMetric = [metric(1, 10, new Date("2026-10-16T09:00:00Z")), metric(2, 80, new Date("2026-10-16T09:00:00Z"))];
    const b = await cachedOrderPlan(S, NOW);
    expect(b).not.toBe(a);
    await client.variant!.updateMany({ where: { id: V(1) }, data: { noReorder: true } });
    const c = await cachedOrderPlan(S, NOW);
    expect(c).not.toBe(b);
    expect(c.state.get(V(1))?.noReorder).toBe(true);
    await client.supplier!.create({ data: { id: "s1", shop: S, name: "Acme", leadTimeDays: 30, vendorMatch: ["Acme"] } });
    const d = await cachedOrderPlan(S, NOW);
    expect(d).not.toBe(c);
    const e = await cachedOrderPlan(S, new Date("2026-10-17T00:30:00Z")); // the next day in the store
    expect(e).not.toBe(d);
    expect(await cachedOrderPlan(S, new Date("2026-10-17T00:41:00Z"))).not.toBe(e); // 11 minutes later
  });

  it("recomputes when a draft passes 14 days (it stops counting as ordered)", async () => {
    fake.tables.purchaseOrder = [{ id: "po1", shop: S, source: "keha", status: "draft", createdAt: new Date("2026-10-02T10:03:00Z"), updatedAt: RUN, supplierId: null, confirmedShipDate: null, expectedDate: null, lines: [{ variantId: V(1), qty: 5 }] }];
    const fresh = await qtyOf(NOW); // 13 days 23 h 57 min old: still counts
    expect(await qtyOf(later(5 * 60_000))).toBeGreaterThan(fresh); // 5 minutes later (inside the 10-minute cap) it no longer does
  });

  it("no metric run yet: nothing to key on, computed every time", async () => {
    fake.tables.variantMetric = [metric(1, 10, null)];
    expect(await cachedOrderPlan(S, NOW)).not.toBe(await cachedOrderPlan(S, NOW));
  });
});
