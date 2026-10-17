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
import { cachedOrderPlan, clearOrderPlanCache, computeOrderPlan, forgetOrderPlan } from "../app/models/order-plan.server";
import { planCache } from "../app/models/plan-cache.server";
import { deleteDraft, receiveOrder, reopenOrder, setNoReorder, transitionOrder } from "../app/models/reorder.server";
import { setProductCaseSize } from "../app/models/products.server";
import { saveSupplier } from "../app/models/suppliers.server";
import { saveShopSettings } from "../app/models/settings.server";
import { readSettings } from "../app/lib/settings-shared";
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

  it("L2: a plan cached while the nightly run is writing its batches is not reused once the next batch lands", async () => {
    const OLD = new Date("2026-10-15T03:00:00Z");
    // First batch of tonight's run written (v1), v2 still last night's row.
    fake.tables.variantMetric = [metric(1, 10, RUN), metric(2, 10, OLD)];
    await cachedOrderPlan(S, NOW);
    // Second batch: v2 now has plenty of stock (no order). Same newest computedAt, same row count.
    fake.tables.variantMetric = [metric(1, 10, RUN), metric(2, 500, RUN)];
    const at = later(5 * 60_000);
    const q = (p: Awaited<ReturnType<typeof computeOrderPlan>>) => p.data.events.filter((e) => e.orderBy === TODAY).map((e) => [e.variantId, e.qty]);
    expect(q(await cachedOrderPlan(S, at))).toEqual(q(await computeOrderPlan(S, at)));
  });

  it("L2: the writes that change what the plan reads forget the shop's cached plans", async () => {
    fake.tables.purchaseOrder = [
      { id: "d1", shop: S, number: "PO-1", source: "keha", status: "draft", createdAt: NOW, updatedAt: RUN, supplierId: null, confirmedShipDate: null, expectedDate: null, lines: [{ variantId: V(1), qty: 5 }] },
      { id: "d2", shop: S, number: "PO-2", source: "keha", status: "draft", createdAt: NOW, updatedAt: RUN, supplierId: null, confirmedShipDate: null, expectedDate: null, lines: [{ variantId: V(1), qty: 5 }] },
    ];
    const cached = () => planCache.has(`${S}|online`);
    const other = "other.myshopify.com";
    const steps: [string, () => Promise<unknown>][] = [
      ["send", () => transitionOrder(S, "d1", "sent", NOW)],
      ["receive", () => receiveOrder(S, "d1", [5], false, undefined, NOW)],
      ["re-open", () => reopenOrder(S, "d1", later(1000))],
      ["cancel", () => transitionOrder(S, "d1", "cancelled", NOW)],
      ["delete", () => deleteDraft(S, "d2")],
      ["don't reorder", () => setNoReorder(S, { productId: "P1" }, true)],
      ["case size", () => setProductCaseSize(S, "P2", 6)],
      ["supplier", () => saveSupplier(S, null, { name: "Acme", email: null, leadTimeDays: 20, minOrder: null, minOrderTotal: null, casePack: null, transitDays: null, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: ["Acme"] })],
      ["settings", () => saveShopSettings(S, { ...readSettings({}), leadTimeDays: 21 })],
    ];
    for (const [name, step] of steps) {
      await cachedOrderPlan(S, NOW);
      planCache.set(`${other}|online`, planCache.get(`${S}|online`)!);
      expect(cached(), name).toBe(true);
      await step();
      expect(cached(), name).toBe(false);
      expect(planCache.has(`${other}|online`), name).toBe(true); // other shops keep theirs
    }
    forgetOrderPlan(other);
    expect(planCache.size).toBe(0);
  });

  it("no metric run yet: nothing to key on, computed every time", async () => {
    fake.tables.variantMetric = [metric(1, 10, null)];
    expect(await cachedOrderPlan(S, NOW)).not.toBe(await cachedOrderPlan(S, NOW));
  });
});
