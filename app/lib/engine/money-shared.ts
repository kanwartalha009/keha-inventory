/**
 * Money at stake: the 4 Home cards (spec §7.6). Store currency.
 *
 * Null rule ("—", never 0, invariant I-5): a card is null when there are no
 * usable inputs at all, or when it had candidates but none could be valued.
 * A card is 0 only when inputs are present and nothing qualifies.
 * Bundles are skipped everywhere. Rounding to 2 decimals happens at the end only.
 */
import { addDays, type DayKey } from "./dates-shared";
import { forecastRate } from "./order-shared";
import { arrivalsFrom, cumulativeDemand, flatProjection, lostUnits, type Projection } from "./projection-shared";
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
  /** Units on order (Shopify's undated incoming plus Keha's open order units). */
  incoming?: number;
  /**
   * The part of `incoming` with a known arrival day (open purchase orders). Units arriving after
   * the at-risk window are not counted against it (spec §7.6 "incoming arriving within 28 d");
   * the rest of `incoming` has no date and is assumed to arrive within the window.
   */
  incomingArrivals?: readonly { arrival: DayKey; units: number }[];
  /** Unit selling price; null/≤0 = unknown. */
  price: number | null;
  /** Unit cost; null/≤0 = unknown. */
  cost: number | null;
  /** Sold-out days WITH data over the history window (90 d). */
  outOfStockDays: number;
  /**
   * The day-by-day forecast (computeVariant: rate × trend × seasonal shape). Absent → flat at
   * rate × seasonal × trend (the old maths).
   */
  projection?: Projection | null;
  /** Lead time: undated incoming arrives after it (as the forward plan). Absent → today. */
  leadTimeDays?: number | null;
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
  /**
   * True when some incoming WITHOUT an arrival date was assumed to arrive today (no lead time
   * known). With a lead time it arrives after one lead time (as the forward order plan).
   */
  incomingAssumedWithin28: boolean;
  /** Dated units on order that arrive after the window, left out of the sum (absent on rows stored before). */
  incomingLateUnits?: number;
  /** "day_by_day": projected per day with dated arrivals (H3, 2026-10-17). Absent on rows stored before. */
  method?: "day_by_day";
}

/**
 * Units of `incoming` that count within a window of `days` days from `today` (the last day
 * counted is today + days − 1): all of it minus the dated units arriving later; never below 0.
 */
export function incomingWithin(
  incoming: number | null | undefined,
  arrivals: readonly { arrival: DayKey; units: number }[] | undefined,
  today: DayKey,
  days: number,
): { units: number; late: number } {
  const all = Math.max(0, typeof incoming === "number" && Number.isFinite(incoming) ? incoming : 0);
  const last = addDays(today, days - 1);
  let late = 0;
  for (const a of arrivals ?? []) if (a.arrival > last && a.units > 0) late += a.units;
  late = Math.min(all, late);
  return { units: all - late, late };
}

/** The projection a money card uses: the variant's own, else flat at rate × seasonal × trend. */
function projectionOf(v: Pick<MoneyVariant, "rate" | "seasonal" | "trend" | "projection">): Projection | null {
  if (v.rate === null || !Number.isFinite(v.rate)) return null;
  return v.projection ?? flatProjection(forecastRate(v.rate, { seasonal: mult(v.seasonal), trend: mult(v.trend) }));
}

/**
 * Units at risk over the next `days` days for one variant (H3): projected day by day — dated
 * incoming lands on its day, undated after one lead time (today when unknown) — and every unit
 * of forecast demand the stock can't serve counts. A negative on hand is a backlog the first
 * arrivals fill. Null without a rate.
 */
export function atRiskUnits(
  v: Pick<MoneyVariant, "rate" | "seasonal" | "trend" | "plan" | "projection" | "onHand" | "incoming" | "incomingArrivals" | "leadTimeDays">,
  today: DayKey,
  days: number,
): { units: number; late: number; undatedToday: boolean } | null {
  const p = projectionOf(v);
  if (!p) return null;
  const plan = mult(v.plan);
  const proj = plan === 1 ? p : { daily: p.daily.map((x) => x * plan), tail: p.tail * plan };
  const lead = typeof v.leadTimeDays === "number" && Number.isFinite(v.leadTimeDays) ? v.leadTimeDays : null;
  const all = Math.max(0, typeof v.incoming === "number" && Number.isFinite(v.incoming) ? v.incoming : 0);
  const dated = (v.incomingArrivals ?? []).map((a) => ({ day: a.arrival, units: a.units }));
  const arr = arrivalsFrom(today, all, dated, lead);
  const last = days - 1;
  let late = 0;
  for (const [off, u] of arr) if (off > last) late += u;
  const datedUnits = dated.reduce((a, x) => a + Math.max(0, x.units), 0);
  return { units: lostUnits(v.onHand, proj, days, arr), late, undatedToday: lead === null && all > datedUnits };
}

/** Σ over running_low / out: forecast units the stock can't serve over 28 d (atRiskUnits) × price. */
export function salesAtRisk(variants: readonly MoneyVariant[], ctx: MoneyContext): MoneyCard<AtRiskBasis> {
  const s = ctx.settings ?? ENGINE_DEFAULTS;
  const H = s.atRiskDays;
  let considered = 0;
  let candidates = 0;
  let counted = 0;
  let skippedNoRate = 0;
  let skippedNoPrice = 0;
  let lateUnits = 0;
  let assumedToday = false;
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
    const risk = atRiskUnits(v, ctx.today, H)!;
    lateUnits += risk.late;
    if (risk.undatedToday) assumedToday = true;
    sum += risk.units * v.price;
    counted++;
  }
  return {
    amount: finalAmount(considered, candidates, counted, sum),
    basis: {
      candidates,
      variantsCounted: counted,
      skippedNoRate,
      skippedNoPrice,
      incomingAssumedWithin28: assumedToday,
      incomingLateUnits: lateUnits,
      method: "day_by_day",
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
 * Units beyond `coverDays` of forecast for one variant: max(0, onHand − the projected demand
 * over the next coverDays days) (H6: the days in question, with the seasonal shape — a January
 * low no longer inflates it, pre-peak stock the peak will sell is not "stuck"). Null without a rate.
 */
export function stuckUnits(v: Pick<MoneyVariant, "rate" | "seasonal" | "trend" | "projection" | "onHand">, coverDays: number): number | null {
  const p = projectionOf(v);
  if (!p) return null;
  return Math.max(0, v.onHand - cumulativeDemand(p, coverDays));
}

/**
 * Σ cost × stuckUnits(90 days) for too_much, plus cost × onHand for dead. Unknown cost → price,
 * and the whole card is labelled "retail".
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
      const u = stuckUnits(v, cover);
      if (u === null) {
        skipped++;
        continue;
      }
      units = u;
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
