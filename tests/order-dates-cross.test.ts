/**
 * One overdue supplier order, one order-by date everywhere (M2), never one made up from a backlog
 * (M3), and Products' "To order" = Order now's line (M4): the reviewer's cross-screen fixture —
 * a fast seller with two orders in the 7 days, an oversold variant (−200 available) and a slow
 * overdue one, all from one vendor.
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
import { loadReorder } from "../app/models/reorder.server";
import { listProducts } from "../app/models/products.server";
import { mondayOrders } from "../app/services/monday.server";
import { orderPlanForSidekick } from "../app/services/sidekick.server";
import { thisWeek } from "../app/lib/order-plan-shared";
import { featureMap } from "../app/lib/plan-shared";
import { ordersDue } from "../app/lib/engine/forward-plan-shared";
import { demand, safetyStock } from "../app/lib/engine/order-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const NOW = new Date("2026-10-16T10:00:00Z");
const TODAY = "2026-10-16";
const variant = (n: number) => ({ id: V(n), shop: S, productId: `P${n}`, productTitle: `Shirt ${n}`, variantTitle: "M", sku: `S-${n}`, vendor: "Acme", image: null, tracked: true, isBundle: false, supplierId: null, caseQty: null, cost: 2, costCurrency: null, price: 10, noReorder: false });
function metric(n: number, onHand: number, o: { rate?: number; lead?: number; cycle?: number } = {}) {
  const rate = o.rate ?? 2, lead = o.lead ?? 14, cycle = o.cycle ?? 14;
  const safety = safetyStock(1.28, 1, lead + cycle);
  const need = demand(rate, { seasonal: 1, trend: 1, plan: 1 }, lead + cycle) + safety - onHand;
  return {
    shop: S, variantId: V(n), scope: "online", status: onHand <= 0 ? "out" : "healthy", rate, sigma: 1, daysLeft: Math.max(0, onHand / rate), neverRunsOut: false,
    // v2's row is from before M3: its stored date is the made-up one.
    orderQty: Math.ceil(need) > 0 ? Math.ceil(need) : null, orderBy: new Date(`${n === 2 ? "2025-08-14" : TODAY}T00:00:00Z`), computedAt: new Date("2026-10-16T03:00:00Z"),
    inputs: { today: TODAY, seasonal: 1, trend: 1, plan: 1, leadTimeDays: lead, cycleDays: cycle, z: 1.28, safety, onHand, incoming: 0, orderNeed: need, kehaOnOrder: 0, arrivals: [], seasonCurve: null },
  };
}

beforeEach(() => {
  fake.reset();
  clearOrderPlanCache();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "Europe/Madrid", locale: "en", settings: { leadTimeDays: 14 }, uninstalledAt: null }];
  fake.tables.location = [{ id: "L1", shop: S, name: "Main", active: true, online: true, role: "warehouse", onlinePool: null }];
  fake.tables.variant = [variant(1), variant(2), variant(3)];
  fake.tables.variantMetric = [metric(1, 10, { rate: 10, lead: 2, cycle: 3 }), metric(2, -200, { rate: 0.5 }), metric(3, 30)];
  fake.tables.stockNow = [];
  fake.tables.purchaseOrder = [];
  fake.tables.supplier = [];
  fake.tables.moneyAtStake = [];
  fake.tables.salesDaily = [];
});

const NF = { status: null, collection: null, vendor: null, q: null };

describe("order-by dates across screens", () => {
  it("M2: the Dashboard, Order now, Sidekick and the Monday email show one date for the overdue supplier order", async () => {
    const plan = await loadOrderPlan(S, NOW);
    const dashboard = thisWeek(plan).suppliers.map((s) => ordersDue(s.events));
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    const monday = await mondayOrders(S, "growth", "en", NOW);
    const sk = (await orderPlanForSidekick(S, { supplier: null, withinDays: 7 }, { now: NOW, access: { plan: "growth", features: featureMap("growth") } })) as unknown as {
      results: { _meta: { order_by: string | null; overdue?: boolean } }[];
    };
    expect(dashboard).toHaveLength(1);
    const day = dashboard[0]!.orderBy;
    // The earliest order-by date that passed (v3's), not the first overdue line found, not today.
    expect(day).toBe("2026-10-13");
    expect(dashboard[0]!.overdue).toBe(true);
    expect(reorder.groups.map((g) => [g.orderBy, g.overdue])).toEqual([[day, true]]);
    expect(sk.results.map((r) => [r._meta.order_by, r._meta.overdue])).toEqual([[day, true]]);
    expect(monday && monday.kind === "plan" ? monday.lines.map((l) => [l.orderBy, l.overdue]) : null).toEqual([[day, true]]);
  });

  it("M3: the oversold variant is overdue with no date — never 14 Aug 2025 — on every screen", async () => {
    const plan = await loadOrderPlan(S, NOW);
    const v2 = plan.events.filter((e) => e.variantId === V(2));
    expect(v2[0]).toMatchObject({ orderBy: TODAY, overdue: true, deadline: null });
    expect(plan.variants[V(2)]!.deadline).toBeNull();
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(reorder.groups[0]!.lines.find((l) => l.variantId === V(2))).toMatchObject({ orderBy: null, overdue: true });
    const row = (await listProducts(S, NF, 1, true, "online", NOW)).rows.find((r) => r.id === V(2))!;
    expect(row).toMatchObject({ orderBy: null, overdue: true });
    const json = JSON.stringify([plan, reorder]);
    expect(json).not.toContain("2025-08");
  });
  it("M4: Products' To order is Order now's line — the sum of the variant's orders in the 7 days, at the earliest date", async () => {
    const plan = await loadOrderPlan(S, NOW);
    const v1 = plan.events.filter((e) => e.variantId === V(1) && e.orderBy <= "2026-10-22");
    expect(v1.length).toBeGreaterThan(1); // the fast seller has several orders this week
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    const line = reorder.groups.flatMap((g) => g.lines).find((l) => l.variantId === V(1))!;
    expect(line.suggested).toBe(v1.reduce((a, e) => a + e.qty, 0));
    expect(line.why).toHaveLength(v1.length);
    const products = await listProducts(S, NF, 1, true, "online", NOW);
    for (const l of reorder.groups.flatMap((g) => g.lines)) {
      const r = products.rows.find((x) => x.id === l.variantId)!;
      expect([r.id, r.orderQty, r.orderBy, r.overdue]).toEqual([l.variantId, l.suggested, l.orderBy, l.overdue]);
    }
  });
});
