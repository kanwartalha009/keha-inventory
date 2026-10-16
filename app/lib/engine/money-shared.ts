/**
 * Money at stake: the 4 Home cards (spec §7.6). Store currency.
 *
 * Null rule ("—", never 0, invariant I-5): a card is null when there are no
 * usable inputs at all, or when it had candidates but none could be valued.
 * A card is 0 only when inputs are present and nothing qualifies.
 * Bundles are skipped everywhere. Rounding to 2 decimals happens at the end only.
 */
import { addDays, type DayKey } from "./dates-shared";
import { demand, forecastRate } from "./order-shared";
import {
  ENGINE_DEFAULTS,
  type EngineSettings,
  type MoneyCard,
  type MoneyWindow,
  type VariantStatus,
} from "./types-shared";

/** Per-variant input; a computeVariant() result satisfies it. */
export interface MoneyVariant {
  id: string;
  isBundle?: boolean;
  status: VariantStatus;
  rate: number | null;
  seasonal?: number;
  trend?: number;
  plan?: number;
  onHand: number;
  /** Units on order. No arrival date yet, so assumed to land within the at-risk horizon. */
  incoming?: number;
  /** Unit selling price; null/≤0 = unknown. */
  price: number | null;
  /** Unit cost; null/≤0 = unknown. */
  cost: number | null;
  /** Out-of-stock days WITH data over the history window (90 d). */
  outOfStockDays: number;
}

export interface MoneyContext {
  today: DayKey;
  currency: string;
  settings?: EngineSettings;
}

