/**
 * Transfer plan (Phase 3, Pro `transfers`, pure): keep levels, a store's need, a
 * warehouse's spare (own needs, the online pool's needs when it counts for online sales,
 * no metric → nothing spare), allocation (largest need first, never more than the spare,
 * whole units rounded down, lines under 1 unit skipped, several warehouses), the
 * idempotency key material and the admin link.
 */
import { describe, expect, it } from "vitest";
import {
  buildTransferPlan,
  keepLevel,
  readTransferLines,
  storeNeed,
  transferAdminHref,
  transferKeyMaterial,
  transferUserErrors,
  uuidFromHex,
  warehouseSpare,
  type PlanMetric,
  type StockAt,
  type TransferPlanInput,
} from "../app/lib/transfers-shared";

/** rate r, σ 0, lead 10 + cycle 10, z 1.65 → keep = 20 r. */
const metric = (rate: number | null, status = "running_low", over: Partial<PlanMetric & { daysLeft: number | null }> = {}): PlanMetric & { daysLeft: number | null } => ({
  status,
  rate,
  sigma: 0,
  daysLeft: 2,
  inputs: { leadTimeDays: 10, cycleDays: 10, z: 1.65, seasonal: 1, trend: 1 },
  ...over,
});
const stock = (onHand: number, incoming = 0, available = onHand): StockAt => ({ onHand, incoming, available });

describe("keep level", () => {
  it("is demand over lead time + cycle (with seasonal × trend) plus safety stock", () => {
    expect(keepLevel(metric(2))).toBe(40);
    expect(keepLevel(metric(2, "healthy", { sigma: 1, inputs: { leadTimeDays: 16, cycleDays: 4, z: 2, seasonal: 1.5, trend: 1 } }))).toBeCloseTo(2 * 1.5 * 20 + 2 * 1 * 4, 10);
  });

  it("is unknown without a sales rate or the inputs", () => {
    expect(keepLevel(metric(null))).toBeNull();
    expect(keepLevel({ ...metric(2), inputs: {} })).toBeNull();
    expect(keepLevel(null)).toBeNull();
  });
});

describe("store need", () => {
  it("only Out / Running low with a known keep level, net of stock and incoming, ≥ 1 unit", () => {
    expect(storeNeed(metric(1), stock(5, 3))).toBe(12); // 20 − 8
    expect(storeNeed(metric(1, "out"), stock(0))).toBe(20);
    expect(storeNeed(metric(1, "healthy"), stock(0))).toBeNull();
    expect(storeNeed(metric(null, "out"), stock(0))).toBeNull(); // not enough sales there to size it
    expect(storeNeed(metric(1), stock(19.5))).toBeNull(); // under 1 unit
  });
});

describe("warehouse spare", () => {
  const own = metric(0, "healthy", { daysLeft: null });
  it("no warehouse metric → nothing spare", () => {
    expect(warehouseSpare(null, metric(1), false, stock(100))).toBe(0);
  });

  it("available minus its own keep level, rounded down", () => {
    expect(warehouseSpare(own, null, false, stock(100))).toBe(100);
    expect(warehouseSpare(metric(0.33, "healthy"), null, false, stock(100))).toBe(93); // 100 − 6.6
    expect(warehouseSpare(own, null, false, stock(100, 0, 70))).toBe(70); // committed units stay
  });

  it("a warehouse that counts for online sales also keeps the online pool's keep level", () => {
    expect(warehouseSpare(own, metric(2), true, stock(100))).toBe(60);
    expect(warehouseSpare(own, metric(null), true, stock(100))).toBe(0); // unknown → keep everything
    expect(warehouseSpare(own, metric(10), true, stock(100))).toBe(0);
  });
});

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const variants = new Map([1, 2, 3].map((n) => [V(n), { id: V(n), productTitle: `Shirt ${n}`, variantTitle: "M", sku: `S-${n}`, image: null }]));

function input(over: Partial<TransferPlanInput> = {}): TransferPlanInput {
  return {
    warehouses: [{ id: "W1", name: "Main", inPool: false }],
    stores: [
      { id: "S1", name: "Barcelona" },
      { id: "S2", name: "Madrid" },
    ],
    variants,
    metrics: new Map([
      ["W1", new Map([[V(1), metric(0, "healthy")], [V(2), metric(0, "healthy")]])],
      ["S1", new Map([[V(1), metric(1)], [V(2), metric(0.5, "out")]])], // needs 20 and 10
      ["S2", new Map([[V(1), metric(1.5, "out")]])], // needs 30
    ]),
    stock: new Map([
      ["W1", new Map([[V(1), stock(35)], [V(2), stock(100)]])],
      ["S1", new Map([[V(1), stock(0)], [V(2), stock(0)]])],
      ["S2", new Map([[V(1), stock(0)]])],
    ]),
    ...over,
  };
}

