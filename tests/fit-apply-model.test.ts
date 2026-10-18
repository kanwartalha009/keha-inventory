/**
 * Fit to budget → Apply / Undo (merchant audit 2026-10-18) on an in-memory Prisma: Apply stores the
 * month's suggested deferrals as one batch of holds; the order plan then places those orders on
 * their new day (arrival and payments moved, so the month fits) on every screen; Undo puts them
 * back. Nothing reaches Shopify (no Admin API here at all). Plus the pure hold rules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});
vi.mock("../app/shopify.server", () => ({ authenticate: {}, unauthenticated: {} }));

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { clearOrderPlanCache, loadOrderPlan } from "../app/models/order-plan.server";
import { applyFitToBudget, undoFitToBudget } from "../app/models/deferrals.server";
import { loadReorder } from "../app/models/reorder.server";
import { demand, safetyStock } from "../app/lib/engine/order-shared";
import { planFit, planMonths } from "../app/lib/order-plan-shared";
import { activeHolds, applyHolds, holdBatches, holdsFromFit } from "../app/lib/deferral-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(fake);
const S = "acme.myshopify.com";
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
  cost: 10,
  costCurrency: null,
  price: 30,
  noReorder: false,
  ...over,
});

/** A stored metric: rate 2/day, lead 40, cycle 14, z 1.28, σ 1. */
function metric(n: number, onHand: number) {
  const rate = 2;
  const lead = 40;
  const cycle = 14;
  const safety = safetyStock(1.28, 1, lead + cycle);
  const need = demand(rate, { seasonal: 1, trend: 1, plan: 1 }, lead + cycle) + safety - onHand;
  return {
    shop: S,
    variantId: V(n),
    scope: "online",
    status: "healthy",
    rate,
    sigma: 1,
    daysLeft: onHand / rate,
    neverRunsOut: false,
    orderQty: Math.ceil(need) > 0 ? Math.ceil(need) : null,
    orderBy: new Date(`${TODAY}T00:00:00Z`),
    computedAt: new Date("2026-10-16T03:00:00Z"),
    inputs: { today: TODAY, seasonal: 1, trend: 1, plan: 1, leadTimeDays: lead, cycleDays: cycle, z: 1.28, safety, onHand, incoming: 0, orderNeed: need, kehaOnOrder: 0, arrivals: [], seasonCurve: null },
  };
}

const supplier = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  shop: S,
  name: "Acme Textiles",
  email: null,
  leadTimeDays: 40,
  minOrder: null,
  minOrderTotal: null,
  casePack: null,
  vendorMatch: ["Acme"],
  currency: null,
  transitDays: 20,
  orderCycleDays: null,
  minOrderValue: null,
  minOrderScope: "variant",
  exchangeRate: null,
  hidePrices: false,
  depositPercent: null,
  balanceDue: null,
  balanceDays: null,
  landedCostPercent: null,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  fake.reset();
  clearOrderPlanCache();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: { leadTimeDays: 14 }, uninstalledAt: null }];
  fake.tables.location = [{ id: "L1", shop: S, name: "Main", active: true, online: true, role: "warehouse", onlinePool: null }];
  // V1 orders today; V2 later in the 13 weeks.
  fake.tables.variant = [variant(1), variant(2)];
  fake.tables.variantMetric = [metric(1, 10), metric(2, 120)];
  fake.tables.supplier = [supplier()];
  fake.tables.purchaseOrder = [];
  fake.tables.stockNow = [];
  fake.tables.salesDaily = [];
});