export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function known(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function mult(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

function forward(today: DayKey, days: number): MoneyWindow {
  return { days, from: today, to: addDays(today, days - 1) };
}

function backward(today: DayKey, days: number): MoneyWindow {
  return { days, from: addDays(today, -days), to: addDays(today, -1) };
}

function finalAmount(considered: number, candidates: number, counted: number, sum: number): number | null {
  if (considered === 0) return null;
  if (candidates > 0 && counted === 0) return null;
  return round2(sum);
}

// ── Sales at risk (next 28 d) ────────────────────────────────────────────

export interface AtRiskBasis {
  candidates: number;
  variantsCounted: number;
  skippedNoRate: number;
  skippedNoPrice: number;
  /** Shopify's `incoming` has no arrival date in this phase. */
  incomingAssumedWithin28: true;
}

/** Σ over running_low / out: max(0, demand(28) − (onHand + incoming)) × price. */
export function salesAtRisk(variants: readonly MoneyVariant[], ctx: MoneyContext): MoneyCard<AtRiskBasis> {
  const s = ctx.settings ?? ENGINE_DEFAULTS;
  const H = s.atRiskDays;
  let considered = 0;
  let candidates = 0;
  let counted = 0;
  let skippedNoRate = 0;
  let skippedNoPrice = 0;
  let sum = 0;
  for (const v of variants) {
    if (v.isBundle) continue;
    considered++;
    if (v.status !== "running_low" && v.status !== "out") continue;
    candidates++;
    if (v.rate === null || !Number.isFinite(v.rate)) {
      skippedNoRate++;
      continue;
    }
    if (!known(v.price)) {
      skippedNoPrice++;
      continue;
    }
    const d = demand(v.rate, { seasonal: mult(v.seasonal), trend: mult(v.trend), plan: mult(v.plan) }, H);
    const stock = Math.max(0, v.onHand) + Math.max(0, v.incoming ?? 0);
    sum += Math.max(0, d - stock) * v.price;
    counted++;
  }
  return {
    amount: finalAmount(considered, candidates, counted, sum),
    basis: {
      candidates,
      variantsCounted: counted,
      skippedNoRate,
      skippedNoPrice,
      incomingAssumedWithin28: true,
      window: forward(ctx.today, H),
      currency: ctx.currency,
      costBasis: "retail",
    },
  };
}

// ── Sales lost to sell-outs (last 90 d) ─────────────────────────────────

export interface LostBasis {
  variantsCounted: number;
  skippedNoRate: number;
  skippedNoPrice: number;
  /** Σ out-of-stock days over counted variants. */
  outOfStockDays: number;
}

/** Σ out-of-stock days × rate × price, only for variants with a known rate. */
export function salesLostToSellOuts(
  variants: readonly MoneyVariant[],
  ctx: MoneyContext,
): MoneyCard<LostBasis> {
  const s = ctx.settings ?? ENGINE_DEFAULTS;
  let counted = 0;
  let skippedNoRate = 0;
  let skippedNoPrice = 0;
  let oosDays = 0;
  let sum = 0;
  for (const v of variants) {
    if (v.isBundle) continue;
    if (v.rate === null || !Number.isFinite(v.rate)) {
      skippedNoRate++;
      continue;
    }
    if (!known(v.price)) {
      skippedNoPrice++;
      continue;
    }
    const days = Math.max(0, v.outOfStockDays);
    sum += days * v.rate * v.price;
    oosDays += days;
    counted++;
  }
  return {
    amount: counted === 0 ? null : round2(sum),
    basis: {
      variantsCounted: counted,
      skippedNoRate,
      skippedNoPrice,
      outOfStockDays: oosDays,
      window: backward(ctx.today, s.historyDays),
      currency: ctx.currency,
      costBasis: "retail",
    },
  };
}

// ── Cash stuck ───────────────────────────────────────────────────────────

export interface CashStuckBasis {
  tooMuchCount: number;
  deadCount: number;
  variantsCounted: number;
  skippedNoValue: number;
  /** Variants valued at retail price because cost is unknown. */
  retailCount: number;
  coverDays: number;
}

/**
 * Σ cost × max(0, onHand − 90 × forecastRate) for too_much, plus cost × onHand
 * for dead. Unknown cost → price, and the whole card is labelled "retail".
 */
export function cashStuck(variants: readonly MoneyVariant[], ctx: MoneyContext): MoneyCard<CashStuckBasis> {
  const s = ctx.settings ?? ENGINE_DEFAULTS;
  const cover = s.cashStuckCoverDays;
  let considered = 0;
  let candidates = 0;
  let counted = 0;
  let tooMuch = 0;
  let dead = 0;
  let skipped = 0;
  let retail = 0;
  let sum = 0;
  for (const v of variants) {
    if (v.isBundle) continue;
    considered++;
    if (v.status !== "too_much" && v.status !== "dead") continue;
    candidates++;
    const unit = known(v.cost) ? v.cost : known(v.price) ? v.price : null;
    if (unit === null) {
      skipped++;
      continue;
    }
    let units: number;
    if (v.status === "dead") {
      units = Math.max(0, v.onHand);
    } else {
      if (v.rate === null || !Number.isFinite(v.rate)) {
        skipped++;
        continue;
      }
      const f = forecastRate(v.rate, { seasonal: mult(v.seasonal), trend: mult(v.trend) });
      units = Math.max(0, v.onHand - cover * f);
    }
    if (!known(v.cost)) retail++;
    if (v.status === "dead") dead++;
    else tooMuch++;
    sum += unit * units;
    counted++;
  }
  return {
    amount: finalAmount(considered, candidates, counted, sum),
    basis: {
      tooMuchCount: tooMuch,
      deadCount: dead,
      variantsCounted: counted,
      skippedNoValue: skipped,
      retailCount: retail,
      coverDays: cover,
      window: forward(ctx.today, cover),
      currency: ctx.currency,
      costBasis: retail > 0 ? "retail" : "cost",
    },
  };
}

// ── Sold-out page traffic (last 30 d) ───────────────────────────────────

export interface ProductTrafficDay {
  day: DayKey;
  /** Every variant of the product was out of stock that day. */
  fullyOutOfStock: boolean;
  /** Sessions landing on /products/<handle> that day. */
  sessions: number;
}

export interface ProductTraffic {
  productId: string;
  handle: string;
  isBundle?: boolean;
  /** One entry per day with data; a missing day is unknown and not counted. */
  days: readonly ProductTrafficDay[];
}

export interface StoreConversion {
  /** checkouts ÷ sessions; null = unknown. */
  conversionRate: number | null;
  /** Average order value; null = unknown. */
  aov: number | null;
}

export interface TrafficBasis {
  productsWithData: number;
  productsSoldOut: number;
  soldOutSessions: number;
  conversionRate: number | null;
  aov: number | null;
}

/** Σ sessions on fully-out days × store conversion rate × AOV. */
export function soldOutPageTraffic(
  products: readonly ProductTraffic[],
  store: StoreConversion,
  ctx: MoneyContext,
): MoneyCard<TrafficBasis> {
  const s = ctx.settings ?? ENGINE_DEFAULTS;
  const window = backward(ctx.today, s.soldOutTrafficDays);
  let withData = 0;
  let soldOut = 0;
  let sessions = 0;
  for (const p of products) {
    if (p.isBundle) continue;
    let any = false;
    let pSessions = 0;
    let pOut = false;
    const seen = new Set<DayKey>();
    for (const d of p.days) {
      if (d.day < window.from || d.day > window.to) continue;
      if (seen.has(d.day)) throw new Error(`engine: duplicate day ${d.day} for product ${p.productId}`);
      seen.add(d.day);
      any = true;
      if (d.fullyOutOfStock) {
        pOut = true;
        pSessions += Math.max(0, Number.isFinite(d.sessions) ? d.sessions : 0);
      }
    }
    if (any) withData++;
    if (pOut) soldOut++;
    sessions += pSessions;
  }
  const cr = typeof store.conversionRate === "number" && Number.isFinite(store.conversionRate) && store.conversionRate >= 0
    ? store.conversionRate
    : null;
  const aov = known(store.aov) ? store.aov : null;
  const amount = cr === null || aov === null || withData === 0 ? null : round2(sessions * cr * aov);
  return {
    amount,
    basis: {
      productsWithData: withData,
      productsSoldOut: soldOut,
      soldOutSessions: sessions,
      conversionRate: cr,
      aov,
      window,
      currency: ctx.currency,
      costBasis: "retail",
    },
  };
}
