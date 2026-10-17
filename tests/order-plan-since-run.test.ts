/**
 * H2 (review 2026-10-17): a Keha order the nightly run counted as incoming that is closed short,
 * cancelled or deleted afterwards must stop counting at once — on every screen that reads the
 * order plan (Dashboard, Order now, Products, Sidekick, the Monday email) — not the next night.
 * Units received by hand are not "removed": they moved to the shelf (stored on-hand is last
 * night's), so the plan doesn't order them again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/shopify.server", () => ({ authenticate: {}, unauthenticated: {} }));
vi.mock("../app/services/entitlements.server", () => ({
  planFor: async () => "growth",
  getEntitlements: async () => ({ plan: "growth", features: {}, comped: false, checked: true }),
}));

import * as dbModule from "../app/db.server";
import { clearOrderPlanCache, loadOrderPlan } from "../app/models/order-plan.server";
import { deleteDraft, loadReorder, receiveOrder, transitionOrder } from "../app/models/reorder.server";
import { listProducts } from "../app/models/products.server";
import { mondayOrders } from "../app/services/monday.server";
import { orderPlanForSidekick } from "../app/services/sidekick.server";
import { thisWeek, type OrderPlanData } from "../app/lib/order-plan-shared";
import { featureMap } from "../app/lib/plan-shared";
import { demand, safetyStock } from "../app/lib/engine/order-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V1 = "gid://shopify/ProductVariant/1";
const NOW = new Date("2026-10-16T10:00:00Z");
const TODAY = "2026-10-16";
const RUN = new Date("2026-10-16T03:00:00Z");

const variant = { id: V1, shop: S, productId: "P1", productTitle: "x", variantTitle: "M", sku: "X-1", vendor: "Acme", image: null, tracked: true, isBundle: false, supplierId: null, caseQty: null, cost: 2, costCurrency: null, price: 10, noReorder: false };

/** Last night: 10 on hand, 40 units still to come on PO-1 (arriving in 3 days), rate 4/day. */
function metric(over: { kehaOrders?: unknown; incoming?: number; kehaLanded?: number; arrivals?: unknown; computedAt?: Date } = {}) {
  const safety = safetyStock(1.28, 1, 28);
  const onHand = 10;
  const incoming = over.incoming ?? 40;
  const need = demand(4, { seasonal: 1, trend: 1, plan: 1 }, 28) + safety - onHand - incoming;
  return {
    shop: S,
    variantId: V1,
    scope: "online",
    status: "running_low",
    rate: 4,
    sigma: 1,
    daysLeft: 2,
    neverRunsOut: false,
    orderQty: Math.ceil(need) > 0 ? Math.ceil(need) : null,
    orderBy: new Date(`${TODAY}T00:00:00Z`),
    ...(over.computedAt ? { computedAt: over.computedAt } : {}),
    inputs: {
      today: TODAY,
      seasonal: 1,
      trend: 1,
      plan: 1,
      leadTimeDays: 14,
      cycleDays: 14,
      z: 1.28,
      safety,
      onHand,
      incoming,
      orderNeed: need,
      // Sells when out of stock (backorders owed): units that no longer arrive are ordered back in
      // full. (A store that doesn't sell when out loses those sales before a new order could land.)
      sellsWhenOut: true,
      kehaOnOrder: 40,
      ...(over.kehaLanded !== undefined ? { kehaLanded: over.kehaLanded } : {}),
      arrivals: over.arrivals ?? [{ day: "2026-10-19", units: incoming }],
      ...(over.kehaOrders !== undefined ? { kehaOrders: over.kehaOrders } : {}),
    },
  };
}

