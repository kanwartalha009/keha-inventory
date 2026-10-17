/**
 * Money at stake: the 4 cards (spec §7.6), edges, retail fallback and null ("—") rules.
 */
import { describe, expect, it } from "vitest";
import { computeVariant } from "../../app/lib/engine/index-shared";
import {
  cashStuck,
  round2,
  salesAtRisk,
  salesLostToSellOuts,
  soldOutPageTraffic,
  stuckUnits,
  type ProductTraffic,
} from "../../app/lib/engine/money-shared";
import { TODAY, ago, buildSeries, moneyVariant as mv, variantInput } from "./fixtures";

const ctx = { today: TODAY, currency: "EUR" };

describe("salesAtRisk", () => {
  it("sums the 28-day shortfall × price for running_low and out only", () => {
    const card = salesAtRisk(
      [
        mv({ id: "low", status: "running_low", rate: 2, onHand: 10, incoming: 20, price: 25 }), // (56 − 30) × 25 = 650
        mv({ id: "out", status: "out", rate: 1, onHand: 0, price: 10 }), // 28 × 10 = 280
        mv({ id: "ok", status: "healthy", rate: 5, onHand: 0, price: 99 }),
      ],
      ctx,
    );
    expect(card.amount).toBe(930);
    expect(card.basis).toMatchObject({
      candidates: 2,
      variantsCounted: 2,
      incomingAssumedWithin28: true,
      currency: "EUR",
      costBasis: "retail",
      window: { days: 28, from: TODAY, to: "2026-11-12" },
    });
  });

  it("H3: projects day by day with dated incoming — out, 10 a day, 300 units arriving on day 25 risks 250", () => {
    // Old pooled maths: max(0, 280 − 300) = 0 at risk, as if the 300 were on the shelf today.
    const card = salesAtRisk([mv({ status: "out", rate: 10, onHand: 0, incoming: 300, incomingArrivals: [{ arrival: "2026-11-10", units: 300 }], price: 1 })], ctx);
    expect(card.amount).toBe(250);
    expect(card.basis).toMatchObject({ method: "day_by_day", incomingAssumedWithin28: false, incomingLateUnits: 0 });
  });

  it("dated incoming counts from its own day; after the window it doesn't count at all", () => {
    // TODAY 2026-10-16 → window 2026-10-16 … 2026-11-12. 2/day; onHand 10 + 10 undated (no lead
    // time known → today) last 10 days; days 10 … 26 lost (17 × 2 = 34) whether or not 20 units
    // land on day 27 (they serve only day 27).
    const at = (arrival: string) =>
      salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 30, incomingArrivals: [{ arrival, units: 20 }], price: 1 })], ctx);
    expect(at("2026-11-12").amount).toBe(34);
    expect(at("2026-11-13").amount).toBe(36); // day 27 lost too
    expect(at("2026-11-13").basis.incomingLateUnits).toBe(20);
    // Landing on day 5 instead: 10 + 10 cover days 0–9, the 20 cover days 10–19 → days 20–27 lost.
    expect(at("2026-10-21").amount).toBe(16);
    // Undated incoming without a lead time: on the shelf today (the old assumption) → 40 cover 20 days.
    expect(salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 30, price: 1 })], ctx).amount).toBe(16);
    // With a lead time it lands after it (as the forward plan): days 5–13 lost (18), then 30 cover the rest.
    const lead = salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 30, leadTimeDays: 14, price: 1 })], ctx);
    expect(lead.amount).toBe(18);
    expect(lead.basis.incomingAssumedWithin28).toBe(false);
    // Never below 0: more dated units than incoming (capped at incoming, arriving after the window).
    expect(salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 5, incomingArrivals: [{ arrival: "2027-01-01", units: 20 }], price: 1 })], ctx).amount).toBe(46);
  });

  it("negative on hand (oversold) is a backlog the incoming fills first", () => {
    // −20 owed; 30 arrive today; 1/day: 10 left for days 0–9, days 10–27 lost.
    expect(salesAtRisk([mv({ status: "out", rate: 1, onHand: -20, incoming: 30, incomingArrivals: [{ arrival: TODAY, units: 30 }], price: 1 })], ctx).amount).toBe(18);
  });

  it("applies seasonal × trend × plan and clamps oversold stock at 0", () => {
    const card = salesAtRisk(
      [mv({ status: "out", rate: 1, seasonal: 2, trend: 0.5, plan: 1.5, onHand: -4, price: 10 })],
      ctx,
    );
    expect(card.amount).toBe(420); // 1 × 2 × 0.5 × 1.5 × 28 = 42 units
  });

  it("is 0 when stock covers demand, and 0 when nothing is low or out", () => {
    expect(salesAtRisk([mv({ status: "running_low", rate: 1, onHand: 30, price: 10 })], ctx).amount).toBe(0);
    expect(salesAtRisk([mv({ status: "healthy" })], ctx).amount).toBe(0);
  });

  it("is null with no variants, or when no candidate has a rate and price", () => {
    expect(salesAtRisk([], ctx).amount).toBeNull();
    const card = salesAtRisk(
      [
        mv({ status: "out", rate: null, onHand: 0 }),
        mv({ id: "m2", status: "out", rate: 2, onHand: 0, price: null }),
      ],
      ctx,
    );
    expect(card.amount).toBeNull();
    expect(card.basis).toMatchObject({ skippedNoRate: 1, skippedNoPrice: 1 });
  });

  it("skips bundles", () => {
    expect(salesAtRisk([mv({ isBundle: true, status: "out", rate: 3, onHand: 0 })], ctx).amount).toBeNull();
  });

  it("rounds to 2 decimals at the end only", () => {
    const card = salesAtRisk(
      [
        mv({ id: "a", status: "out", rate: 1 / 3, onHand: 0, price: 19.99 }),
        mv({ id: "b", status: "out", rate: 1 / 3, onHand: 0, price: 19.99 }),
      ],
      ctx,
    );
    expect(card.amount).toBe(round2(2 * (28 / 3) * 19.99));
    expect(card.amount).toBe(373.15);
  });
});

