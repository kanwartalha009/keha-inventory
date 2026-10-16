/**
 * Shopify Flow triggers (spec §11, task 2.6): which products are in each
 * trigger's state, the payloads (keys exactly as the extension tomls declare),
 * and the once-per-episode rule.
 */
import { describe, expect, it } from "vitest";
import {
  FLOW_ENDED,
  FLOW_FIELDS,
  FLOW_FIRED,
  FLOW_NEEDS_REORDER,
  FLOW_WENT_DEAD,
  deadProductIds,
  episodeStep,
  FLOW_MAX_REJECTIONS,
  FLOW_REJECTED,
  legacyId,
  needsReorderPayload,
  needsReorderProducts,
  payloadMatches,
  productCash,
  variantCash,
  wentDeadPayload,
  type FlowMetric,
} from "../app/lib/flow-shared";

const P1 = "gid://shopify/Product/101";
const m = (over: Partial<FlowMetric>): FlowMetric => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: P1,
  status: "running_low",
  daysLeft: 6,
  orderQty: 40,
  orderBy: "2026-10-20",
  ...over,
});

describe("needs reorder", () => {
  it("running low or out, with an order quantity > 0 and known dates", () => {
    expect(needsReorderProducts([m({})]).get(P1)).toEqual({ variantId: "gid://shopify/ProductVariant/1", daysLeft: 6, orderBy: "2026-10-20", orderQty: 40 });
    expect(needsReorderProducts([m({ status: "out", daysLeft: 0 })]).size).toBe(1);
    for (const status of ["healthy", "too_much", "dead", "not_enough_data"]) expect(needsReorderProducts([m({ status })]).size).toBe(0);
    expect(needsReorderProducts([m({ orderQty: 0 })]).size).toBe(0);
    expect(needsReorderProducts([m({ orderQty: null })]).size).toBe(0);
    expect(needsReorderProducts([m({ daysLeft: null })]).size).toBe(0);
    expect(needsReorderProducts([m({ orderBy: null })]).size).toBe(0);
  });

  it("per product: the variant that runs out first (ties: the bigger order)", () => {
    const r = needsReorderProducts([
      m({ variantId: "v3", daysLeft: 9 }),
      m({ variantId: "v2", daysLeft: 2, orderQty: 10 }),
      m({ variantId: "v1", daysLeft: 2, orderQty: 30 }),
    ]);
    expect(r.get(P1)).toMatchObject({ variantId: "v1", orderQty: 30 });
  });

  it("payload: Shopify's product_id plus the declared keys, rounded", () => {
    const p = needsReorderPayload(P1, { variantId: "gid://shopify/ProductVariant/7", daysLeft: 3.456, orderBy: "2026-10-20", orderQty: 48 });
    expect(p).toEqual({
      product_id: 101,
      "Variant id": "gid://shopify/ProductVariant/7",
      "Days left": 3.5,
      "Order by": "2026-10-20",
      "Suggested quantity": 48,
    });
    expect(payloadMatches(FLOW_NEEDS_REORDER, p!)).toBe(true);
    expect(needsReorderPayload("not-a-gid", { variantId: "v", daysLeft: 1, orderBy: "2026-10-20", orderQty: 1 })).toBeNull();
  });
});

describe("went dead", () => {
  it("only when every planned variant of the product is dead", () => {
    expect(deadProductIds([m({ status: "dead" }), m({ status: "dead", variantId: "v2" })])).toEqual(new Set([P1]));
    expect(deadProductIds([m({ status: "dead" }), m({ status: "healthy", variantId: "v2" })]).size).toBe(0);
    expect(deadProductIds([m({ status: "dead" }), m({ status: "out", variantId: "v2" })]).size).toBe(0);
  });

  it("cash stuck: cost × on hand, retail price when the cost is missing, unknown never 0", () => {
    expect(variantCash({ onHand: 10, cost: 4.5, price: 20 })).toBe(45);
    expect(variantCash({ onHand: 10, cost: null, price: 20 })).toBe(200);
    expect(variantCash({ onHand: -2, cost: 4 })).toBe(0);
    expect(variantCash({ onHand: 10, cost: null, price: null })).toBeNull();
    expect(variantCash(undefined)).toBeNull();
    const cash = new Map<string, number | null>([["a", 10.111], ["b", 5], ["c", null]]);
    expect(productCash(["a", "b"], (v) => cash.get(v) ?? null)).toBe(15.11);
    expect(productCash(["a", "c"], (v) => cash.get(v) ?? null)).toBeNull();
  });

  it("payload: product_id and Cash stuck", () => {
    const p = wentDeadPayload(P1, 1234.567);
    expect(p).toEqual({ product_id: 101, "Cash stuck": 1234.57 });
    expect(payloadMatches(FLOW_WENT_DEAD, p!)).toBe(true);
    expect(payloadMatches(FLOW_WENT_DEAD, { product_id: 1 })).toBe(false);
    expect(payloadMatches(FLOW_WENT_DEAD, { product_id: 1, "Cash stuck": 2, extra: 3 })).toBe(false);
    expect(payloadMatches(FLOW_WENT_DEAD, { product_id: 1, "Cash stuck": null })).toBe(false);
  });
});

describe("keys and ids", () => {
  it("every custom key is letters and spaces only", () => {
    for (const keys of Object.values(FLOW_FIELDS))
      for (const k of keys) if (k !== "product_id") expect(k).toMatch(/^[A-Za-z ]+$/);
  });
  it("legacy ids", () => {
    expect(legacyId("gid://shopify/Product/9007199254740991")).toBe(9007199254740991);
    expect(legacyId("gid://shopify/Product/9007199254740993")).toBeNull(); // not a safe integer
    expect(legacyId("gid://shopify/Product/abc")).toBeNull();
  });
});

describe("episode rule: once per product until it leaves the state", () => {
  it.each([
    [undefined, true, "fire"],
    [FLOW_FIRED, true, "none"], // still in the same episode
    [FLOW_ENDED, true, "fire"], // came back after leaving
    [FLOW_FIRED, false, "end"], // left the state
    [FLOW_ENDED, false, "none"],
    [undefined, false, "none"],
  ] as const)("latest %s, in state %s → %s", (latest, inState, step) => {
    expect(episodeStep(latest, inState)).toBe(step);
  });
});

describe("a rejected trigger (review fix 2026-10-17): not a fire, retried after 24 h, bounded", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
  it("waits 24 h, then fires again while under the rejection cap", () => {
    expect(episodeStep(FLOW_REJECTED, true, { latestAt: ago(23), rejections: 1, now })).toBe("none");
    expect(episodeStep(FLOW_REJECTED, true, { latestAt: ago(24), rejections: 1, now })).toBe("fire");
    expect(episodeStep(FLOW_REJECTED, true, { latestAt: ago(48), rejections: FLOW_MAX_REJECTIONS - 1, now })).toBe("fire");
    expect(episodeStep(FLOW_REJECTED, true, { latestAt: ago(48), rejections: FLOW_MAX_REJECTIONS, now })).toBe("none");
    expect(episodeStep(FLOW_REJECTED, true)).toBe("none"); // no timing known: wait
  });
  it("leaving the state after a rejection ends the episode", () => {
    expect(episodeStep(FLOW_REJECTED, false)).toBe("end");
  });
});
