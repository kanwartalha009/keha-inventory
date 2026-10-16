/** Reorder plan (spec §5.3, J3): case packs, per-line and per-order minimums, grouping. */
import { describe, expect, it } from "vitest";
import {
  buildReorderGroups,
  groupTitle,
  groupTotals,
  lineQuantity,
  minimumWarnings,
  parseVariantsParam,
  readQty,
  topUpToMinimum,
  unitCostIn,
  type ReorderMetricIn,
  type ReorderSupplierIn,
  type ReorderVariantIn,
} from "../app/lib/reorder-shared";

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
const metric = (orderQty: number | null, over: Partial<ReorderMetricIn> = {}): ReorderMetricIn => ({
  orderQty,
  orderBy: "2026-11-12",
  daysLeft: 20,
  neverRunsOut: false,
  rate: 1,
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

describe("buildReorderGroups", () => {
  const base = {
    stock: new Map([["gid://shopify/ProductVariant/1", { onHand: 3, incoming: 2 }]]),
    storeCurrency: "EUR",
    defaultLeadTimeDays: 14,
  };

  it("groups by supplier (vendor match) and by vendor when unassigned, with lead time and the earliest order-by", () => {
    const groups = buildReorderGroups({
      ...base,
      variants: [variant(1), variant(2, { vendor: "Beta" }), variant(3), variant(4, { vendor: null })],
      metrics: new Map([
        [variant(1).id, metric(10, { orderBy: "2026-11-20" })],
        [variant(2).id, metric(5)],
        [variant(3).id, metric(4, { orderBy: "2026-11-02" })],
        [variant(4).id, metric(2, { orderBy: null })],
      ]),
      onOrder: new Map(),
      suppliers: [supplier()],
    });
    expect(groups.map((g) => [g.kind, g.name, g.leadTimeDays, g.orderBy])).toEqual([
      ["supplier", "Acme Textiles", 30, "2026-11-02"],
      ["vendor", "Beta", 14, "2026-11-12"],
      ["vendor", "", 14, null],
    ]);
    expect(groups[0]!.lines.map((l) => l.variantId)).toEqual([variant(3).id, variant(1).id]);
    expect(groups[0]!.lines[1]!.onHand).toBe(3);
    expect(groupTitle(groups[2]!, (s) => s)).toBe("No vendor");
  });

  it("subtracts only the Keha units compute did not already count in orderQty", () => {
    const id = variant(1).id;
    const run = (onOrder: number, kehaCounted: number) =>
      buildReorderGroups({
        ...base,
        variants: [variant(1)],
        metrics: new Map([[id, metric(30, { kehaCounted })]]),
        onOrder: new Map([[id, onOrder]]),
        suppliers: [],
      })[0]?.lines[0]?.suggested ?? 0;
    // 20 sent units counted by compute, nothing new: orderQty stands.
    expect(run(20, 20)).toBe(30);
    // 20 counted + a 5-unit draft made since: subtract the 5.
    expect(run(25, 20)).toBe(25);
    // Counted units already received (no longer open): nothing extra to subtract.
    expect(run(0, 20)).toBe(30);
  });

  it("subtracts open Keha orders and drops lines with nothing left to order", () => {
    const groups = buildReorderGroups({
      ...base,
      variants: [variant(1), variant(2)],
      metrics: new Map([
        [variant(1).id, metric(10)],
        [variant(2).id, metric(5)],
      ]),
      onOrder: new Map([
        [variant(1).id, 4],
        [variant(2).id, 5],
      ]),
      suppliers: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.lines.map((l) => [l.variantId, l.suggested, l.onOrder])).toEqual([[variant(1).id, 6, 4]]);
  });

  it("applies case pack (variant wins), MOQ and the order minimum with a top-up", () => {
    const groups = buildReorderGroups({
      ...base,
      variants: [variant(1, { caseQty: 12 }), variant(2)],
      metrics: new Map([
        [variant(1).id, metric(5, { rate: 3 })],
        [variant(2).id, metric(5, { rate: 1 })],
      ]),
      onOrder: new Map(),
      suppliers: [supplier({ casePack: 6, minOrder: 10, minOrderTotal: 100 })],
    });
    const g = groups[0]!;
    expect(g.toppedUp).toBe(true);
    const [a, b] = g.lines;
    expect(a!.pack).toBe(12);
    expect(b!.pack).toBe(6);
    expect(a!.suggested % 12).toBe(0);
    expect(b!.suggested % 6).toBe(0);
    expect(a!.suggested + b!.suggested).toBeGreaterThanOrEqual(100);
    expect(a!.suggested).toBeGreaterThan(b!.suggested);
  });

  it("puts selected variants first, even without a suggestion", () => {
    const groups = buildReorderGroups({
      ...base,
      variants: [variant(1), variant(2, { vendor: "Zed" })],
      metrics: new Map([[variant(1).id, metric(10, { orderBy: "2026-10-20" })]]),
      onOrder: new Map(),
      suppliers: [],
      selected: new Set([variant(2).id]),
    });
    expect(groups[0]!.name).toBe("Zed");
    expect(groups[0]!.selected).toBe(true);
    expect(groups[0]!.lines[0]!.suggested).toBe(0);
  });

  it("only knows the unit cost when it is in the order currency", () => {
    const groups = buildReorderGroups({
      ...base,
      variants: [variant(1)],
      metrics: new Map([[variant(1).id, metric(10)]]),
      onOrder: new Map(),
      suppliers: [supplier({ currency: "USD" })],
    });
    expect(groups[0]!.currency).toBe("USD");
    expect(groups[0]!.lines[0]!.unitCost).toBeNull();
    expect(unitCostIn(5, null, "EUR", "EUR")).toBe(5);
    expect(unitCostIn(null, "EUR", "EUR", "EUR")).toBeNull();
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
    expect(w).toEqual({ belowTotal: true, belowLine: ["a"], notPack: ["a"] });
    expect(minimumWarnings({ minOrderTotal: 50, lines: lines as never }, () => 0).belowTotal).toBe(false);
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
  });
});