describe("hold rules (pure)", () => {
  it("an order of a held variant due before the day moves to it, arrival with it; the latest hold wins; never an overdue order; expired holds do nothing", () => {
    const events = [
      { variantId: "a", orderBy: "2026-10-20", arrives: "2026-11-30", overdue: false },
      { variantId: "a", orderBy: "2026-11-20", arrives: "2026-12-30", overdue: false },
      { variantId: "b", orderBy: "2026-10-16", arrives: "2026-11-25", overdue: true },
      { variantId: "c", orderBy: "2026-10-18", arrives: "2026-11-27" },
    ];
    const holds = [
      { variantId: "a", until: "2026-11-02" },
      { variantId: "a", until: "2026-11-05" },
      { variantId: "b", until: "2026-11-02" },
      { variantId: "c", until: "2026-10-16" }, // its day has come
    ];
    expect(activeHolds(holds, TODAY)).toHaveLength(3);
    expect(applyHolds(events, holds, TODAY)).toBe(1);
    expect(events[0]).toEqual({ variantId: "a", orderBy: "2026-11-05", arrives: "2026-12-16", overdue: false });
    expect(events[1]!.orderBy).toBe("2026-11-20"); // already after the day
    // Overdue: it stays where it is due (a hold can't hide a stock-out).
    expect(events[2]).toEqual({ variantId: "b", orderBy: "2026-10-16", arrives: "2026-11-25", overdue: true });
    expect(events[3]!.orderBy).toBe("2026-10-18");
  });

  it("one batch per Apply, summed for the banner", () => {
    const fit = { month: "2026-10", deferrals: [
      { variantId: "a", productId: "P", supplierKey: "supplier:s1", qty: 10, from: "2026-10-20", to: "2026-11-02", amount: 100.004, priority: 1, wholeOrder: false, lateDays: 0 },
      { variantId: "b", productId: "P", supplierKey: "vendor:x", qty: 5, from: "2026-10-21", to: "2026-11-03", amount: 50, priority: 2, wholeOrder: false, lateDays: 2 },
    ] } as unknown as Parameters<typeof holdsFromFit>[0];
    const holds = holdsFromFit(fit, "B1");
    expect(holds.map((h) => [h.batch, h.month, h.variantId, h.fromDay, h.until, h.amount])).toEqual([
      ["B1", "2026-10", "a", "2026-10-20", "2026-11-02", 100],
      ["B1", "2026-10", "b", "2026-10-21", "2026-11-03", 50],
    ]);
    expect(holdBatches(holds, TODAY, (k) => (k === "supplier:s1" ? "Acme" : "X"))).toEqual([{ batch: "B1", month: "2026-10", lines: 2, amount: 150, until: "2026-11-03", suppliers: ["Acme", "X"] }]);
  });
});

describe("Apply and Undo", () => {
  it("Apply moves the month's suggested orders (the month fits), everywhere; Undo puts them back", async () => {
    fake.tables.shop![0]!.settings = { leadTimeDays: 14, monthlyBudget: 50 };
    const before = await loadOrderPlan(S, NOW);
    const fit = planFit(before);
    const month = fit.find((f) => f.deferrals.length > 0);
    expect(month).toBeDefined();
    const moved = month!.deferrals;
    // Nothing is stored until Apply; a month without a suggestion is refused.
    expect(fake.tables.planDeferral ?? []).toEqual([]);
    expect(await applyFitToBudget(S, "1999-01", NOW)).toEqual({ ok: false, error: "nothing" });
    const r = await applyFitToBudget(S, month!.month, NOW);
    expect(r).toMatchObject({ ok: true, lines: moved.length });
    expect(fake.tables.planDeferral).toHaveLength(moved.length);
    const after = await loadOrderPlan(S, NOW);
    for (const d of moved) {
      // Not on its old day any more; an overdue order of the same product stays (never held).
      expect(after.events.some((e) => e.variantId === d.variantId && !e.overdue && e.orderBy >= d.from && e.orderBy < d.to)).toBe(false);
      expect(after.events.some((e) => e.variantId === d.variantId && e.orderBy === d.to)).toBe(true);
    }
    // The month's cash is what the suggestion said it would be.
    expect(planMonths(after).find((m) => m.month === month!.month)!.total).toBeCloseTo(month!.after, 2);
    expect(after.holds).toMatchObject([{ month: month!.month, lines: moved.length }]);
    // Order now says so (the orders aren't silently gone).
    expect((await loadReorder(S, [], "online", new Map(), NOW)).held).toBe(moved.length);
    // Undo: back to the plan as before.
    const batch = (r as { batch: string }).batch;
    expect(await undoFitToBudget(S, batch)).toEqual({ ok: true });
    expect(await undoFitToBudget(S, batch)).toEqual({ ok: false });
    const back = await loadOrderPlan(S, NOW);
    expect(back.events.map((e) => [e.variantId, e.orderBy, e.qty])).toEqual(before.events.map((e) => [e.variantId, e.orderBy, e.qty]));
    expect(back.holds).toEqual([]);
  });
});
