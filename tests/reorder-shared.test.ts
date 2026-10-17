/** Order now (spec §5.3, J3; audit 2026-10-17): case packs, minimums, the plan's orders grouped by supplier and style. */
import { describe, expect, it } from "vitest";
import {
  buildOrderNow,
  groupTitle,
  groupTotals,
  lineQuantity,
  minimumWarnings,
  orderTotals,
  parseVariantsParam,
  parseVariantsWithQty,
  productRuns,
  readQty,
  topUpToMinimum,
  unitCostIn,
  type ReorderSupplierIn,
  type ReorderVariantIn,
} from "../app/lib/reorder-shared";
import { dueWithin } from "../app/lib/engine/forward-plan-shared";
import { lineCosts, linkedEvents, readOrderLink } from "../app/lib/order-plan-shared";
import { orderNowFixture } from "./order-plan-fixtures";

describe("lineQuantity", () => {
  it("rounds up to the case pack, then raises to the MOQ rounded to the pack", () => {
    expect(lineQuantity(7, 6, null)).toBe(12);
    expect(lineQuantity(7, null, null)).toBe(7);
    expect(lineQuantity(7, 6, 20)).toBe(24);
    expect(lineQuantity(30, 6, 20)).toBe(30);
    expect(lineQuantity(3, null, 10)).toBe(10);
  });
  it("keeps nothing-to-order at 0 (no forced MOQ)", () => {
    expect(lineQuantity(0, 6, 20)).toBe(0);
    expect(lineQuantity(-4, null, 5)).toBe(0);
  });
});

describe("topUpToMinimum", () => {
  it("leaves orders at or above the minimum alone", () => {
    expect(topUpToMinimum([{ qty: 60, pack: null, weight: 1 }], 50)).toEqual({ qtys: [60], toppedUp: false });
    expect(topUpToMinimum([{ qty: 10, pack: null, weight: 1 }], null)).toEqual({ qtys: [10], toppedUp: false });
  });

  it("tops up in proportion to forecast demand", () => {
    const r = topUpToMinimum(
      [
        { qty: 10, pack: null, weight: 3 },
        { qty: 10, pack: null, weight: 1 },
      ],
      100,
    );
    expect(r.toppedUp).toBe(true);
    expect(r.qtys).toEqual([70, 30]);
  });

  it("keeps every line a whole number of case packs and reaches the minimum", () => {
    const r = topUpToMinimum(
      [
        { qty: 12, pack: 6, weight: 2 },
        { qty: 10, pack: 10, weight: 1 },
        { qty: 5, pack: null, weight: 1 },
      ],
      100,
    );
    expect(r.qtys[0]! % 6).toBe(0);
    expect(r.qtys[1]! % 10).toBe(0);
    const total = r.qtys.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(100);
    expect(total).toBeLessThan(100 + 10); // overshoot below the largest pack
    expect(r.qtys[0]!).toBeGreaterThan(r.qtys[2]!); // the faster seller takes more
  });

  it("splits evenly when no line has a forecast, and skips lines at 0", () => {
    const r = topUpToMinimum(
      [
        { qty: 1, pack: null, weight: 0 },
        { qty: 0, pack: null, weight: 5 },
        { qty: 1, pack: null, weight: 0 },
      ],
      10,
    );
    expect(r.qtys).toEqual([5, 0, 5]);
  });

  it("does nothing when no line has a quantity", () => {
    expect(topUpToMinimum([{ qty: 0, pack: 6, weight: 1 }], 100)).toEqual({ qtys: [0], toppedUp: false });
  });
});

const variant = (n: number, over: Partial<ReorderVariantIn> = {}): ReorderVariantIn => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
  vendor: "Acme",
  image: null,
  supplierId: null,
  caseQty: null,
  cost: 5,
  costCurrency: "EUR",
  ...over,
});
const supplier = (over: Partial<ReorderSupplierIn> = {}): ReorderSupplierIn => ({
  id: "s1",
  name: "Acme Textiles",
  leadTimeDays: 30,
  minOrder: null,
  minOrderTotal: null,
  casePack: null,
  vendorMatch: ["Acme"],
  currency: null,
  hasEmail: true,
  ...over,
});
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

