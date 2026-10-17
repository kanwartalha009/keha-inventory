/**
 * Supplier order builder, pure part (lib/supplier-order-shared; consolidated supplier purchase
 * order, Kanwar 2026-10-17): the window (due now, due within the supplier's order cycle), one
 * line per product at the plan's quantity before top-ups, the minimums applied once to the whole
 * order with the forward plan's own top-up functions, the minimum status, links, merging lines
 * into a draft, and the Free teaser.
 */
import { describe, expect, it } from "vitest";
import { orderNowFixture, PLAN_TODAY } from "./order-plan-fixtures";
import { addDays } from "../app/lib/engine/dates-shared";
import { buildOrderNow } from "../app/lib/reorder-shared";
import {
  addedLine,
  builderCycle,
  builderLink,
  builderTeaser,
  builderTotals,
  builderWindow,
  buildSupplierOrder,
  mergeDraftLines,
  minimumStatus,
  readBuilderLink,
  readBuilderQuantities,
  topUpOrder,
  type QtyLine,
} from "../app/lib/supplier-order-shared";
import type { OrderPlanData } from "../app/lib/order-plan-shared";

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const KEY = "supplier:s1";

function view(plan: OrderPlanData, over: Partial<OrderPlanData["suppliers"][string]> = {}, range: { from: string; to: string } | null = null) {
  return buildSupplierOrder({ plan, supplierKey: KEY, info: { ...plan.suppliers[KEY]!, ...over }, storeCycleDays: 14, range });
}

const qtyOf = (v: ReturnType<typeof view>, id: string) => v.lines.find((l) => l.variantId === id)?.suggested;
const asQty = (v: ReturnType<typeof view>, q: (id: string) => number = (id) => qtyOf(v, id) ?? 0): QtyLine[] => v.lines.map((l) => ({ ...l, qty: q(l.variantId) }));

