/**
 * Consolidated supplier purchase order (Kanwar 2026-10-17) on an in-memory Prisma: the
 * supplier's own order cycle in the forward plan (order quantities cover lead time + that
 * cycle), the supplier order builder's data, one draft for everything due within the cycle,
 * adding lines to an existing draft, and the netting on every screen afterwards (Order now,
 * Next 13 weeks, Sidekick's get_order_plan).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] }, ["purchaseOrder"]);
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { computeOrderPlan, loadOrderPlan } from "../app/models/order-plan.server";
import { kehaOnOrder, loadReorder } from "../app/models/reorder.server";
import { addToSupplierDraft, createSupplierDraft, loadSupplierOrder, searchSupplierProducts } from "../app/models/supplier-order.server";
import { demand, safetyStock } from "../app/lib/engine/order-shared";
import { addDays } from "../app/lib/engine/dates-shared";
import { readPoLines } from "../app/lib/supplier-shared";
import type { SupplierOrderView } from "../app/lib/supplier-order-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(fake);
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

const KEY = "supplier:s1";
const DAY = 86_400_000;
const quantitiesOf = (v: SupplierOrderView) => Object.fromEntries(v.lines.map((l) => [l.variantId, l.suggested]));
const sumQty = (events: { variantId: string; qty: number }[], id: string) => events.filter((e) => e.variantId === id).reduce((a, e) => a + e.qty, 0);

describe("the supplier order builder", () => {
  beforeEach(() => {
    fake.tables.supplier = [supplier({ orderCycleDays: 30 })];
  });

  it("gathers the supplier's lines due now and due within its 30-day cycle, at the plan's quantities", async () => {
    const r = (await loadSupplierOrder(S, KEY, null, NOW))!;
    expect(r.today).toBe(TODAY);
    const v = r.view;
    expect(v).toMatchObject({ key: KEY, name: "Acme Textiles", cycleDays: 30, cycleSource: "supplier", cycleTo: addDays(TODAY, 29), draft: null });
    expect(v.lines.map((l) => [l.variantId, l.section])).toEqual([
      [V(1), "due"],
      [V(2), "cycle"],
    ]);
    // The same quantities as the plan the other screens read (before top-ups; no minimums here).
    const plan = await loadOrderPlan(S, NOW);
    for (const l of v.lines) expect(l.suggested).toBe(sumQty(plan.events.filter((e) => e.orderBy <= v.cycleTo), l.variantId));
    expect(v.lines[1]!.orderBy).toBe(plan.events.find((e) => e.variantId === V(2))!.orderBy);
    // Another vendor's product never appears; an unknown supplier is null.
    expect(v.lines.some((l) => l.variantId === V(4))).toBe(false);
    expect(await loadSupplierOrder(S, "supplier:nope", null, NOW)).toBeNull();
    // A vendor group opens too (products without a supplier).
    expect((await loadSupplierOrder(S, "vendor:other", null, NOW))!.view).toMatchObject({ kind: "vendor", name: "Other" });
  });

  it("Add products: the supplier's own products only, every word in any order", async () => {
    expect((await searchSupplierProducts(S, KEY, "")).map((p) => p.variantId)).toEqual([V(1), V(2), V(3)]);
    expect((await searchSupplierProducts(S, KEY, "3 SHIRT")).map((p) => p.variantId)).toEqual([V(3)]);
    expect((await searchSupplierProducts(S, KEY, "S-4")).map((p) => p.variantId)).toEqual([]);
    expect((await searchSupplierProducts(S, "vendor:other", "")).map((p) => p.variantId)).toEqual([V(4)]);
    expect(await searchSupplierProducts(S, "supplier:nope", "")).toEqual([]);
    const p = (await searchSupplierProducts(S, KEY, "shirt 2"))[0]!;
    expect(p).toMatchObject({ unitCostStore: 2, weight: 2, pack: null, moq: null });
  });

  it("one draft for the whole cycle (another supplier's line is refused); its lines leave Order now and Next 13 weeks", async () => {
    const { view } = (await loadSupplierOrder(S, KEY, null, NOW))!;
    const before = await loadOrderPlan(S, NOW);
    expect(before.events.some((e) => e.variantId === V(1) && e.orderBy <= view.cycleTo)).toBe(true);
    const r = await createSupplierDraft(S, KEY, { ...quantitiesOf(view), [V(3)]: 12, [V(4)]: 99 });
    expect(r).toMatchObject({ ok: true, number: "PO-0001" });
    expect(fake.tables.purchaseOrder).toHaveLength(1);
    const po = fake.tables.purchaseOrder[0]!;
    po.createdAt = NOW; // the database default (the in-memory Prisma has none)
    expect(po).toMatchObject({ supplierId: "s1", supplierName: "Acme Textiles", status: "draft", source: "keha", currency: "EUR" });
    expect(readPoLines(po.lines).map((l) => [l.variantId, l.qty, l.unitCost])).toEqual([
      [V(1), view.lines[0]!.suggested, 2],
      [V(2), view.lines[1]!.suggested, 2],
      [V(3), 12, 2],
    ]);
    // Cross-screen: the draft counts as ordered (under 14 days), so none of its lines is due again
    // within the cycle — not on Order now, not in Next 13 weeks (the same plan), not in the builder.
    const after = await loadOrderPlan(S, NOW);
    for (const id of [V(1), V(2)]) expect(after.events.filter((e) => e.variantId === id && e.orderBy <= view.cycleTo), id).toEqual([]);
    const now = await loadReorder(S, [], "online", new Map(), NOW);
    expect(now.groups.flatMap((g) => g.lines.map((l) => l.variantId))).not.toContain(V(1));
    expect(now.groups.flatMap((g) => g.joinable.map((l) => l.variantId))).not.toContain(V(2));
    // Later cycles still plan (the next order after this one), and the other vendor is untouched.
    expect(after.events.some((e) => e.variantId === V(1) && e.orderBy > view.cycleTo)).toBe(true);
    expect(sumQty(after.events, V(4))).toBe(sumQty(before.events, V(4)));
    const again = (await loadSupplierOrder(S, KEY, null, NOW))!.view;
    expect(again.lines).toEqual([]);
    expect(again.draft).toMatchObject({ number: "PO-0001", units: view.lines[0]!.suggested + view.lines[1]!.suggested + 12 });
    // Nothing for this supplier: refused, nothing created.
    expect(await createSupplierDraft(S, KEY, { [V(4)]: 5 })).toEqual({ ok: false, error: "empty" });
    expect(await createSupplierDraft(S, "supplier:nope", { [V(1)]: 5 })).toEqual({ ok: false, error: "gone" });
    expect(fake.tables.purchaseOrder).toHaveLength(1);
  });

  it("Add to PO-00xx: lines merge into the fresh draft (one line per variant); stale version, another supplier and old drafts are refused", async () => {
    fake.tables.purchaseOrder = [
      { id: "d1", shop: S, number: "PO-0007", source: "keha", status: "draft", supplierId: "s1", supplierName: "Acme Textiles", lines: [{ variantId: V(1), qty: 10, unitCost: 2, productTitle: "Shirt 1", variantTitle: "M", sku: "S-1" }], confirmToken: "t1", currency: "EUR", createdAt: new Date(NOW.getTime() - 2 * DAY), updatedAt: new Date("2026-10-15T10:00:00Z") },
      { id: "old", shop: S, number: "PO-0003", source: "keha", status: "draft", supplierId: "s1", supplierName: "Acme Textiles", lines: [{ variantId: V(3), qty: 4, unitCost: 2, productTitle: "Shirt 3", variantTitle: "M", sku: "S-3" }], confirmToken: "t0", currency: "EUR", createdAt: new Date(NOW.getTime() - 20 * DAY), updatedAt: new Date("2026-09-26T10:00:00Z") },
      { id: "other", shop: S, number: "PO-0008", source: "keha", status: "draft", supplierId: null, supplierName: "Other", lines: [], confirmToken: "t2", currency: "EUR", createdAt: new Date(NOW.getTime() - DAY), updatedAt: new Date("2026-10-15T11:00:00Z") },
    ];
    const { view } = (await loadSupplierOrder(S, KEY, null, NOW))!;
    // The fresh draft is offered, never the one older than 14 days or another supplier's.
    expect(view.draft).toMatchObject({ id: "d1", number: "PO-0007", units: 10, updatedAt: "2026-10-15T10:00:00.000Z" });
    const add = { [V(1)]: 5, [V(3)]: 7 };
    expect(await addToSupplierDraft(S, KEY, "d1", add, "2026-10-01T00:00:00.000Z", NOW)).toEqual({ ok: false, error: "changed" });
    expect(await addToSupplierDraft(S, KEY, "other", add, undefined, NOW)).toEqual({ ok: false, error: "notAllowed" });
    expect(await addToSupplierDraft(S, KEY, "old", add, undefined, NOW)).toEqual({ ok: false, error: "notAllowed" });
    expect(await addToSupplierDraft(S, KEY, "d1", { [V(4)]: 3 }, view.draft!.updatedAt, NOW)).toEqual({ ok: false, error: "empty" });
    expect(await addToSupplierDraft(S, KEY, "d1", add, view.draft!.updatedAt, NOW)).toEqual({ ok: true, id: "d1", number: "PO-0007", added: true });
    const d1 = fake.tables.purchaseOrder.find((o) => o.id === "d1")!;
    expect(readPoLines(d1.lines).map((l) => [l.variantId, l.qty])).toEqual([
      [V(1), 15],
      [V(3), 7],
    ]);
    expect(fake.tables.purchaseOrder.find((o) => o.id === "old")!.lines).toHaveLength(1);
  });

  it("Sidekick's get_order_plan (the same loadOrderPlan) counts lines added to a draft once", async () => {
    const draft = (lines: { variantId: string; qty: number }[]) => ({ id: "d1", shop: S, number: "PO-0007", source: "keha", status: "draft", supplierId: "s1", supplierName: "Acme Textiles", lines: lines.map((l) => ({ ...l, unitCost: 2, productTitle: "x", variantTitle: "M", sku: null })), confirmToken: "t1", currency: "EUR", createdAt: new Date(NOW.getTime() - DAY), updatedAt: new Date("2026-10-15T10:00:00Z") });
    fake.tables.purchaseOrder = [draft([{ variantId: V(1), qty: 10 }])];
    expect(await addToSupplierDraft(S, KEY, "d1", { [V(1)]: 20, [V(2)]: 30 }, "2026-10-15T10:00:00.000Z", NOW)).toMatchObject({ ok: true });
    const merged = await loadOrderPlan(S, NOW);
    const onOrder = await kehaOnOrder(S, ["draft", "sent", "confirmed"], undefined, { now: NOW });
    expect(onOrder.get(V(1))!.qty).toBe(30);
    expect(onOrder.get(V(2))!.qty).toBe(30);
    // Exactly the plan of one draft holding those units from the start: nothing counted twice.
    fake.tables.purchaseOrder = [draft([{ variantId: V(1), qty: 30 }, { variantId: V(2), qty: 30 }])];
    const single = await loadOrderPlan(S, NOW);
    const strip = (p: typeof single) => p.events.map((e) => [e.variantId, e.orderBy, e.qty]);
    expect(strip(merged)).toEqual(strip(single));
  });
});
