/**
 * The forward order plan on an in-memory Prisma (models/order-plan.server): it reads exactly
 * what Order now reads, so its day-0 orders are Order now's lines (same variants, same
 * quantities); open Keha drafts are netted in both; dead / not-enough-data products are
 * counted, not planned; costs in another currency are unknown (never 0).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { loadOrderPlan } from "../app/models/order-plan.server";
import { loadReorder } from "../app/models/reorder.server";
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

/** A stored metric as compute writes it: rate 2/day, lead 14, cycle 14, z 1.28, σ 1. */
function metric(n: number, onHand: number, over: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) {
  const rate = 2;
  const safety = safetyStock(1.28, 1, 14);
  const need = demand(rate, { seasonal: 1, trend: 1, plan: 1 }, 28) + safety - onHand;
  const orderQty = Math.ceil(need - 1e-9) > 0 ? Math.ceil(need - 1e-9) : null;
  const deadline = new Date(`${TODAY}T00:00:00Z`);
  return {
    shop: S,
    variantId: V(n),
    scope: "online",
    status: "healthy",
    rate,
    sigma: 1,
    daysLeft: onHand / rate,
    neverRunsOut: false,
    orderQty,
    orderBy: deadline,
    inputs: { today: TODAY, seasonal: 1, trend: 1, plan: 1, leadTimeDays: 14, cycleDays: 14, z: 1.28, safety, onHand, incoming: 0, orderNeed: need, kehaOnOrder: 0, arrivals: [], seasonCurve: null, ...inputs },
    ...over,
  };
}

beforeEach(() => {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: { leadTimeDays: 14 }, uninstalledAt: null }];
  fake.tables.location = [{ id: WH, shop: S, name: "Main", active: true, online: true, role: "warehouse", onlinePool: null }];
  fake.tables.variant = [variant(1), variant(2), variant(3, { cost: 5, costCurrency: "USD" }), variant(4), variant(5), variant(6, { productId: "P5" })];
  fake.tables.variantMetric = [
    metric(1, 10), // order today
    metric(2, 80), // later
    metric(3, 12), // order today, cost in USD (store EUR) → unknown
    metric(4, 0, { status: "dead", rate: 0 }),
    metric(5, 5, { status: "not_enough_data", orderQty: null }, { orderNeed: null }),
    metric(6, 5, { status: "not_enough_data", orderQty: null }, { orderNeed: null }),
  ];
  fake.tables.stockNow = [];
  fake.tables.purchaseOrder = [];
  fake.tables.supplier = [];
});

describe("loadOrderPlan", () => {
  it("day-0 orders are exactly Order now's lines, with the same quantities", async () => {
    const plan = await loadOrderPlan(S, NOW);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    const day0 = plan.events.filter((e) => e.orderBy === TODAY).map((e) => [e.variantId, e.qty]).sort();
    const lines = reorder.groups.flatMap((g) => g.lines.map((l) => [l.variantId, l.suggested])).sort();
    expect(day0).toEqual(lines);
    expect(day0.map((x) => x[0])).toEqual([V(1), V(3)]);
    // The later variant still has orders inside the 13 weeks.
    expect(plan.events.some((e) => e.variantId === V(2) && e.orderBy > TODAY)).toBe(true);
    // Order now shows the forward plan's order-by date.
    const l1 = reorder.groups[0]!.lines.find((l) => l.variantId === V(1))!;
    expect(l1.orderBy).toBe(plan.variants[V(1)]!.deadline);
  });

  it("an open Keha draft is netted on both screens", async () => {
    fake.tables.purchaseOrder = [{ id: "po1", shop: S, number: "PO-0001", source: "keha", status: "draft", lines: [{ variantId: V(1), qty: 500 }], confirmedShipDate: null, expectedDate: null, createdAt: NOW }];
    const plan = await loadOrderPlan(S, NOW);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(plan.events.some((e) => e.variantId === V(1) && e.orderBy === TODAY)).toBe(false);
    expect(reorder.groups.flatMap((g) => g.lines).some((l) => l.variantId === V(1))).toBe(false);
  });

  it("dead and not-enough-data products are counted, not planned; another currency's cost is unknown", async () => {
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.cantPlan).toEqual({ noData: 1, dead: 1 }); // variants 5 and 6 are one product
    expect(plan.events.some((e) => [V(4), V(5), V(6)].includes(e.variantId))).toBe(false);
    const v3 = plan.events.find((e) => e.variantId === V(3))!;
    expect(v3.unitCost).toBeNull();
    expect(v3.cost).toBeNull();
    expect(plan.events.find((e) => e.variantId === V(1))!.cost).toBe(2 * plan.events.find((e) => e.variantId === V(1))!.qty);
    expect(plan.suppliersSetUp).toBe(false);
    expect(plan.suppliers["vendor:acme"]).toMatchObject({ kind: "vendor", name: "Acme" });
  });

  it("a supplier groups its products and rounds to its case pack and minimum", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Lisbon Linen", leadTimeDays: 14, minOrder: 40, minOrderTotal: null, casePack: 12, vendorMatch: ["acme"], currency: null, email: null }];
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.suppliersSetUp).toBe(true);
    const e = plan.events.find((x) => x.variantId === V(1) && x.orderBy === TODAY)!;
    expect(e.supplierKey).toBe("supplier:s1");
    expect(e.qty % 12).toBe(0);
    expect(e.qty).toBeGreaterThanOrEqual(40);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(reorder.groups[0]!.lines.find((l) => l.variantId === V(1))!.suggested).toBe(e.qty);
  });
});