describe("buildTransferPlan", () => {
  it("serves the largest need first and never moves more than the spare", () => {
    const plan = buildTransferPlan(input());
    const line = (store: string, v: number) => plan.find((g) => g.destinationId === store)?.lines.find((l) => l.variantId === V(v));
    // V1: spare 35. Madrid needs 30 (largest) → 30; Barcelona needs 20 → the 5 left.
    expect(line("S2", 1)).toMatchObject({ qty: 30, need: 30, originSpare: 35 });
    expect(line("S1", 1)).toMatchObject({ qty: 5, need: 20, originSpare: 5 });
    // V2: Barcelona needs 10 from 100 spare.
    expect(line("S1", 2)).toMatchObject({ qty: 10, need: 10 });
    expect(plan.map((g) => [g.originId, g.destinationId, g.units])).toEqual([
      ["W1", "S2", 30],
      ["W1", "S1", 15],
    ]);
  });

  it("rounds down to whole units and skips lines under 1 unit", () => {
    const plan = buildTransferPlan(
      input({
        stores: [{ id: "S1", name: "Barcelona" }],
        metrics: new Map([
          ["W1", new Map([[V(1), metric(0, "healthy")]])],
          ["S1", new Map([[V(1), metric(0.62)]])], // need 12.4
        ]),
        stock: new Map([
          ["W1", new Map([[V(1), stock(30.0)]])],
          ["S1", new Map([[V(1), stock(0)]])],
        ]),
      }),
    );
    expect(plan[0]!.lines[0]).toMatchObject({ qty: 12, need: 12 });
    const none = buildTransferPlan(
      input({
        stores: [{ id: "S1", name: "Barcelona" }],
        stock: new Map([
          ["W1", new Map([[V(1), stock(0.5)]])],
          ["S1", new Map([[V(1), stock(0)]])],
        ]),
      }),
    );
    expect(none.flatMap((g) => g.lines).filter((l) => l.variantId === V(1))).toEqual([]);
  });

  it("no warehouse (or no warehouse metric) → nothing to move", () => {
    expect(buildTransferPlan(input({ warehouses: [] }))).toEqual([]);
    expect(buildTransferPlan(input({ metrics: new Map([...input().metrics].filter(([k]) => k !== "W1")) }))).toEqual([]);
  });

  it("a warehouse in the online pool keeps what the online pool needs", () => {
    const base = input();
    const plan = buildTransferPlan({
      ...base,
      warehouses: [{ id: "W1", name: "Main", inPool: true }],
      metrics: new Map([...base.metrics, ["online", new Map([[V(1), metric(1, "healthy")]])]]), // keeps 20 of V1
    });
    const v1 = plan.flatMap((g) => g.lines).filter((l) => l.variantId === V(1));
    expect(v1.reduce((a, l) => a + l.qty, 0)).toBe(15); // 35 − 20
    // V2 has no online metric: unknown → nothing spare.
    expect(plan.flatMap((g) => g.lines).some((l) => l.variantId === V(2))).toBe(false);
  });

  it("splits a need across warehouses, most spare first", () => {
    const base = input();
    const plan = buildTransferPlan({
      ...base,
      stores: [{ id: "S2", name: "Madrid" }],
      warehouses: [
        { id: "W1", name: "Main", inPool: false },
        { id: "W2", name: "North", inPool: false },
      ],
      metrics: new Map([...base.metrics, ["W2", new Map([[V(1), metric(0, "healthy")]])]]),
      stock: new Map([...base.stock, ["W1", new Map([[V(1), stock(10)]])], ["W2", new Map([[V(1), stock(25)]])]]),
    });
    expect(plan.map((g) => [g.originId, g.lines[0]!.qty])).toEqual([
      ["W2", 25],
      ["W1", 5],
    ]);
  });
});

describe("idempotency and links", () => {
  it("the same plan on the same day gives the same key material, whatever the line order", () => {
    const a = transferKeyMaterial("s", "W", "S", [{ variantId: "b", qty: 2 }, { variantId: "a", qty: 1 }], "2026-10-16");
    const b = transferKeyMaterial("s", "W", "S", [{ variantId: "a", qty: 1 }, { variantId: "b", qty: 2 }, { variantId: "c", qty: 0 }], "2026-10-16");
    expect(a).toBe(b);
    expect(transferKeyMaterial("s", "W", "S", [{ variantId: "a", qty: 1 }, { variantId: "b", qty: 2 }], "2026-10-17")).not.toBe(a); // next day
    expect(transferKeyMaterial("s", "W", "S", [{ variantId: "a", qty: 3 }, { variantId: "b", qty: 2 }], "2026-10-16")).not.toBe(a);
  });

  it("formats a digest like a UUID and links to the transfer in the admin", () => {
    expect(uuidFromHex("0123456789abcdef0123456789abcdef0123")).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(transferAdminHref("gid://shopify/InventoryTransfer/42")).toBe("shopify://admin/transfers/42");
  });

  it("reads stored lines and Shopify's user errors defensively", () => {
    expect(readTransferLines([{ variantId: "v", inventoryItemId: "i", quantity: 2 }, { bad: true }, null])).toEqual([
      { variantId: "v", inventoryItemId: "i", quantity: 2, productTitle: undefined, variantTitle: undefined },
    ]);
    expect(readTransferLines("x")).toEqual([]);
    expect(transferUserErrors([{ message: "Location not found" }, {}, null])).toEqual(["Location not found"]);
  });
});