describe("salesLostToSellOuts", () => {
  it("Σ out-of-stock days × rate × price over variants with a known rate", () => {
    const card = salesLostToSellOuts(
      [
        mv({ id: "a", rate: 2, price: 15, outOfStockDays: 10 }), // 300
        mv({ id: "b", rate: 0.5, price: 8, outOfStockDays: 4 }), // 16
        mv({ id: "c", rate: null, outOfStockDays: 50 }),
        mv({ id: "d", isBundle: true, rate: 9, outOfStockDays: 50 }),
      ],
      ctx,
    );
    expect(card.amount).toBe(316);
    expect(card.basis).toMatchObject({
      variantsCounted: 2,
      skippedNoRate: 1,
      outOfStockDays: 14,
      costBasis: "retail",
      window: { days: 90, from: ago(90), to: ago(1) },
    });
  });

  it("H1: backorder days (out of stock but still selling) are never lost sales", () => {
    // 60 days at ≤ 0 units while 3 a day kept selling (continue selling): nothing was lost.
    const r = computeVariant(
      variantInput({ series: buildSeries({ days: 90, sold: 3, endStock: (k) => (k <= 60 ? -10 : 5), oos: (k) => k <= 60 }), price: 20 }),
    )!;
    expect(r.outOfStockDays).toBe(0);
    expect(salesLostToSellOuts([r], ctx).amount).toBe(0);
    // A real sell-out (no sales) still counts: 10 days × 3 a day × 20.
    const out = computeVariant(
      variantInput({ series: buildSeries({ days: 90, sold: (k) => (k <= 10 ? 0 : 3), oos: (k) => k <= 10 }), price: 20 }),
    )!;
    expect(salesLostToSellOuts([out], ctx).amount).toBe(600);
  });

  it("is 0 when known-rate variants never sold out", () => {
    expect(salesLostToSellOuts([mv({ outOfStockDays: 0 })], ctx).amount).toBe(0);
  });

  it("is null when no variant has a known rate (or price)", () => {
    expect(salesLostToSellOuts([mv({ rate: null, outOfStockDays: 20 })], ctx).amount).toBeNull();
    expect(salesLostToSellOuts([mv({ price: null, outOfStockDays: 20 })], ctx).amount).toBeNull();
    expect(salesLostToSellOuts([], ctx).amount).toBeNull();
  });

  it("counts out-of-stock days only on days with data (via computeVariant)", () => {
    const series = buildSeries({
      days: 90,
      sold: (k) => (k <= 10 ? 0 : 2),
      oos: (k) => k <= 10,
      missing: (k) => k > 5 && k <= 10, // 5 of the 10 sold-out days have no data
      price: 10,
    });
    const r = computeVariant(variantInput({ series }))!;
    expect(r.outOfStockDays).toBe(5);
    expect(salesLostToSellOuts([r], ctx).amount).toBe(100); // 5 × 2 × 10
  });
});