const po = (over: Record<string, unknown> = {}) => ({
  id: "po1",
  shop: S,
  number: "PO-1",
  source: "keha",
  status: "sent",
  supplierId: null,
  lines: [{ variantId: V1, qty: 100, received: 60, unitCost: 2, productTitle: "x", variantTitle: "M", sku: "X-1" }],
  confirmedShipDate: null,
  expectedDate: new Date("2026-10-19T00:00:00Z"),
  createdAt: new Date("2026-09-01"),
  sentAt: new Date("2026-09-01"),
  receivedAt: null,
  cancelledAt: null,
  updatedAt: new Date("2026-10-15"),
  ...over,
});

const SHARES = [{ po: "po1", open: 40, units: 40, day: "2026-10-19" }];
const week = (p: OrderPlanData) => p.events.filter((e) => e.orderBy <= "2026-10-22").reduce((a, e) => a + e.qty, 0);

/** 14 distinct days of sales well before the plan's windows (Home: "ready"). */
const READY_SALES = () =>
  Array.from({ length: 14 }, (_, i) => ({ shop: S, day: new Date(Date.UTC(2026, 8, 1 + i)), variantId: "gid://shopify/ProductVariant/999", locationKey: "all", channel: "web", sold: 1 }));

beforeEach(() => {
  fake.reset();
  clearOrderPlanCache();
  // A ready store (history read, 14 days of sales): the order plan surfaces show the plan.
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: {}, uninstalledAt: null, backfillState: { finishedAt: "2026-10-01T00:00:00Z", first90Ready: true }, lastNightlyAt: null }];
  fake.tables.location = [{ id: "L1", shop: S, name: "Main", active: true, online: true, role: "warehouse", onlinePool: null }];
  fake.tables.variant = [variant];
  fake.tables.supplier = [];
  fake.tables.stockNow = [];
  fake.tables.moneyAtStake = [];
  fake.tables.salesDaily = READY_SALES();
});

