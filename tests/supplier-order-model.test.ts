/**
 * Consolidated supplier purchase order (Kanwar 2026-10-17) on an in-memory Prisma: the
 * supplier's own order cycle in the forward plan (order quantities cover lead time + that
 * cycle), the supplier order builder's data, one draft for everything due within the cycle,
 * adding lines to an existing draft, and the netting on every screen afterwards (Order now,
 * Next 90 days, Sidekick's get_order_plan).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { computeOrderPlan, loadOrderPlan } from "../app/models/order-plan.server";
import { demand, safetyStock } from "../app/lib/engine/order-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const WH = "gid://shopify/Location/1";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const NOW = new Date("2026-10-16T10:00:00Z");
const TODAY = "2026-10-16";

const variant = (n: number, over: Record<string, unknown> = {}) => ({
  id: V(n),
  shop: S,
  productId: `P${n}`,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `S-${n}`,
  vendor: "Acme",
  image: null,
  tracked: true,
  isBundle: false,
  supplierId: null,
  caseQty: null,
  cost: 2,
  costCurrency: null,
  price: 10,
  ...over,
});

/** A stored metric as compute writes it: rate 2/day, lead 14, cycle 14 (the store's), z 1.28, σ 1. */
function metric(n: number, onHand: number, inputs: Record<string, unknown> = {}) {
  const rate = 2;
  const safety = safetyStock(1.28, 1, 28);
  const need = demand(rate, { seasonal: 1, trend: 1, plan: 1 }, 28) + safety - onHand;
  return {
    shop: S,
    variantId: V(n),
    scope: "online",
    status: "healthy",
    rate,
    sigma: 1,
    daysLeft: onHand / rate,
    neverRunsOut: false,
    orderQty: need > 0 ? Math.ceil(need) : null,
    orderBy: new Date(`${TODAY}T00:00:00Z`),
    computedAt: new Date("2026-10-16T02:00:00Z"),
    inputs: { today: TODAY, seasonal: 1, trend: 1, plan: 1, leadTimeDays: 14, cycleDays: 14, z: 1.28, safety, onHand, incoming: 0, orderNeed: need, kehaOnOrder: 0, arrivals: [], seasonCurve: null, ...inputs },
  };
}

const supplier = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  shop: S,
  name: "Acme Textiles",
  email: null,
  leadTimeDays: 14,
  minOrder: null,
  minOrderTotal: null,
  casePack: null,
  vendorMatch: ["Acme"],
  currency: null,
  transitDays: null,
  orderCycleDays: null,
  minOrderValue: null,
  minOrderScope: "variant",
  exchangeRate: null,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: { leadTimeDays: 14, cycleDays: 14 }, uninstalledAt: null }];
  fake.tables.location = [{ id: WH, shop: S, name: "Main", active: true, online: true, role: "warehouse", onlinePool: null }];
  fake.tables.variant = [variant(1), variant(2), variant(3), variant(4, { vendor: "Other" })];
  fake.tables.variantMetric = [metric(1, 10), metric(2, 70), metric(3, 300), metric(4, 10)];
  fake.tables.stockNow = [];
  fake.tables.purchaseOrder = [];
  fake.tables.supplier = [supplier()];
});

describe("the supplier's order cycle (Order every … days)", () => {
  it("replaces the store's cycle in the forward plan at once: quantities cover lead time + the supplier's cycle", async () => {
    const before = await loadOrderPlan(S, NOW);
    const e1 = before.events.find((e) => e.variantId === V(1))!;
    expect(e1.why?.days).toBe(28); // 14 lead + 14 (the store's cycle, as the night stored it)
    expect(before.suppliers["supplier:s1"]).toMatchObject({ cycleDays: 14, orderCycleDays: null });

    fake.tables.supplier = [supplier({ orderCycleDays: 60 })];
    const after = await loadOrderPlan(S, NOW);
    const a1 = after.events.find((e) => e.variantId === V(1))!;
    expect(a1.why?.days).toBe(74); // 14 lead + 60
    expect(a1.qty).toBeGreaterThan(e1.qty);
    expect(after.suppliers["supplier:s1"]).toMatchObject({ cycleDays: 60, orderCycleDays: 60 });
    // Fewer, larger orders over the 13 weeks for that supplier; another vendor's products keep the store's cycle.
    const count = (p: typeof before, id: string) => p.events.filter((e) => e.variantId === id).length;
    expect(count(after, V(1))).toBeLessThan(count(before, V(1)));
    expect(after.events.find((e) => e.variantId === V(4))!.why?.days).toBe(28);
  });

  it("the plan's state and supplier info carry the cycle for the builder", async () => {
    fake.tables.supplier = [supplier({ orderCycleDays: 45 })];
    const { data } = await computeOrderPlan(S, NOW);
    expect(data.suppliers["supplier:s1"]!.cycleDays).toBe(45);
    expect(data.suppliers["vendor:other"]).toMatchObject({ kind: "vendor", orderCycleDays: null });
  });
});
