/**
 * Supplier module on an in-memory Prisma (Kanwar 2026-10-17): payment terms and freight & duty in
 * the order plan (models/order-plan.server) — the cash per week moves to the days it is paid, the
 * same on the Dashboard / Next 13 weeks (paidWeeks), Sidekick (cash_per_week) and the Monday email;
 * no terms = the cash per week as before; open orders' balances are "committed"; the monthly budget
 * and Fit to budget; measured lead times (refreshLeadStats) and the σ they give compute.
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
import { Prisma } from "@prisma/client";
import { clearOrderPlanCache, loadOrderPlan, planSuppliers } from "../app/models/order-plan.server";
import { refreshLeadStats, saveSupplier, listSuppliers } from "../app/models/suppliers.server";
import { transitionOrder } from "../app/models/reorder.server";
import { demand, safetyStock } from "../app/lib/engine/order-shared";
import { cashTotals } from "../app/lib/engine/forward-plan-shared";
import { paidSummary, paidWeeks, paidWithin, planFit, planMonths, planWeeks } from "../app/lib/order-plan-shared";
import { orderPlanResponse } from "../app/lib/sidekick-shared";
import { validateSupplierForm, newSupplierForm } from "../app/lib/suppliers-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
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

describe("payment terms move the cash to the weeks it is paid", () => {
  it("no terms, no freight: the cash per week is the cost of each week's orders, as before", async () => {
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.events.length).toBeGreaterThan(1);
    const paid = paidWeeks(plan);
    expect(paid.map((w) => w.total)).toEqual(planWeeks(plan).map((w) => w.cash ?? 0));
    expect(paidSummary(plan)).toMatchObject({ committed: 0, landed: 0, later: 0, total: cashTotals(plan.events).cash });
    expect(plan.committed).toEqual([]);
  });

  it("30 % deposit, 70 % at shipment, + 10 % freight & duty on arrival; every screen reads the same weeks", async () => {
    fake.tables.supplier = [supplier({ depositPercent: 30, balanceDue: "ship", landedCostPercent: new Prisma.Decimal("10") })];
    const plan = await loadOrderPlan(S, NOW);
    const first = plan.events.find((e) => e.variantId === V(1) && e.orderBy === TODAY)!;
    expect(first.cost).toBe(first.qty * 10);
    expect(first.landed).toBe(first.qty);
    // Ordered today, arrives in 40 days, ships 20 days before (transit): deposit today, balance at shipment.
    expect(first.payments).toEqual([
      { day: TODAY, amount: first.qty * 3, kind: "deposit" },
      { day: "2026-11-05", amount: first.qty * 7, kind: "balance" },
      { day: "2026-11-25", amount: first.qty, kind: "landed" },
    ]);
    expect(plan.suppliers["supplier:s1"]).toMatchObject({ terms: { depositPct: 30, balanceDue: "ship" }, landedPct: 10, transitDays: 20 });
    // The order's cost line includes the freight (shown separately); the week of today holds the deposit only.
    expect(cashTotals([first])).toMatchObject({ cash: first.qty * 11, landed: first.qty });
    const paid = paidWeeks(plan);
    expect(paid[0]!.total).toBeLessThan(planWeeks(plan)[0]!.cash!);
    // Totals add up: paid in the 13 weeks + paid after them = every order's goods + freight.
    const s = paidSummary(plan);
    expect(s.total + s.later).toBeCloseTo(cashTotals(plan.events).cash!, 6);
    // Sidekick's cash_per_week = the same paid weeks (Next 13 weeks).
    const sk = orderPlanResponse(plan, { supplier: null, withinDays: 90 });
    const weeks = sk.cash_per_week as { week_of: string; cash: number | null }[];
    for (const w of weeks) expect(w.cash).toBe(paid.find((p) => p.weekStart === w.week_of)!.total);
    expect(sk.cash_note).toMatch(/paid in that week/);
    // Monday email: the 7-day cash out.
    expect(paidWithin(plan).total).toBe(Math.round(plan.events.flatMap((e) => e.payments!).filter((p) => p.day <= "2026-10-22").reduce((a, p) => a + p.amount, 0) * 100) / 100);
  });

  it("open orders: the balance and freight still due are committed cash; their deposit was paid when sent", async () => {
    fake.tables.supplier = [supplier({ depositPercent: 30, balanceDue: "arrival", landedCostPercent: new Prisma.Decimal("10") })];
    fake.tables.purchaseOrder = [
      {
        id: "po1",
        shop: S,
        number: "PO-0007",
        source: "keha",
        status: "sent",
        supplierId: "s1",
        sentAt: new Date("2026-10-01T09:00:00Z"),
        expectedDate: new Date("2026-11-10T00:00:00Z"),
        confirmedShipDate: null,
        createdAt: new Date("2026-10-01T09:00:00Z"),
        lines: [{ variantId: V(2), qty: 50, unitCost: 10, productTitle: "Shirt 2", variantTitle: "M", sku: "S-2" }],
      },
    ];
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.committed).toEqual([
      { day: "2026-11-10", amount: 350, kind: "balance", supplierKey: "supplier:s1", po: "po1", number: "PO-0007" },
      { day: "2026-11-10", amount: 50, kind: "landed", supplierKey: "supplier:s1", po: "po1", number: "PO-0007" },
    ]);
    const week = paidWeeks(plan).find((w) => w.weekStart === "2026-11-09")!;
    expect(week.committed).toBe(400);
    expect(paidSummary(plan).committed).toBe(400);
    // Without terms or freight nothing is left to pay on a sent order.
    fake.tables.supplier = [supplier()];
    clearOrderPlanCache();
    expect((await loadOrderPlan(S, NOW)).committed).toEqual([]);
  });

  it("the monthly budget: months of the 13 weeks, the over ones with Fit to budget (never the overdue order)", async () => {
    fake.tables.shop![0]!.settings = { leadTimeDays: 14, monthlyBudget: 50 };
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.budget).toBe(50);
    const months = planMonths(plan);
    expect(months[0]).toMatchObject({ month: "2026-10", from: TODAY, partial: true });
    const fit = planFit(plan);
    const over = months.filter((m) => m.total > 50).map((m) => m.month);
    expect(fit.map((f) => f.month)).toEqual(over);
    for (const f of fit) for (const d of f.deferrals) expect(plan.events.find((e) => e.variantId === d.variantId && e.orderBy === d.from)!.overdue).toBe(false);
  });
});

describe("supplier form: terms and freight & duty", () => {
  it("validates and stores them (Settings → Suppliers)", async () => {
    const form = { ...newSupplierForm(14, "EUR"), name: "Far East", balanceDue: "after_arrival" as const, depositPercent: "20", balanceDays: "30", landedCostPercent: "12,5" };
    const v = validateSupplierForm(form, [], "EUR");
    expect(v.ok && v.input).toMatchObject({ balanceDue: "after_arrival", depositPercent: 20, balanceDays: 30, landedCostPercent: 12.5 });
    if (!v.ok) return;
    const id = await saveSupplier(S, null, v.input);
    const rows = await listSuppliers(S);
    expect(rows.find((r) => r.id === id)).toMatchObject({ terms: { depositPct: 20, balanceDue: "after_arrival", balanceDays: 30 }, landedPct: 12.5 });
    // "Pay everything when you order": no terms stored.
    const none = validateSupplierForm({ ...form, balanceDue: "order" }, [], "EUR");
    expect(none.ok && none.input).toMatchObject({ balanceDue: null, depositPercent: null, balanceDays: null });
    expect(validateSupplierForm({ ...form, depositPercent: "120" }, [], "EUR")).toMatchObject({ ok: false, errors: { depositPercent: "range" } });
    expect(validateSupplierForm({ ...form, balanceDays: "" }, [], "EUR")).toMatchObject({ ok: false, errors: { balanceDays: "range" } });
    expect(validateSupplierForm({ ...form, landedCostPercent: "abc" }, [], "EUR")).toMatchObject({ ok: false, errors: { landedCostPercent: "percent" } });
  });
});

describe("measured lead time", () => {
  const received = (id: string, sent: string, got: string, over: Record<string, unknown> = {}) => ({
    id,
    shop: S,
    number: id,
    source: "keha",
    status: "received",
    supplierId: "s1",
    supplierName: "Acme Textiles",
    sentAt: new Date(`${sent}T09:00:00Z`),
    receivedAt: new Date(`${got}T15:00:00Z`),
    expectedDate: new Date(`${new Date(Date.parse(`${sent}T00:00:00Z`) + 40 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`),
    createdAt: new Date(`${sent}T08:00:00Z`),
    lines: [],
    ...over,
  });

  it("received orders → stats on the supplier (only when they change); Shopify orders matched by name", async () => {
    fake.tables.purchaseOrder = [
      received("a", "2026-03-01", "2026-04-16"), // 46 days, promised 40
      received("b", "2026-05-01", "2026-06-12"), // 42
      received("c", "2026-07-01", "2026-08-10"), // 40
      // Shopify: seen open first (created before received) → counts; promised = lead time 40.
      received("d", "2026-08-01", "2026-09-20", { source: "shopify", supplierId: null, expectedDate: null }), // 50
      // Shopify order first read already received: no real date.
      received("e", "2026-08-01", "2026-08-05", { source: "shopify", supplierId: null, expectedDate: null, createdAt: new Date("2026-08-05T16:00:00Z") }),
      // Another supplier's.
      received("f", "2026-08-01", "2026-08-30", { supplierId: "other", supplierName: "Other" }),
    ];
    expect(await refreshLeadStats(S)).toBe(1);
    const row = fake.tables.supplier![0]!;
    // actual 46, 42, 40, 50 → mean 44.5; promised 40 → delay 4.5; σ = √((2.25+6.25+20.25+30.25)/3) = 4.43; on time 1/4.
    expect(row).toMatchObject({ leadSamples: 4, leadPromisedDays: 40, leadActualDays: 44.5, leadDelayDays: 4.5, leadSigmaDays: 4.43, leadOnTimeShare: 0.25 });
    // Nothing changed: no write.
    expect(await refreshLeadStats(S)).toBe(0);
    // Read back for the plan / Settings / the builder.
    const [s] = await planSuppliers(S);
    expect(s).toMatchObject({ leadSamples: 4, leadSigmaDays: 4.43, leadStats: { samples: 4, delayAvg: 4.5 } });
    expect((await listSuppliers(S))[0]!.leadStats).toMatchObject({ samples: 4, onTimeShare: 0.25 });
  });

  it("receiving an order re-measures at once", async () => {
    fake.tables.purchaseOrder = [received("a", "2026-03-01", "2026-04-16"), { ...received("g", "2026-09-01", "2026-09-01"), status: "sent", receivedAt: null, lines: [{ variantId: V(1), qty: 2, unitCost: 1, productTitle: "Shirt 1", variantTitle: "M", sku: "S-1" }] }];
    await refreshLeadStats(S);
    expect(fake.tables.supplier![0]!.leadSamples).toBe(1);
    expect(await transitionOrder(S, "g", "received", NOW)).toEqual({ ok: true });
    expect(fake.tables.supplier![0]!.leadSamples).toBe(2);
  });
});