describe("buildOrderNow (Order now = the plan's orders due in the next 7 days)", () => {
  const plan = orderNowFixture({ minOrderTotal: null });
  const base = { plan, stock: new Map([[V(1), { onHand: 5, incoming: 0 }]]), onOrder: new Map<string, number>() };

  it("one line per variant at the plan's quantity, with its real deadline; later orders aren't lines", () => {
    const groups = buildOrderNow(base);
    expect(groups.map((g) => g.key)).toEqual(["supplier:s1", "vendor:beta"]);
    const due = dueWithin(plan.events, plan.today, 7);
    for (const g of groups)
      for (const l of g.lines) {
        const mine = due.filter((e) => e.variantId === l.variantId);
        expect(l.suggested).toBe(mine.reduce((a, e) => a + e.qty, 0));
        expect(l.orderBy).toBe(mine[0]!.deadline);
      }
    const acme = groups[0]!;
    expect(acme.overdue).toBe(true);
    expect(acme.orderBy).toBe("2026-09-29");
    // The sock is due on 24 Oct (day 8): not a line, but it can join (before the next order, 14 days).
    expect(acme.lines.some((l) => l.productTitle === "Wool sock")).toBe(false);
    expect(acme.joinable.map((l) => l.productTitle)).toEqual(["Wool sock"]);
  });

  it("lines by product then size; a product with an overdue line first", () => {
    const acme = buildOrderNow(base)[0]!;
    expect(acme.lines.map((l) => [l.productTitle, l.variantTitle])).toEqual([
      ["Canvas tote", "Default Title"],
      ["Linen shirt", "M"],
      ["Linen shirt", "S"],
    ]);
    expect(productRuns(acme.lines).map((r) => [r.title, r.lines.length])).toEqual([
      ["Canvas tote", 1],
      ["Linen shirt", 2],
    ]);
  });

  it("an orderLink range: that supplier's planned orders in the range instead of the next 7 days", () => {
    const link = readOrderLink(new URLSearchParams("supplier=supplier:s1&from=2026-10-30&to=2026-11-05"))!;
    const g = buildOrderNow({ ...base, link }).find((x) => x.key === "supplier:s1")!;
    const want = linkedEvents(plan.events, link);
    expect(g.lines.map((l) => l.variantId).sort()).toEqual([...new Set(want.map((e) => e.variantId))].sort());
    expect(g.lines.reduce((a, l) => a + l.suggested, 0)).toBe(want.reduce((a, e) => a + e.qty, 0));
    // Other suppliers keep their next 7 days.
    expect(buildOrderNow({ ...base, link }).find((x) => x.key === "vendor:beta")!.lines).toHaveLength(1);
  });

  it("asked-for variants: an action's 'Add to order' and the Season plan's quantities", () => {
    const groups = buildOrderNow({
      ...base,
      extraVariants: [variant(9, { productId: "P9", productTitle: "Mug", vendor: "Zeta" })],
      selected: new Set([V(9)]),
      planned: new Map([[V(1), 200]]),
    });
    const shirt = groups.flatMap((g) => g.lines).find((l) => l.variantId === V(1))!;
    expect(shirt).toMatchObject({ suggested: 204, fromPlanner: true, planned: 200, selected: true }); // cases of 6
    const mug = groups.find((g) => g.key === "vendor:zeta")!;
    expect(mug.lines[0]).toMatchObject({ productTitle: "Mug", suggested: 0, selected: true });
    expect(groups[0]!.selected).toBe(true);
  });

  it("valuation: store currency always; the supplier's only with an exchange rate; a line without a cost never blanks the order", () => {
    const usd = { ...plan, suppliers: { ...plan.suppliers, "supplier:s1": { ...plan.suppliers["supplier:s1"]!, currency: "USD", exchangeRate: 0.9 } } };
    const g = buildOrderNow({ ...base, plan: usd })[0]!;
    expect(g.currency).toBe("USD");
    const t = orderTotals(g, g.lines, (id) => g.lines.find((l) => l.variantId === id)!.suggested);
    expect(t.missingCost).toBe(1); // the tote
    expect(t.cost).toBe(Math.round(g.lines.reduce((a, l) => a + (l.unitCostStore ?? 0) * l.suggested, 0) * 100) / 100);
    expect(t.supplierCost).toBeCloseTo(t.cost! / 0.9, 2);
    // Without a rate: store currency only.
    const noRate = buildOrderNow({ ...base, plan: { ...usd, suppliers: { ...usd.suppliers, "supplier:s1": { ...usd.suppliers["supplier:s1"]!, exchangeRate: null } } } })[0]!;
    const t2 = orderTotals(noRate, noRate.lines, () => 6);
    expect(t2.cost).not.toBeNull();
    expect(t2.supplierCost).toBeNull();
    expect(lineCosts(10, null, "EUR", "USD", 0.9)).toEqual({ store: 10, supplier: 10 / 0.9 });
    expect(lineCosts(10, "USD", "EUR", "USD", 0.9)).toEqual({ store: 9, supplier: 10 });
    expect(lineCosts(10, "GBP", "EUR", "USD", 0.9)).toEqual({ store: null, supplier: null });
    expect(unitCostIn(5, null, "EUR", "EUR")).toBe(5);
    expect(unitCostIn(null, "EUR", "EUR", "EUR")).toBeNull();
  });

  it("the plan's top-ups show on the group (units in the plan, not added again here)", () => {
    const topped = orderNowFixture({ minOrderTotal: 300 });
    const g = buildOrderNow({ ...base, plan: topped })[0]!;
    expect(g.toppedUp).toBe(true);
    expect(g.lines.reduce((a, l) => a + l.suggested, 0)).toBeGreaterThanOrEqual(300);
    expect(g.lines.reduce((a, l) => a + l.suggested, 0)).toBe(dueWithin(topped.events, topped.today, 7).filter((e) => e.supplierKey === "supplier:s1").reduce((a, e) => a + e.qty, 0));
  });

  it("a line joining from a later order takes its own quantity, without that order's top-up", () => {
    const topped = orderNowFixture({ minOrderTotal: 300 });
    const sock = topped.events.find((e) => e.variantId === V(3))!;
    const g = buildOrderNow({ ...base, plan: topped })[0]!;
    expect(g.joinable[0]!.suggested).toBe(sock.why!.rounded);
  });
});

