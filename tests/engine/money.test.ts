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

  it("review fix: dated incoming counts only when it arrives by today + 27 (the last day of the window)", () => {
    // TODAY 2026-10-16 → window 2026-10-16 … 2026-11-12. demand 2 × 28 = 56; onHand 10.
    const at = (arrival: string) =>
      salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 30, incomingArrivals: [{ arrival, units: 20 }], price: 1 })], ctx);
    // 2026-11-12: inside → stock 10 + 30 = 40 → 16 short.
    expect(at("2026-11-12").amount).toBe(16);
    // 2026-11-13: outside → the 20 dated units don't count; the 10 undated still do → 36 short.
    expect(at("2026-11-13").amount).toBe(36);
    expect(at("2026-11-13").basis.incomingLateUnits).toBe(20);
    // Undated incoming keeps the Phase 1 assumption.
    expect(salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 30, price: 1 })], ctx).amount).toBe(16);
    // Never below 0: more dated units than incoming.
    expect(salesAtRisk([mv({ status: "running_low", rate: 2, onHand: 10, incoming: 5, incomingArrivals: [{ arrival: "2027-01-01", units: 20 }], price: 1 })], ctx).amount).toBe(46);
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