describe("buildSupplierOrder", () => {
  it("due now = Order now's lines; due before the next order = its 'Can join this order'; one line per product, its own date", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const v = view(plan);
    expect(v).toMatchObject({ key: KEY, name: "Acme Textiles", cycleDays: 14, cycleSource: "store", from: PLAN_TODAY, dueTo: addDays(PLAN_TODAY, 6), cycleTo: addDays(PLAN_TODAY, 13), range: null });
    const now = buildOrderNow({ plan, stock: new Map(), onOrder: new Map() }).find((g) => g.key === KEY)!;
    expect(v.lines.filter((l) => l.section === "due").map((l) => [l.variantId, l.suggested]).sort()).toEqual(now.lines.map((l) => [l.variantId, l.suggested]).sort());
    expect(v.lines.filter((l) => l.section === "cycle").map((l) => [l.variantId, l.suggested])).toEqual(now.joinable.map((l) => [l.variantId, l.suggested]));
    // Each line keeps its own order-by date and "Why this quantity".
    const sock = v.lines.find((l) => l.variantId === V(3))!;
    expect(sock).toMatchObject({ section: "cycle", orderBy: addDays(PLAN_TODAY, 8), overdue: false, base: 18, suggested: 18, topUp: 0 });
    expect(sock.why).toHaveLength(1);
    // Overdue first within the section, sizes together; the vendor group's lines never appear.
    expect(v.lines[0]).toMatchObject({ section: "due", overdue: true });
    expect(v.lines.some((l) => l.variantId === V(5))).toBe(false);
  });

  it("the supplier's own cycle widens the window: several orders of one product add up to one line", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const v = view(plan, { orderCycleDays: 30 });
    expect(v).toMatchObject({ cycleDays: 30, cycleSource: "supplier", cycleTo: addDays(PLAN_TODAY, 29) });
    const sum = (id: string) => plan.events.filter((e) => e.variantId === id && e.orderBy <= v.cycleTo).reduce((a, e) => a + e.why!.rounded, 0);
    for (const n of [1, 2, 3, 4]) expect(qtyOf(v, V(n)), `V${n}`).toBe(sum(V(n)));
    const shirt = v.lines.find((l) => l.variantId === V(1))!;
    expect(shirt.why.length).toBe(2); // today's order and the one on 1 Nov
    expect(shirt.section).toBe("due");
    expect(shirt.orderBy! < PLAN_TODAY).toBe(true); // overdue: the date that passed
  });

  it("the minimums are applied once to the whole order (not per week): the cycle's lines can make a top-up unnecessary", () => {
    const plan = orderNowFixture({ minOrderTotal: 150 });
    // Order now tops this week's lines up to 150; with the sock due on day 8 the whole order already reaches it.
    const now = buildOrderNow({ plan, stock: new Map(), onOrder: new Map() }).find((g) => g.key === KEY)!;
    expect(now.toppedUp).toBe(true);
    const v = view(plan, { minOrderTotal: 150 });
    expect(v.lines.reduce((a, l) => a + l.base, 0)).toBeGreaterThanOrEqual(150);
    expect(v.lines.every((l) => l.topUp === 0)).toBe(true);
    expect(minimumStatus(v, asQty(v))).toMatchObject({ met: true, units: { min: 150, missing: 0 } });
  });

  it("below the minimum the order starts topped up: ≥ the minimum, in whole cases, shown on the line and in Why", () => {
    const plan = orderNowFixture({ minOrderTotal: 200 });
    const v = view(plan, { minOrderTotal: 200 });
    const units = v.lines.reduce((a, l) => a + l.suggested, 0);
    expect(v.lines.reduce((a, l) => a + l.base, 0)).toBeLessThan(200);
    expect(units).toBeGreaterThanOrEqual(200);
    expect(units - 200).toBeLessThan(6);
    for (const l of v.lines) expect(l.suggested % 6, l.variantId).toBe(0);
    const up = v.lines.filter((l) => l.topUp > 0);
    expect(up.length).toBeGreaterThan(0);
    for (const l of up) expect(l.why[l.why.length - 1]!.topUp).toBe(l.topUp);
    expect(minimumStatus(v, asQty(v))).toMatchObject({ met: true, units: { min: 200, missing: 0 } });
    // The merchant lowers a line: what is missing, and the top-up brings it back to the minimum.
    const lowered = asQty(v, (id) => (id === V(1) ? 6 : (qtyOf(v, id) ?? 0)));
    const s = minimumStatus(v, lowered);
    expect(s.met).toBe(false);
    expect(s.units!.missing).toBeGreaterThan(0);
    const fixed = topUpOrder(v, lowered);
    expect(fixed.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(200);
  });

  it("from Next 90 days: that week's orders are 'due', the cycle runs from the week's start", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const range = { from: "2026-11-01", to: "2026-11-01" };
    const v = view(plan, {}, range);
    expect(v).toMatchObject({ range, from: "2026-11-01", dueTo: "2026-11-01", cycleTo: "2026-11-14" });
    expect(v.lines.filter((l) => l.section === "due").map((l) => l.variantId).sort()).toEqual([V(1), V(2), V(4)].sort());
    expect(v.lines.filter((l) => l.section === "cycle").map((l) => l.variantId)).toEqual([V(3)]);
    // Nothing from before the week (today's orders belong to Order now).
    expect(qtyOf(v, V(1))).toBe(30);
  });

  it("a supplier with nothing planned opens empty (products can still be added)", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const v = buildSupplierOrder({ plan: { ...plan, events: [] }, supplierKey: KEY, info: plan.suppliers[KEY]!, storeCycleDays: 14 });
    expect(v.lines).toEqual([]);
    const a = addedLine({ variantId: V(9), productId: "P9", productTitle: "Scarf", variantTitle: "Default Title", sku: null, image: null, unitCostStore: 4, pack: 6, moq: null, weight: 0 });
    expect(a).toMatchObject({ section: "added", suggested: 6, orderBy: null, why: [] });
  });
});

describe("cycle and window", () => {
  it("the supplier's own cycle, else the planned cycle, else the store's; never under 7 days", () => {
    expect(builderCycle({ orderCycleDays: 75, cycleDays: 14 }, 14)).toEqual({ days: 75, source: "supplier" });
    expect(builderCycle({ orderCycleDays: null, cycleDays: 21 }, 14)).toEqual({ days: 21, source: "store" });
    expect(builderCycle({ orderCycleDays: null, cycleDays: null }, 30)).toEqual({ days: 30, source: "store" });
    expect(builderCycle({ orderCycleDays: 3 }, 14)).toEqual({ days: 7, source: "supplier" });
    expect(builderWindow(PLAN_TODAY, 75)).toEqual({ from: PLAN_TODAY, dueTo: addDays(PLAN_TODAY, 6), cycleTo: addDays(PLAN_TODAY, 74) });
    // A past range starts today; a range longer than the cycle keeps its end.
    expect(builderWindow(PLAN_TODAY, 7, { from: "2026-10-01", to: "2026-10-30" })).toEqual({ from: PLAN_TODAY, dueTo: "2026-10-30", cycleTo: "2026-10-30" });
  });
});

