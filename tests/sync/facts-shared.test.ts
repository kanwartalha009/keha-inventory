/**
 * Fact builders and the resumable backfill steps (task 1.4b): POS names mapped to Location
 * ids (online when null), the two sales views kept apart, duplicates summed, rows outside the
 * range (today) dropped; steps newest month first, first90Ready after 3 months, finishedAt.
 */
import { describe, expect, it } from "vitest";
import {
  ALL,
  ONLINE,
  locationNameIndex,
  salesByChannelFacts,
  salesByLocationFacts,
  sessionsFacts,
  shopDayFacts,
  stockFacts,
} from "../../app/lib/sync/facts-shared";
import {
  backfillPercent,
  clearErrors,
  completeStep,
  failStep,
  isBackfillDone,
  latestError,
  nextBackfillStep,
  type BackfillState,
} from "../../app/lib/sync/backfill-shared";
import { monthChunks } from "../../app/lib/sync/shopifyql-shared";

const V = "gid://shopify/ProductVariant/1";
const SEPT = { since: "2026-09-01", until: "2026-09-30" };
const locs = locationNameIndex([
  { id: "gid://shopify/Location/1", name: "Warehouse", active: true },
  { id: "gid://shopify/Location/2", name: "Madrid Store", active: true },
  { id: "gid://shopify/Location/9", name: "Madrid Store", active: false },
]);

describe("location names", () => {
  it("exact, then trimmed case-insensitive; active wins a duplicate name", () => {
    expect(locs("Warehouse")).toBe("gid://shopify/Location/1");
    expect(locs(" madrid store ")).toBe("gid://shopify/Location/2");
    expect(locs("Madrid Store")).toBe("gid://shopify/Location/2");
    expect(locs("Lisbon")).toBeUndefined();
  });
});

describe("sales facts", () => {
  const rows = [
    { day: "2026-09-02", variantId: V, locationKey: "online", channel: "unknown", sold: 3, gross: 0, returned: 0 },
    { day: "2026-09-02", variantId: V, locationKey: "Madrid Store", channel: "unknown", sold: 2, gross: 0, returned: 0 },
    { day: "2026-09-02", variantId: V, locationKey: "Madrid Store", channel: "unknown", sold: 1, gross: 0, returned: 0 },
    { day: "2026-09-02", variantId: V, locationKey: "Pop-up Lisbon", channel: "unknown", sold: 4, gross: 0, returned: 0 },
    { day: "2026-10-16", variantId: V, locationKey: "online", channel: "unknown", sold: 99, gross: 0, returned: 0 },
  ];
  it("location view: online for null POS, ids for known names, pos:<name> otherwise; out-of-range dropped", () => {
    const { facts, unmapped } = salesByLocationFacts(rows, SEPT, locs);
    expect(facts).toEqual([
      { day: "2026-09-02", variantId: V, locationKey: ONLINE, channel: ALL, sold: 3, returned: 0, gross: 0 },
      { day: "2026-09-02", variantId: V, locationKey: "gid://shopify/Location/2", channel: ALL, sold: 3, returned: 0, gross: 0 },
      { day: "2026-09-02", variantId: V, locationKey: "pos:Pop-up Lisbon", channel: ALL, sold: 4, returned: 0, gross: 0 },
    ]);
    expect(unmapped).toEqual(["Pop-up Lisbon"]);
  });

  it("channel view: locationKey = all, gross rounded to cents", () => {
    const facts = salesByChannelFacts(
      [
        { day: "2026-09-02", variantId: V, locationKey: "unknown", channel: "Online Store", sold: 2, gross: 50.005, returned: 0 },
        { day: "2026-09-02", variantId: V, locationKey: "unknown", channel: "Online Store", sold: 1, gross: 25, returned: 0 },
        { day: "2026-09-02", variantId: V, locationKey: "unknown", channel: "Point of Sale", sold: 1, gross: 25, returned: 0 },
        { day: "2026-08-31", variantId: V, locationKey: "unknown", channel: "Online Store", sold: 1, gross: 25, returned: 0 },
      ],
      SEPT,
    );
    expect(facts).toEqual([
      { day: "2026-09-02", variantId: V, locationKey: ALL, channel: "Online Store", sold: 3, returned: 0, gross: 75.01 },
      { day: "2026-09-02", variantId: V, locationKey: ALL, channel: "Point of Sale", sold: 1, returned: 0, gross: 25 },
    ]);
  });
});

