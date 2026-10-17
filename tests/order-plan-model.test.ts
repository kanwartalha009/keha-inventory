/**
 * The forward order plan on an in-memory Prisma (models/order-plan.server): ONE function behind
 * the Dashboard, Order now, Products and Sidekick (audit 2026-10-17) — the same orders, dates,
 * quantities and cash everywhere; open Keha drafts are netted while fresh; dead /
 * not-enough-data products are counted, not planned; costs in another currency are unknown
 * (never 0); "Don't reorder", minimums per style and in money, transit, large orders.
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
import { createOrderFromGroup, kehaOnOrder, loadReorder, scenarioPlanned, setNoReorder } from "../app/models/reorder.server";
import { listProducts, setProductCaseSize } from "../app/models/products.server";
import { searchVariantStock } from "../app/models/sidekick.server";
import { demand, safetyStock } from "../app/lib/engine/order-shared";
import { addDays } from "../app/lib/engine/dates-shared";
import { dueWithin } from "../app/lib/engine/forward-plan-shared";
import { orderLink, readOrderLink, thisWeek } from "../app/lib/order-plan-shared";
import { orderTotals } from "../app/lib/reorder-shared";
import { RESULT_VERSION } from "../app/lib/planner-shared";

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

const NO_FILTERS = { status: null, collection: null, vendor: null, q: null };
const sumQty = (events: { variantId: string; qty: number }[]) => {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.variantId, (m.get(e.variantId) ?? 0) + e.qty);
  return [...m].sort();
};

describe("loadOrderPlan", () => {
  it("Order now = the Dashboard's Order this week: the plan's orders due in 7 days, same quantities and cash", async () => {
    const plan = await loadOrderPlan(S, NOW);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    const week = thisWeek(plan);
    const lines = reorder.groups.flatMap((g) => g.lines.map((l) => [l.variantId, l.suggested] as [string, number])).sort();
    expect(lines).toEqual(sumQty(dueWithin(plan.events, TODAY, 7)));
    expect(lines.map((x) => x[0])).toEqual([V(1), V(3)]);
    const cash = reorder.groups.reduce((a, g) => a + (orderTotals(g, g.lines, (id) => g.lines.find((l) => l.variantId === id)!.suggested).cost ?? 0), 0);
    expect(cash).toBe(week.totals.cash);
    // The later variant still has orders inside the 13 weeks.
    expect(plan.events.some((e) => e.variantId === V(2) && e.orderBy > TODAY)).toBe(true);
    // Order now shows the forward plan's order-by date.
    const l1 = reorder.groups[0]!.lines.find((l) => l.variantId === V(1))!;
    expect(l1.orderBy).toBe(plan.variants[V(1)]!.deadline);
  });

  it("failing scenario (merchant #1): one order-by date on the Dashboard, Order now and Products — not 'today' when it's in 5 days", async () => {
    // 2/day, lead 14, cycle 14, safety ≈ 4.8: on hand 42 → deadline today + ⌊(42 − 4.8) ÷ 2 − 14⌋ = today + 4.
    fake.tables.variantMetric = [metric(1, 42)];
    const plan = await loadOrderPlan(S, NOW);
    const due = plan.variants[V(1)]!.deadline!;
    expect(due).toBe(addDays(TODAY, 4));
    const week = thisWeek(plan);
    expect(week.suppliers[0]!.orderByFrom).toBe(due);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(reorder.groups[0]!.lines[0]!.orderBy).toBe(due);
    const products = await listProducts(S, NO_FILTERS, 1, true, "online", NOW);
    const row = products.rows.find((r) => r.id === V(1))!;
    expect(row.orderBy).toBe(due);
    expect(row.orderQty).toBe(reorder.groups[0]!.lines[0]!.suggested);
  });

  it("an open Keha draft is netted on both screens", async () => {
    fake.tables.purchaseOrder = [{ id: "po1", shop: S, number: "PO-0001", source: "keha", status: "draft", lines: [{ variantId: V(1), qty: 500 }], confirmedShipDate: null, expectedDate: null, createdAt: new Date(NOW.getTime() - 3 * 86_400_000) }];
    const plan = await loadOrderPlan(S, NOW);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(plan.events.some((e) => e.variantId === V(1) && e.orderBy === TODAY)).toBe(false);
    expect(reorder.groups.flatMap((g) => g.lines).some((l) => l.variantId === V(1))).toBe(false);
  });

  it("out of stock with no sales pace (sales/day —) is counted as can't be planned yet, not dropped (2026-10-17)", async () => {
    fake.tables.variant.push(variant(7), variant(8), variant(9, { productId: "P7" }));
    fake.tables.variantMetric.push(
      // Out, no rate, no order: can't be planned (P7, two variants → one product).
      metric(7, 0, { status: "out", rate: null, daysLeft: 0, orderQty: null, orderBy: null }, { orderNeed: null }),
      metric(9, 0, { status: "out", rate: null, daysLeft: 0, orderQty: null, orderBy: null }, { orderNeed: null }),
      // Out WITH a rate: planned (an order today), not counted.
      metric(8, 0, { status: "out", daysLeft: 0 }),
    );
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.cantPlan).toEqual({ noData: 2, dead: 1 }); // P5 (not enough data) + P7 (out, no pace)
    expect(plan.events.some((e) => e.variantId === V(8))).toBe(true);
    expect(plan.events.some((e) => [V(7), V(9)].includes(e.variantId))).toBe(false);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(reorder.cantPlan).toEqual({ noData: 2, dead: 1 });
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

describe("ordering audit 2026-10-17", () => {
  it("drafts older than 14 days stop counting (and are reported); fresh ones still net off", async () => {
    const draft = (id: string, days: number) => ({ id, shop: S, number: id, source: "keha", status: "draft", lines: [{ variantId: V(1), qty: 500 }], confirmedShipDate: null, expectedDate: null, createdAt: new Date(NOW.getTime() - days * 86_400_000) });
    fake.tables.purchaseOrder = [draft("old", 20)];
    const stale = await loadOrderPlan(S, NOW);
    expect(stale.events.some((e) => e.variantId === V(1) && e.orderBy === TODAY)).toBe(true);
    expect(stale.staleDrafts).toBe(1);
    expect((await loadReorder(S, [], "online", new Map(), NOW)).staleDrafts).toBe(1);
    fake.tables.purchaseOrder = [draft("new", 3)];
    const fresh = await loadOrderPlan(S, NOW);
    expect(fresh.events.some((e) => e.variantId === V(1) && e.orderBy === TODAY)).toBe(false);
    expect(fresh.staleDrafts).toBe(0);
  });

  it("transit: a confirmed ship date arrives transit days later", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Far", leadTimeDays: 45, transitDays: 21, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: [], currency: null, email: null }];
    fake.tables.purchaseOrder = [{ id: "po1", shop: S, number: "PO-1", source: "keha", status: "confirmed", supplierId: "s1", lines: [{ variantId: V(2), qty: 10 }], confirmedShipDate: new Date("2026-10-20T00:00:00Z"), expectedDate: new Date("2026-10-25T00:00:00Z"), createdAt: NOW }];
    expect((await kehaOnOrder(S, ["sent", "confirmed"])).get(V(2))).toEqual({ qty: 10, arrival: "2026-11-10" });
  });

  it("L1: Don't reorder is still counted after the nightly run (compute gives it no order and no order-by date)", async () => {
    // As compute writes a "Don't reorder" variant: no order quantity, no order-by date.
    fake.tables.variant = [variant(1, { noReorder: true }), variant(2), variant(7, { productId: "P1", noReorder: true })];
    fake.tables.variantMetric = [metric(1, 10, { orderQty: null, orderBy: null }, { noReorder: true }), metric(2, 80)];
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.events.some((e) => e.variantId === V(1))).toBe(false);
    // Products, not variants (the copy says "N products are set to Don't reorder").
    expect(plan.notReordered).toBe(1);
    fake.tables.variant.push(variant(8, { productId: "P8", noReorder: true }), variant(9, { productId: "P9", noReorder: true, tracked: false }));
    expect((await loadOrderPlan(S, NOW)).notReordered).toBe(2);
  });

  it("Don't reorder: out of the plan, Order now and Products' To order (Not reordered), counted; Sidekick has no quantity", async () => {
    expect(await setNoReorder(S, { productId: "P1" }, true)).toEqual({ ok: true, count: 1 });
    const plan = await loadOrderPlan(S, NOW);
    expect(plan.events.some((e) => e.variantId === V(1))).toBe(false);
    expect(plan.notReordered).toBe(1);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    expect(reorder.groups.flatMap((g) => g.lines).some((l) => l.variantId === V(1))).toBe(false);
    const row = (await listProducts(S, NO_FILTERS, 1, true, "online", NOW)).rows.find((r) => r.id === V(1))!;
    expect(row).toMatchObject({ noReorder: true, orderQty: null, orderBy: null });
    // Sorted last by order-by date.
    expect((await listProducts(S, NO_FILTERS, 1, true, "online", NOW)).rows.at(-1)!.id).toBe(V(1));
    const sk = await searchVariantStock(S, ["shirt", "1"], true, 5);
    expect(sk.rows.find((r) => r.id === V(1))).toMatchObject({ orderQty: null, noReorder: true });
    // Back on: in the plan again.
    expect(await setNoReorder(S, { variantId: V(1) }, false)).toEqual({ ok: true, count: 1 });
    expect((await loadOrderPlan(S, NOW)).events.some((e) => e.variantId === V(1))).toBe(true);
    expect(await setNoReorder("other.myshopify.com", { variantId: V(1) }, true)).toEqual({ ok: false });
  });

  it("minimum in money: the supplier's currency converted with its rate, applied in the plan (Dashboard cash = Order now cash)", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Lisbon Linen", leadTimeDays: 14, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: ["acme"], currency: "USD", email: null, minOrderValue: 500, exchangeRate: 0.9 }];
    const plan = await loadOrderPlan(S, NOW);
    const week = thisWeek(plan);
    expect(week.totals.cash!).toBeGreaterThanOrEqual(450); // 500 USD × 0.9
    expect(plan.batches!.find((b) => b.supplierKey === "supplier:s1" && b.from === TODAY)!.valueToppedUp).toBe(true);
    const reorder = await loadReorder(S, [], "online", new Map(), NOW);
    const g = reorder.groups[0]!;
    const t = orderTotals(g, g.lines, (id) => g.lines.find((l) => l.variantId === id)!.suggested);
    expect(t.cost).toBe(week.totals.cash);
    // Shown in both currencies: the rate is known.
    expect(t.supplierCost).toBeCloseTo(t.cost! / 0.9, 2);
    // Variant 3's cost is in USD, the supplier's currency: converted with the rate, not dropped.
    expect(g.lines.find((l) => l.variantId === V(3))!.unitCostStore).toBeCloseTo(4.5, 9);
    expect(t.missingCost).toBe(0);
  });

  it("minimum per style: the product's other sizes are read and share the minimum by sales", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Lisbon Linen", leadTimeDays: 14, minOrder: 120, minOrderTotal: null, casePack: null, vendorMatch: ["acme"], currency: null, email: null, minOrderScope: "product" }];
    // Variant 7 is variant 1's other size, healthy (not due), selling 2/day.
    fake.tables.variant.push({ ...variant(7), productId: "P1", variantTitle: "L" });
    fake.tables.variantMetric.push(metric(7, 400, { orderBy: new Date("2027-06-01T00:00:00Z"), orderQty: null }));
    const plan = await loadOrderPlan(S, NOW);
    const now = dueWithin(plan.events, TODAY, 7).filter((e) => e.productId === "P1");
    expect(now.map((e) => e.variantId).sort()).toEqual([V(1), V(7)]);
    expect(now.reduce((a, e) => a + e.qty, 0)).toBe(120);
    expect(plan.batches!.find((b) => b.from === TODAY)!.styleToppedUp).toContain("P1");
  });

  it("the product's own case size (all its variants) wins over the supplier's", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Lisbon Linen", leadTimeDays: 14, minOrder: null, minOrderTotal: null, casePack: 4, vendorMatch: ["acme"], currency: null, email: null }];
    fake.tables.variant.push({ ...variant(7), productId: "P1", variantTitle: "L" });
    expect(await setProductCaseSize(S, "P1", 25)).toEqual({ ok: true, count: 2 });
    expect(fake.tables.variant.filter((v) => v.productId === "P1").map((v) => v.caseQty)).toEqual([25, 25]);
    const e = (await loadOrderPlan(S, NOW)).events.find((x) => x.variantId === V(1))!;
    expect(e.qty % 25).toBe(0);
    expect(await setProductCaseSize(S, "P1", null)).toEqual({ ok: true, count: 2 });
  });

  it("last year's sales in the same weeks (weekday-aligned, channel view), and unknown without history", async () => {
    const ly = (d: string, sold: number, extra: Record<string, unknown> = {}) => ({ shop: S, variantId: V(1), day: new Date(`${d}T00:00:00Z`), locationKey: "all", channel: "Online Store", sold, returned: 0, gross: 0, ...extra });
    // 364 days before 16 Oct 2026 is Fri 17 Oct 2025 (same weekday); the order covers 28 days.
    fake.tables.salesDaily = [ly("2025-09-01", 1), ly("2025-10-17", 4), ly("2025-11-13", 6), ly("2025-11-14", 50), ly("2025-10-20", 9, { locationKey: "online", channel: "all" })];
    const plan = await loadOrderPlan(S, NOW, { lastYear: true });
    const e = plan.events.find((x) => x.variantId === V(1) && x.orderBy === TODAY)!;
    expect(e.lastYear).toBe(10); // 17 Oct + 13 Nov; 14 Nov is day 29; the location view isn't added
    const v3 = plan.events.find((x) => x.variantId === V(3))!;
    expect(v3.lastYear).toBeNull(); // no history for that product
    expect((await loadOrderPlan(S, NOW)).events[0]!.lastYear).toBeUndefined(); // only when asked
  });

  it("large orders: 1,000 lines through one link, resolved on the server — nothing dropped", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Big", leadTimeDays: 14, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: ["acme"], currency: null, email: null }];
    fake.tables.variant = Array.from({ length: 1000 }, (_, i) => variant(100 + i));
    fake.tables.variantMetric = Array.from({ length: 1000 }, (_, i) => metric(100 + i, 10));
    const plan = await loadOrderPlan(S, NOW);
    const due = thisWeek(plan).suppliers[0]!;
    expect(due.lines).toBe(1000);
    const href = orderLink(due.events, due.supplierKey);
    expect(href.length).toBeLessThan(120);
    const link = readOrderLink(new URL(`https://x${href}`).searchParams)!;
    const r = await loadReorder(S, [], "online", new Map(), NOW, link);
    expect(r.groups[0]!.lines).toHaveLength(1000);
    // Creating the order keeps every line.
    const quantities = Object.fromEntries(r.groups[0]!.lines.map((l) => [l.variantId, l.suggested]));
    const created = await createOrderFromGroup(S, r.groups[0]!.key, quantities);
    expect(created.ok).toBe(true);
    expect((fake.tables.purchaseOrder.at(-1)!.lines as unknown[]).length).toBe(1000);
  }, 30_000);

  it("the Season plan's 1,000 lines through ?scenario= (no 250 cap)", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => ({ variantId: V(100 + i), qty: 3 }));
    const result = { version: RESULT_VERSION, groups: [{ key: "vendor:acme", lines }, { key: "supplier:x", lines: [{ variantId: V(1), qty: 7 }] }], cash: { weeks: [] }, period: {}, totals: {} };
    fake.tables.scenario = [{ id: "sc1", shop: S, result }];
    expect((await scenarioPlanned(S, "sc1", null))!.size).toBe(1001);
    expect([...(await scenarioPlanned(S, "sc1", "supplier:x"))!]).toEqual([[V(1), 7]]);
    // An older result version is not read (recalculate first); another shop's scenario isn't found.
    fake.tables.scenario = [{ id: "sc1", shop: S, result: { ...result, version: -1 } }];
    expect((await scenarioPlanned(S, "sc1", null))!.size).toBe(0);
    expect(await scenarioPlanned("other.myshopify.com", "sc1", null)).toBeNull();
  });

  it("computeOrderPlan keeps every planned variant's state for Products (with or without orders)", async () => {
    const { state } = await computeOrderPlan(S, NOW);
    expect(state.get(V(2))).toMatchObject({ skip: null, noReorder: false, supplierKey: "vendor:acme" });
    expect(state.get(V(2))!.deadline! > TODAY).toBe(true);
  });
});
