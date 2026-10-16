/**
 * Fixtures for the Home tests (task 1.6): a MoneyAtStake basis in the engine's
 * shape and a ready shop; action rows for the action list (task 2.3). Pinned
 * dates only.
 */
import type { HomeRaw } from "../app/lib/dashboard-shared";
import type { MoneyBasisJson } from "../app/lib/money-shared";
import { buildActionList, type ActionListView, type ActionRowIn, type ClearanceRowIn, type VariantInfo } from "../app/lib/action-list-shared";
import type { PlanCode } from "../app/lib/plan-shared";

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

// ── Action list (task 2.3) ──────────────────────────────────────────────────


export const ACTIONS_NOW = new Date("2026-10-16T10:00:00Z");

const pid = (n: number) => `gid://shopify/Product/${n}`;
const vid = (n: number) => `gid://shopify/ProductVariant/${n}`;

/** One product per kind (titles name the kind), plus filler reorder rows for the Free limit. */
export function actionRows(fillers = 0): ActionRowIn[] {
  const row = (id: string, kind: string, n: number, amount: number, reason: unknown = {}): ActionRowIn => ({
    id,
    kind,
    productId: pid(n),
    variantIds: [vid(n * 10 + 1), vid(n * 10 + 2)],
    amount,
    currency: "EUR",
    // ACTION_REASONS is filled by the engine task; the raw key is the fallback and is filled with its params.
    reason: { key: "Runs out in {days} days", params: { days: n }, facts: { "Sales per day": 2.5, "Lead time": null }, ...(reason as object) },
    state: "open",
    snoozeUntil: null,
    stateAmount: null,
  });
  return [
    row("r", "reorder", 1, 3400),
    row("b", "bridge", 2, 2900, { facts: { arrivalDate: "2026-11-02" } }),
    row("p", "push", 3, 2100),
    row("ff", "fix_falling", 4, 1900),
    row("fs", "fix_sizes", 5, 1700),
    row("fp", "fix_page", 6, 1600),
    row("fr", "fix_returns", 7, 1500),
    row("c", "clear", 8, 8200),
    ...Array.from({ length: fillers }, (_, i) => row(`x${i}`, "reorder", 20 + i, 100 - i)),
  ];
}

const TITLES: Record<number, string> = {
  1: "Reorder Tee",
  2: "Bridge Boots",
  3: "Push Parka",
  4: "Falling Fleece",
  5: "Sizes Sneaker",
  6: "Page Poncho",
  7: "Returns Romper",
  8: "Clear Cardigan",
};

export function actionVariants(): VariantInfo[] {
  const out: VariantInfo[] = [];
  for (let n = 1; n <= 40; n++) {
    for (const k of [1, 2]) {
      out.push({ id: vid(n * 10 + k), productId: pid(n), productTitle: TITLES[n] ?? `Filler ${n}`, variantTitle: k === 1 ? "S" : "M", image: null });
    }
  }
  return out;
}

export function clearanceRows(): ClearanceRowIn[] {
  return [
    {
      id: "cl1",
      kind: "code",
      code: "CLEAR-7Q3K",
      percent: 20,
      productIds: [pid(9)],
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: new Date("2026-11-15T22:59:59Z"),
      baselineCash: 5000,
      currency: "EUR",
      currentCash: 3800,
      retail: true,
      productTitle: "Old Overcoat",
    },
  ];
}

export function actionList(plan: PlanCode, opts: { fillers?: number; preorderInstalled?: boolean; empty?: boolean } = {}): ActionListView {
  return buildActionList({
    actions: opts.empty ? [] : actionRows(opts.fillers ?? 0),
    variants: actionVariants(),
    clearances: opts.empty ? [] : clearanceRows(),
    plan,
    now: ACTIONS_NOW,
    today: "2026-10-16",
    storeHandle: "acme",
    preorderInstalled: opts.preorderInstalled ?? false,
    currency: "EUR",
  });
}