describe("stock, sessions and totals", () => {
  it("stock: names → ids, unknown names skipped and reported", () => {
    const { facts, unmapped } = stockFacts(
      [
        { day: "2026-09-02", variantId: V, locationName: "Warehouse", endUnits: 10, outOfStock: false },
        { day: "2026-09-02", variantId: V, locationName: "Ghost", endUnits: 5, outOfStock: false },
        { day: "2026-09-02", variantId: V, locationName: "Madrid Store", endUnits: 0, outOfStock: true },
      ],
      SEPT,
      locs,
    );
    expect(facts).toEqual([
      { day: "2026-09-02", variantId: V, locationId: "gid://shopify/Location/1", endUnits: 10, outOfStock: false },
      { day: "2026-09-02", variantId: V, locationId: "gid://shopify/Location/2", endUnits: 0, outOfStock: true },
    ]);
    expect(unmapped).toEqual(["Ghost"]);
  });

  it("sessions and shop totals sum duplicate keys", () => {
    expect(
      sessionsFacts(
        [
          { day: "2026-09-02", landingPath: "/products/tee", trafficType: "google", sessions: 5, checkouts: 1 },
          { day: "2026-09-02", landingPath: "/products/tee", trafficType: "google", sessions: 2, checkouts: 0 },
        ],
        SEPT,
      ),
    ).toEqual([{ day: "2026-09-02", landingPath: "/products/tee", trafficType: "google", sessions: 7, checkouts: 1 }]);
    expect(shopDayFacts([{ day: "2026-09-02", orders: 3, gross: 120.5 }, { day: "2026-10-01", orders: 1, gross: 1 }], SEPT)).toEqual([
      { day: "2026-09-02", orders: 3, gross: 120.5 },
    ]);
  });
});

describe("resumable backfill steps", () => {
  const chunks = monthChunks("2025-10-01", "2026-10-15");
  const NOW = "2026-10-16T08:00:00.000Z";

  function runAll(state: BackfillState, stopAfter = Infinity) {
    const order: string[] = [];
    let s = state;
    for (let n = 0; n < stopAfter; n++) {
      const step = nextBackfillStep(s, chunks);
      if (step.kind === "done") break;
      order.push(step.kind === "products" ? "products" : `${step.dataset}@${step.range.since}`);
      s = completeStep(s, step, chunks, NOW);
    }
    return { order, state: s };
  }

  it("products first, then every dataset month by month, newest first", () => {
    const { order } = runAll({ range: { from: "2025-10-01", until: "2026-10-15" } }, 8);
    expect(order).toEqual([
      "products",
      "stock@2026-10-01",
      "sales@2026-10-01",
      "visits@2026-10-01",
      "stock@2026-09-01",
      "sales@2026-09-01",
      "visits@2026-09-01",
      "stock@2026-08-01",
    ]);
  });

  it("first90Ready after the newest 3 months of stock + sales; finishedAt and syncedThrough at the end", () => {
    const start: BackfillState = { range: { from: "2025-10-01", until: "2026-10-15" } };
    const partial = runAll(start, 1 + 3 * 2 + 1).state; // products + 2 full months + stock of month 3
    expect(partial.first90Ready).toBeUndefined();
    const ready = runAll(start, 1 + 3 * 2 + 2).state; // + sales of month 3
    expect(ready.first90Ready).toBe(true);
    expect(ready.finishedAt).toBeUndefined();
    expect(ready.datasets?.stock).toMatchObject({ done: 3, total: 13, doneThrough: "2026-08-01" });

    const { order, state } = runAll(start);
    expect(order).toHaveLength(1 + 13 * 3);
    expect(state.finishedAt).toBe(NOW);
    expect(state.syncedThrough).toBe("2026-10-15");
    expect(isBackfillDone(state)).toBe(true);
    expect(backfillPercent(state)).toBe(100);
  });

  it("a failed step keeps progress, records the error, and is retried next", () => {
    let s = runAll({ range: { from: "2025-10-01", until: "2026-10-15" } }, 2).state; // products + stock@Oct
    s = failStep(s, "sales", "ShopifyqlThrottledError: still throttled", NOW);
    expect(s.datasets?.sales).toMatchObject({ done: 0, lastError: "ShopifyqlThrottledError: still throttled", lastErrorAt: NOW });
    expect(latestError(s)).toEqual({ message: "ShopifyqlThrottledError: still throttled", at: NOW });
    const step = nextBackfillStep(s, chunks);
    expect(step).toMatchObject({ kind: "history", dataset: "sales", index: 0 });
    s = completeStep(s, step, chunks, NOW);
    expect(s.datasets?.sales?.lastError).toBeNull();
    expect(clearErrors(failStep(s, "stock", "x", NOW)).datasets?.stock?.lastError).toBeNull();
  });
});