describe("minimums", () => {
  const base = { minOrderScope: "variant" as const, minOrder: null, minOrderTotal: null, minOrderValue: null, minOrderValueStore: null };
  const line = (id: number, product: string, qty: number, over: Partial<QtyLine> = {}): QtyLine => ({ variantId: V(id), productId: product, productTitle: product, pack: null, weight: 1, unitCostStore: 10, qty, ...over });

  it("units and money: what is missing, and the one-click top-up reaches it", () => {
    const v = { ...base, minOrderTotal: 100, minOrderValue: 1500, minOrderValueStore: 1500 };
    const lines = [line(1, "A", 30, { weight: 3 }), line(2, "B", 10, { weight: 1 }), line(3, "C", 0)];
    expect(minimumStatus(v, lines)).toMatchObject({ met: false, units: { min: 100, total: 40, missing: 60 }, value: { min: 1500, total: 400, missing: 1100 } });
    const up = topUpOrder(v, lines);
    expect(up[2]).toBe(0); // a line left out stays out
    const after = lines.map((l, i) => ({ ...l, qty: up[i]! }));
    expect(minimumStatus(v, after)).toMatchObject({ met: true, units: { missing: 0 }, value: { missing: 0 } });
    // By share of sales: the faster seller takes more.
    expect(up[0]! - 30).toBeGreaterThan(up[1]! - 10);
  });

  it("per style: each product below the minimum is named and topped up across its sizes", () => {
    const v = { ...base, minOrderScope: "product" as const, minOrder: 30 };
    const lines = [line(1, "Shirt", 12, { weight: 2 }), line(2, "Shirt", 6, { weight: 1 }), line(3, "Tote", 40)];
    const s = minimumStatus(v, lines);
    expect(s.styles).toEqual([{ productId: "Shirt", title: "Shirt", total: 18, missing: 12 }]);
    expect(s.met).toBe(false);
    const up = topUpOrder(v, lines);
    expect(up[0]! + up[1]!).toBe(30);
    expect(up[2]).toBe(40);
  });

  it("a money minimum without an exchange rate can't be checked: said, not hidden", () => {
    const s = minimumStatus({ ...base, minOrderValue: 500, minOrderValueStore: null }, [line(1, "A", 5)]);
    expect(s).toMatchObject({ valueUnknown: true, value: null, met: true, any: true });
    expect(minimumStatus(base, [line(1, "A", 5)]).any).toBe(false);
  });

  it("totals: store currency and the supplier's with a rate; a line without a cost is counted, never 0", () => {
    const lines = [line(1, "A", 10), line(2, "B", 5, { unitCostStore: null })];
    expect(builderTotals({ currency: "USD", storeCurrency: "EUR", exchangeRate: 0.5 }, lines)).toEqual({ units: 15, cost: 100, supplierCost: 200, missingCost: 1 });
    expect(builderTotals({ currency: "USD", storeCurrency: "EUR", exchangeRate: null }, lines).supplierCost).toBeNull();
  });
});

describe("links, quantities, drafts, teaser", () => {
  it("builderLink ↔ readBuilderLink; bad keys and ranges are ignored", () => {
    expect(builderLink(KEY)).toBe("/app/reorder/build?supplier=supplier:s1");
    const url = builderLink("vendor:beta co", { from: "2026-10-20", to: "2026-10-26" });
    expect(readBuilderLink(new URL(`https://x${url}`).searchParams)).toEqual({ supplierKey: "vendor:beta co", range: { from: "2026-10-20", to: "2026-10-26" } });
    expect(readBuilderLink(new URLSearchParams("supplier=other:1"))).toBeNull();
    expect(readBuilderLink(new URLSearchParams("supplier=supplier:s1&from=2026-10-26&to=2026-10-20"))).toEqual({ supplierKey: KEY, range: null });
  });

  it("readBuilderQuantities keeps whole units of variant gids only", () => {
    expect(readBuilderQuantities({ [V(1)]: 12, [V(2)]: "6", [V(3)]: 0, [V(4)]: 2.5, "gid://shopify/Product/1": 5, x: 1, [V(5)]: 2_000_000 })).toEqual({ [V(1)]: 12, [V(2)]: 6 });
    expect(readBuilderQuantities(null)).toEqual({});
    expect(readBuilderQuantities([1, 2])).toEqual({});
  });

  it("mergeDraftLines: one line per variant — units added to an existing line, new variants appended", () => {
    const po = (n: number, qty: number, extra = {}) => ({ variantId: V(n), qty, unitCost: 2, productTitle: `P${n}`, variantTitle: "M", sku: null, ...extra });
    const merged = mergeDraftLines([po(1, 10, { received: 0 }), po(2, 5)], [po(1, 6), po(3, 4), po(4, 0)]);
    expect(merged.map((l) => [l.variantId, l.qty])).toEqual([[V(1), 16], [V(2), 5], [V(3), 4]]);
    expect(merged[0]).toMatchObject({ received: 0 });
  });

  it("the Free teaser: the supplier's products, units and cash — no lines", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const v = view(plan);
    const t = builderTeaser(v);
    expect(t).toEqual({ name: "Acme Textiles", kind: "supplier", products: 3, units: 66 + 30 + 42 + 18, cash: (66 + 42) * 2.5 + 18, cycleDays: 14, currency: "EUR" });
    expect(Object.keys(t)).not.toContain("lines");
  });
});