describe("cashStuck", () => {
  it("H6: the 90-day cover is the projected demand over those 90 days (seasonal shape)", () => {
    // 2/day; January index 0.4 for 4 weeks, then normal. Old maths: 500 − 90 × 0.8 = 428 stuck.
    const jan = [0.4, 0.4, 0.4, 0.4, ...new Array(10).fill(1)];
    const r = computeVariant(variantInput({ onHand: 500, seasonal: 0.4, seasonCurve: jan, supplierLeadTimeDays: 14 }))!;
    // Day by day: 28 × 0.8 + 62 × 2 = 146.4 sold in 90 days → 353.6 stuck.
    expect(stuckUnits(r, 90)).toBeCloseTo(500 - (28 * 0.8 + 62 * 2), 9);
    const card = cashStuck([{ ...r, status: "too_much", cost: 1 }], ctx);
    expect(card.amount).toBeCloseTo(353.6, 2);
  });

  it("too_much excess at cost + dead at cost; labelled cost", () => {
    const card = cashStuck(
      [
        mv({ id: "tm", status: "too_much", rate: 2, onHand: 500, cost: 4 }), // (500 − 180) × 4 = 1280
        mv({ id: "dd", status: "dead", rate: 0, onHand: 30, cost: 5 }), // 150
        mv({ id: "ok", status: "healthy", onHand: 9999, cost: 100 }),
      ],
      ctx,
    );
    expect(card.amount).toBe(1430);
    expect(card.basis).toMatchObject({
      tooMuchCount: 1,
      deadCount: 1,
      retailCount: 0,
      costBasis: "cost",
      coverDays: 90,
    });
  });

  it("forecast rate includes seasonal × trend; excess never negative", () => {
    expect(cashStuck([mv({ status: "too_much", rate: 2, seasonal: 2, onHand: 500, cost: 1 })], ctx).amount).toBe(140);
    expect(cashStuck([mv({ status: "too_much", rate: 2, onHand: 100, cost: 1 })], ctx).amount).toBe(0);
  });

  it("falls back to retail price and labels the whole card retail", () => {
    const card = cashStuck(
      [
        mv({ id: "a", status: "dead", onHand: 10, cost: null, price: 20 }), // 200 at retail
        mv({ id: "b", status: "dead", onHand: 10, cost: 3, price: 20 }), // 30 at cost
        mv({ id: "c", status: "dead", onHand: 10, cost: 0, price: 7 }), // cost 0 = unknown → 70 retail
      ],
      ctx,
    );
    expect(card.amount).toBe(300);
    expect(card.basis).toMatchObject({ costBasis: "retail", retailCount: 2 });
  });

  it("0 when nothing is too_much or dead; null when empty or nothing can be valued", () => {
    expect(cashStuck([mv({ status: "healthy" })], ctx).amount).toBe(0);
    expect(cashStuck([], ctx).amount).toBeNull();
    const card = cashStuck([mv({ status: "dead", onHand: 10, cost: null, price: null })], ctx);
    expect(card.amount).toBeNull();
    expect(card.basis.skippedNoValue).toBe(1);
  });

  it("skips bundles", () => {
    expect(cashStuck([mv({ isBundle: true, status: "dead", onHand: 10 })], ctx).amount).toBeNull();
  });
});

describe("soldOutPageTraffic", () => {
  const product = (over: Partial<ProductTraffic> = {}): ProductTraffic => ({
    productId: "p1",
    handle: "red-shoe",
    days: [
      { day: ago(1), fullyOutOfStock: true, sessions: 100 },
      { day: ago(2), fullyOutOfStock: true, sessions: 50 },
      { day: ago(3), fullyOutOfStock: false, sessions: 1000 },
    ],
    ...over,
  });
  const store = { conversionRate: 0.02, aov: 80 };

  it("counts sessions only on fully-out days × conversion × AOV", () => {
    const card = soldOutPageTraffic([product()], store, ctx);
    expect(card.amount).toBe(240); // 150 × 0.02 × 80
    expect(card.basis).toMatchObject({
      soldOutSessions: 150,
      productsSoldOut: 1,
      productsWithData: 1,
      conversionRate: 0.02,
      aov: 80,
      window: { days: 30, from: ago(30), to: ago(1) },
    });
  });

  it("ignores days outside the last 30 days and bundles", () => {
    const card = soldOutPageTraffic(
      [
        product({
          days: [
            { day: ago(30), fullyOutOfStock: true, sessions: 10 },
            { day: ago(31), fullyOutOfStock: true, sessions: 999 },
            { day: TODAY, fullyOutOfStock: true, sessions: 999 },
          ],
        }),
        product({ productId: "b", isBundle: true }),
      ],
      store,
      ctx,
    );
    expect(card.amount).toBe(16); // 10 × 0.02 × 80
  });

  it("is 0 when products have data but never fully sold out", () => {
    const card = soldOutPageTraffic(
      [product({ days: [{ day: ago(1), fullyOutOfStock: false, sessions: 500 }] })],
      store,
      ctx,
    );
    expect(card.amount).toBe(0);
  });

  it("is null when conversion rate or AOV is unknown, or there is no data", () => {
    expect(soldOutPageTraffic([product()], { conversionRate: null, aov: 80 }, ctx).amount).toBeNull();
    expect(soldOutPageTraffic([product()], { conversionRate: 0.02, aov: null }, ctx).amount).toBeNull();
    expect(soldOutPageTraffic([], store, ctx).amount).toBeNull();
    expect(soldOutPageTraffic([product({ days: [] })], store, ctx).amount).toBeNull();
  });

  it("throws on a duplicate day for one product", () => {
    const d = { day: ago(1), fullyOutOfStock: true, sessions: 1 };
    expect(() => soldOutPageTraffic([product({ days: [d, d] })], store, ctx)).toThrow(/duplicate/);
  });
});