describe("Keha orders closed after the nightly run (H2)", () => {
  it("reviewer repro (row written before per-order shares): close short counts the missing 40 at once", async () => {
    fake.tables.variantMetric = [metric()];
    fake.tables.purchaseOrder = [po()];
    const before = await loadOrderPlan(S, NOW);
    expect(await receiveOrder(S, "po1", [0], true, undefined, new Date("2026-10-16T09:00:00Z"))).toEqual({ ok: true });
    const after = await loadOrderPlan(S, NOW);
    expect(week(after)).toBeGreaterThanOrEqual(week(before) + 40);
  });

  it("legacy rows: a hand receipt after the run is not a drop (no order for units already on the shelf)", async () => {
    fake.tables.variantMetric = [metric()];
    fake.tables.purchaseOrder = [po()];
    const before = await loadOrderPlan(S, NOW);
    // The last 40 arrived and the merchant receives them: the order closes complete.
    expect(await receiveOrder(S, "po1", [40], false, undefined, new Date("2026-10-16T09:00:00Z"))).toEqual({ ok: true });
    expect(week(await loadOrderPlan(S, NOW))).toBe(week(before));
  });

  it("per-order shares: cancelling a counted order takes its 40 units out of the arrivals now", async () => {
    fake.tables.variantMetric = [metric({ kehaOrders: SHARES, computedAt: RUN })];
    fake.tables.purchaseOrder = [po()];
    const before = await loadOrderPlan(S, NOW);
    const why0 = before.events[0]!.why!;
    expect(await transitionOrder(S, "po1", "cancelled", new Date("2026-10-16T09:00:00Z"))).toEqual({ ok: true });
    const after = await loadOrderPlan(S, NOW);
    expect(week(after)).toBeGreaterThanOrEqual(week(before) + 40);
    // The "why" popover's on order shows the 40 gone.
    expect(after.events[0]!.why!.onOrder).toBeCloseTo(why0.onOrder - 40);
  });

  it("per-order shares: a close-short only cuts the units still counted as incoming (landed estimate not taken twice)", async () => {
    // 30 of the 40 were estimated as landed last night (stock rose): only 10 were incoming.
    fake.tables.variantMetric = [
      metric({ incoming: 10, kehaLanded: 30, arrivals: [{ day: "2026-10-19", units: 10 }], kehaOrders: [{ po: "po1", open: 40, units: 10, day: "2026-10-19" }], computedAt: RUN }),
    ];
    fake.tables.purchaseOrder = [po()];
    const before = await loadOrderPlan(S, NOW);
    expect(await receiveOrder(S, "po1", [0], true, undefined, new Date("2026-10-16T09:00:00Z"))).toEqual({ ok: true });
    const after = await loadOrderPlan(S, NOW);
    expect(after.events[0]!.why!.onOrder).toBeCloseTo(before.events[0]!.why!.onOrder - 10);
  });

  it("per-order shares: received by hand then nothing removed; an order closed before the run is ignored", async () => {
    fake.tables.variantMetric = [metric({ kehaOrders: SHARES, computedAt: RUN })];
    fake.tables.purchaseOrder = [po(), po({ id: "po0", number: "PO-0", status: "received", receivedAt: new Date("2026-10-15T12:00:00Z") })];
    const before = await loadOrderPlan(S, NOW);
    expect(await receiveOrder(S, "po1", [40], false, undefined, new Date("2026-10-16T09:00:00Z"))).toEqual({ ok: true });
    expect(week(await loadOrderPlan(S, NOW))).toBe(week(before));
  });

  it("deleting a draft stops counting it at once", async () => {
    fake.tables.variantMetric = [metric({ kehaOrders: SHARES, computedAt: RUN })];
    fake.tables.purchaseOrder = [po(), po({ id: "d1", number: "PO-2", status: "draft", sentAt: null, expectedDate: null, createdAt: new Date("2026-10-16T08:00:00Z"), lines: [{ variantId: V1, qty: 30, unitCost: 2, productTitle: "x", variantTitle: "M", sku: "X-1" }] })];
    const withDraft = await loadOrderPlan(S, NOW);
    expect(await deleteDraft(S, "d1")).toEqual({ ok: true });
    const after = await loadOrderPlan(S, NOW);
    // With the draft's 30 units the next order was due on the 20th; without them it is due today.
    expect(withDraft.events[0]!.orderBy).toBe("2026-10-20");
    expect(after.events[0]!.orderBy).toBe(TODAY);
    expect(week(after)).toBeGreaterThan(week(withDraft));
  });

  it("Dashboard, Order now, Products, Sidekick and the Monday email all count the cancelled units immediately", async () => {
    fake.tables.variantMetric = [metric({ kehaOrders: SHARES, computedAt: RUN })];
    fake.tables.purchaseOrder = [po()];
    const read = async () => {
      const plan = await loadOrderPlan(S, NOW);
      const reorder = await loadReorder(S, [], "online", new Map(), NOW);
      const products = await listProducts(S, { status: null, collection: null, vendor: null, q: null }, 1, true, "online", NOW);
      const monday = await mondayOrders(S, "growth", "en", NOW);
      const sk = (await orderPlanForSidekick(S, { supplier: null, withinDays: 7 }, { now: NOW, access: { plan: "growth", features: featureMap("growth") } })) as unknown as {
        results: { _meta: { units: number } }[];
      };
      return {
        dashboard: thisWeek(plan).totals.units,
        orderNow: reorder.groups.flatMap((g) => g.lines).reduce((a, l) => a + l.suggested, 0),
        products: products.rows[0]!.orderQty ?? 0,
        sidekick: sk.results.reduce((a, r) => a + r._meta.units, 0),
        monday: monday && monday.kind === "plan" ? monday.lines.reduce((a, l) => a + l.units, 0) : 0,
      };
    };
    const before = await read();
    expect(await transitionOrder(S, "po1", "cancelled", new Date("2026-10-16T09:00:00Z"))).toEqual({ ok: true });
    const after = await read();
    for (const k of ["dashboard", "orderNow", "products", "sidekick", "monday"] as const) {
      expect(after[k], k).toBeGreaterThanOrEqual(before[k] + 40);
    }
  });
});
