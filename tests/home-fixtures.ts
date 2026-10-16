/**
 * Fixtures for the Home tests (task 1.6): a MoneyAtStake basis in the engine's
 * shape and a ready shop. Pinned dates only.
 */
import type { HomeRaw } from "../app/lib/dashboard-shared";
import type { MoneyBasisJson } from "../app/lib/money-shared";

export function homeBasis(): MoneyBasisJson {
  const back90 = { days: 90, from: "2026-07-17", to: "2026-10-14" };
  return {
    computedAt: "2026-10-15T03:20:00Z",
    currency: "EUR",
    refresh: "daily",
    atRisk: {
      candidates: 12,
      variantsCounted: 9,
      skippedNoRate: 1,
      skippedNoPrice: 2,
      incomingAssumedWithin28: true,
      window: { days: 28, from: "2026-10-15", to: "2026-11-11" },
      currency: "EUR",
      costBasis: "retail",
    },
    lost90: {
      variantsCounted: 40,
      skippedNoRate: 0,
      skippedNoPrice: 0,
      outOfStockDays: 118,
      window: back90,
      currency: "EUR",
      costBasis: "retail",
    },
    cashStuck: {
      tooMuchCount: 5,
      deadCount: 4,
      variantsCounted: 9,
      skippedNoValue: 0,
      retailCount: 3,
      coverDays: 90,
      window: { days: 90, from: "2026-10-15", to: "2027-01-12" },
      currency: "EUR",
      costBasis: "retail",
    },
    soldOutTraffic: {
      productsWithData: 30,
      productsSoldOut: 4,
      soldOutSessions: 0,
      conversionRate: 0.02,
      aov: 60,
      window: { days: 30, from: "2026-09-15", to: "2026-10-14" },
      currency: "EUR",
      costBasis: "retail",
    },
  };
}

export function homeRaw(): HomeRaw {
  return {
    shop: {
      domain: "acme.myshopify.com",
      currency: "EUR",
      timezone: "Europe/Madrid",
      settings: {},
      backfillState: {
        startedAt: "2026-10-15T10:00:00Z",
        first90Ready: true,
        datasets: {
          products: { done: 1, total: 1 },
          stock: { done: 4, total: 13 },
          sales: { done: 6, total: 13 },
          visits: { done: 3, total: 13, lastError: "THROTTLED" },
        },
      },
      lastNightlyAt: new Date("2026-10-16T04:10:00Z"),
    },
    money: { day: "2026-10-15", atRisk: 1234.5, lost90: null, cashStuck: 800, soldOutTraffic: 0, basis: homeBasis() },
    trackedVariants: 200,
    variantsWithCost: 100,
    salesDays: 14,
  };
}