describe("totals and warnings", () => {
  const lines = [
    { variantId: "a", unitCost: 2.5, moq: 10, pack: 6 },
    { variantId: "b", unitCost: null, moq: null, pack: null },
  ];
  it("totals units; cost is unknown when an ordered line has no cost", () => {
    expect(groupTotals(lines, (id) => (id === "a" ? 12 : 0))).toEqual({ units: 12, cost: 30 });
    expect(groupTotals(lines, () => 12)).toEqual({ units: 24, cost: null });
  });
  it("warns (never blocks) below the minimums and off the case pack", () => {
    const w = minimumWarnings({ minOrderTotal: 50, lines: lines as never }, (id) => (id === "a" ? 8 : 3));
    expect(w).toEqual({ belowTotal: true, belowValue: false, belowLine: ["a"], belowStyle: [], notPack: ["a"] });
    expect(minimumWarnings({ minOrderTotal: 50, lines: lines as never }, () => 0).belowTotal).toBe(false);
  });
  it("warns below the money minimum (store currency) and below the minimum per style", () => {
    const styled = [
      { variantId: "a", productId: "shirt", unitCostStore: 2.5, moq: null, pack: null },
      { variantId: "b", productId: "shirt", unitCostStore: 2.5, moq: null, pack: null },
      { variantId: "c", productId: "sock", unitCostStore: null, moq: null, pack: null },
    ];
    const w = minimumWarnings({ minOrderTotal: null, minOrderValueStore: 100, minOrderScope: "product", minOrder: 30, lines: styled as never }, (id) => (id === "c" ? 40 : 10));
    expect(w).toMatchObject({ belowValue: true, belowStyle: ["shirt"], belowLine: [] });
  });
});

describe("inputs", () => {
  it("reads quantities as whole units", () => {
    expect(readQty("12")).toBe(12);
    expect(readQty("1.5")).toBe(0);
    expect(readQty(-3)).toBe(0);
    expect(readQty("abc")).toBe(0);
  });
  it("parses ?variants= gids and numeric ids", () => {
    expect(parseVariantsParam("gid://shopify/ProductVariant/1, 22,bad,gid://shopify/Product/3")).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/22",
    ]);
    expect(parseVariantsParam(null)).toEqual([]);
    // Planner links: id:qty (ids still parse; a bad quantity keeps the id without a plan).
    expect(parseVariantsParam("11:40,12")).toEqual(["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/12"]);
    expect([...parseVariantsWithQty("11:40,12,13:0,14:abc").planned]).toEqual([["gid://shopify/ProductVariant/11", 40]]);
    expect(parseVariantsWithQty("13:0").ids).toEqual(["gid://shopify/ProductVariant/13"]);
  });
});
