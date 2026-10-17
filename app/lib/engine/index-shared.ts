/**
 * Engine entry point (spec §7.2–§7.5): re-exports plus computeVariant(), which
 * runs rate → safety/role → days left → status → order advice for one
 * variant × scope and returns the `inputs` behind every number (the "how we
 * got this" popover, spec §2.4 / §12).
 */
import { addDays, dayIndex, daysBetween, fromDayIndex, toDayKey, type DayKey } from "./dates-shared";
import {
  demand,
  forecastRate,
  orderByDate,
  orderQuantity,
  resolveLeadTime,
  safetyDays as safetyDaysOf,
  safetyStockWithLead,
  zForRole,
} from "./order-shared";
import {
  PACE_LOOKBACK_DAYS,
  earliestDataDay,
  inStockPace,
  indexSeries,
  lastSaleDay,
  salesRate,
  sigmaDaily,
  soldOutDay,
  type RateWindowResult,
  type SeriesIndex,
} from "./rate-shared";
import { variantStatus } from "./status-shared";
import { applyCap, cappedSince, spikeCap, type CappedDay } from "./outliers-shared";
import { levelShift, type LevelShift } from "./level-shift-shared";
import { errorRatio, fillSafetyFactor, normalCdf, paceVarianceFactor, structuralSigma, type ErrorRatio, type ErrorSample } from "./error-shared";
import { PLAN_LIKE_DAYS, ownWeight, type PlanLikeInput } from "./new-style-shared";
import { arrivalsFrom, coverDays, demandProjection, lostUnits, type Projection } from "./projection-shared";
import {
  resolveSettings,
  type AbcRole,
  type DailyRow,
  type EngineSettings,
  type VariantStatus,
} from "./types-shared";

export * from "./dates-shared";
export * from "./types-shared";
export * from "./rate-shared";
export * from "./order-shared";
export * from "./status-shared";
export * from "./money-shared";
export * from "./projection-shared";
export * from "./outliers-shared";
export * from "./new-style-shared";
export * from "./level-shift-shared";
export * from "./error-shared";

export interface VariantInput {
  id: string;
  /** Bundles are excluded from everything: computeVariant returns null. */
  isBundle?: boolean;
  /** Daily facts for this scope; missing days are simply absent. */
  series: readonly DailyRow[];
  /**
   * Older daily facts (before the `historyDays` window, up to 14 months back), for the in-stock
   * pace fallback only (data audit #2): a variant with too few in-stock days in the window. Rows
   * inside the window are ignored here.
   */
  olderSeries?: readonly DailyRow[] | null;
  today: DayKey;
  /** Units on hand now (may be negative when oversold). */
  onHand: number;
  incoming?: number | null;
  /** ABC role from abcRoles() over the whole shop. */
  role: AbcRole;
  /** "YYYY-MM-DD" or ISO datetime. Unknown → never "dead". */
  productCreatedAt?: string | null;
  /** Last sale from a longer history than `series`, if the caller has it. */
  lastSaleDay?: DayKey | null;
  /**
   * Oldest day the caller has data for this variant (may be older than `series`). Used as
   * the start of the no-sale period when the variant never sold, so "no sale for ≥
   * deadDays" works when deadDays exceeds the series window.
   */
  dataSinceDay?: DayKey | null;
  supplierLeadTimeDays?: number | null;
  /**
   * Standard deviation of the supplier's measured lead time (days; lib/lead-time-shared, only with
   * ≥ 3 deliveries measured). Safety stock then also covers late deliveries (safetyStockWithLead).
   */
  leadTimeSigmaDays?: number | null;
  cycleDays?: number | null;
  /** Weekly seasonal shape (season-shared seasonCurve; only when the index was applied). */
  seasonCurve?: readonly (number | null)[] | null;
  /** The dated part of `incoming` (open purchase orders). The rest arrives after one lead time. */
  arrivals?: readonly { day: DayKey; units: number }[] | null;
  /** Units sold in the coming `deadDays` days last year, weekdays aligned (null = unknown). */
  soldLastYearAhead?: number | null;
  /** "Don't reorder" (Variant.noReorder): stock and status as usual, no order advice. */
  noReorder?: boolean | null;
  /**
   * "Plan like…" (the product's forecast override): this variant's share of a reference pace,
   * blended with its own while it has fewer than PLAN_LIKE_DAYS in-stock days (new-style-shared).
   */
  planLike?: PlanLikeInput | null;
  /**
   * Older daily facts of this scope (before the `historyDays` window, up to 14 months back) for every
   * variant: the spike cap's one-off rule (outliers-shared) and the forecast-error backtest
   * (error-shared) read them. The in-stock pace fallback still reads `olderSeries` only.
   */
  history?: readonly DailyRow[] | null;
  /**
   * The forecast-error backtest's origins (error-shared errorOriginDays) with the season multiplier
   * of the P days from each (seasonal × applied trend; season-shared realisedFactor). Absent: the
   * model's error only (ρ = 1).
   */
  errorOrigins?: readonly { day: DayKey; multiplier: number }[] | null;
  /** The ABC role's pooled ratio of real to model error (error-shared rolePrior); absent: 1. */
  errorPrior?: number | null;
  /** "Don't cap" (the product's forecast override): no spike capping for this variant. */
  noCap?: boolean | null;
  /**
   * Past daily seasonal levels of the variant's season source (season-shared dailyLevels): σ is
   * measured on de-seasonalised demand and scaled by `seasonal` for the protection period.
   * Absent: σ on the raw daily sales (as before).
   */
  levels?: ReadonlyMap<DayKey, number> | null;
  /**
   * Keeps selling when out of stock (Shopify ProductVariant.inventoryPolicy CONTINUE). Absent /
   * false (DENY, Shopify's default): sales missed while sold out are lost, not owed. A negative
   * on hand counts as selling when out (evidence of backorders).
   */
  sellsWhenOut?: boolean | null;
  caseQty?: number | null;
  minOrder?: number | null;
  /** §7.3 multipliers; default 1.0. `trend` is the APPLIED trend (1 with the growth assumption off). */
  seasonal?: number | null;
  trend?: number | null;
  plan?: number | null;
  /** Catalog price/cost; when absent, derived from the series. */
  price?: number | null;
  cost?: number | null;
  settings?: Partial<EngineSettings> | null;
}

export interface VariantResult {
  id: string;
  status: VariantStatus;
  role: AbcRole;
  /** Sales per day while in stock; null when every window was dropped. */
  rate: number | null;
  /** rate × seasonal × trend. */
  forecastRate: number | null;
  sigma: number | null;
  /**
   * Days the stock ON HAND lasts at the projected daily forecast (seasonal shape, H6); 0 when
   * onHand ≤ 0; Infinity when the forecast is 0; null when no advice.
   */
  daysLeft: number | null;
  /** Days until the first stock-out counting incoming that lands in time (M2); null when no advice. */
  coverDays: number | null;
  /** The daily forecast (rate × trend × seasonal shape) behind daysLeft, cash stuck and sales at risk. */
  projection: Projection | null;
  safety: number | null;
  safetyDays: number | null;
  orderQty: number | null;
  orderBy: DayKey | null;
  // Fields the money cards need (MoneyVariant).
  onHand: number;
  incoming: number;
  seasonal: number;
  trend: number;
  plan: number;
  price: number | null;
  cost: number | null;
  inStockDays: number;
  outOfStockDays: number;
  inputs: VariantInputs;
}

/** Everything behind the numbers, for the popover and VariantMetric.inputs. */
export interface VariantInputs {
  today: DayKey;
  historyDays: number;
  dataDays: number;
  inStockDays: number;
  outOfStockDays: number;
  enoughData: boolean;
  windows: RateWindowResult[];
  seasonal: number;
  trend: number;
  plan: number;
  leadTimeDays: number;
  leadTimeSource: "supplier" | "default";
  /** σ of the supplier's measured lead time in safety stock (days); absent when not measured / not used. */
  leadSigma?: number;
  cycleDays: number;
  z: number;
  onHand: number;
  incoming: number;
  caseQty: number | null;
  minOrder: number | null;
  /**
   * The unrounded need behind orderQty: demand(leadTime + cycle) + safety − (onHand + incoming)
   * − sales missed while sold out before an order placed today arrives (lost, not owed; 0 when it
   * sells when out), before the case pack and the minimum order; null when there is no order
   * advice. The Reorder screen nets open drafts from it before rounding (review fix). Equals the
   * forward plan's need for today (forward-plan-shared needAt(0)).
   */
  orderNeed: number | null;
  /** Sells when out of stock (inventoryPolicy CONTINUE, or a negative on hand): backlog is owed. */
  sellsWhenOut: boolean;
  /**
   * Data audit #2: too few in-stock days in the window (out of stock most of it), so the pace is
   * the most recent in-stock days reaching back before it (rate-shared inStockPace): `from` the
   * earliest day used. null = the usual windows.
   */
  pace: { from: DayKey; inStockDays: number } | null;
  /**
   * One-off spikes (outliers-shared): the cap the pace and σ used (null: nothing capped — too few
   * days, or off), the days above it in the days the pace read (newest first, at most 10; `count`
   * all of them) and whether capping is off for this product ("Don't cap").
   */
  spikes: { cap: number | null; days: CappedDay[]; count: number; off: boolean };
  /** σ was measured on de-seasonalised demand and scaled by the seasonal index (levels given). */
  sigmaSeasonal: boolean;
  /**
   * B4: how safety stock was sized (error-shared): the protection days P, the model's error over
   * them, the backtest's ratio of real to model error (null: no backtest), the role's pooled ratio
   * and the ratio used (pooled with it), the error σ used (with lead-time spread), the fill target and the factor k
   * (safety = k × sigma). null with no advice or the old σ model (settings.safetyModel "sigma").
   */
  error: { horizonDays: number; model: number; sigma: number; ratio: number | null; prior: number; used: number; samples: number; windows: number; bias: number | null; fill: number; k: number } | null;
  /** B5: a confirmed sustained level change — the pace is the level since `day` (level-shift-shared). */
  levelShift: { day: DayKey; before: number; after: number; ratio: number; afterDays: number } | null;
  /**
   * "Plan like…" in use (fewer than PLAN_LIKE_DAYS in-stock days): the reference, its share of
   * this variant, the weight of the reference in the blended pace and the own in-stock days.
   */
  planLike: (PlanLikeInput & { weight: number; ownDays: number; ownRate: number | null }) | null;
  /**
   * M3: the first day of the out-of-stock spell the variant is in now (sales history: every day
   * from it through yesterday ended at ≤ 0 units; a day without data ends the search); null when
   * yesterday wasn't out. The forward plan's "Overdue since" date for a variant already out.
   */
  outSince: DayKey | null;
  lastSaleDay: DayKey | null;
  /** Start of the no-sale period when the variant never sold (oldest day with data). */
  dataSinceDay: DayKey | null;
  /** IN-STOCK days without a sale (sold-out days don't count; days before the series are assumed in stock). */
  noSaleDays: number | null;
  /** Calendar days without a sale. */
  noSaleCalendarDays: number | null;
  /** Sold in the coming `deadDays` last year (weekdays aligned): never Dead / Too much. */
  offSeason: boolean;
  soldLastYearAhead: number | null;
  /** "Don't reorder" (Variant.noReorder): no order quantity, no order-by date. */
  noReorder: boolean;
  coverDays: number | null;
  productAgeDays: number | null;
  price: number | null;
  priceSource: "input" | "series" | null;
  cost: number | null;
  costSource: "input" | "series" | null;
}

function multiplier(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Sold-weighted mean of row prices over the window; else the latest known price. */
function seriesPrice(index: SeriesIndex, today: DayKey, days: number): number | null {
  const tIdx = dayIndex(today);
  let units = 0;
  let value = 0;
  let latest: { i: number; p: number } | null = null;
  for (const [i, row] of index) {
    const p = positive(row.price);
    if (p === null) continue;
    if (!latest || i > latest.i) latest = { i, p };
    if (i >= tIdx - days && row.sold > 0) {
      units += row.sold;
      value += row.sold * p;
    }
  }
  if (units > 0) return value / units;
  return latest ? latest.p : null;
}

/** Latest known row cost. */
function seriesCost(index: SeriesIndex): number | null {
  let latest: { i: number; c: number } | null = null;
  for (const [i, row] of index) {
    const c = positive(row.cost);
    if (c !== null && (!latest || i > latest.i)) latest = { i, c };
  }
  return latest ? latest.c : null;
}

/** The day the current out-of-stock spell began (see VariantInputs.outSince). */
export function ranOutDay(index: SeriesIndex, today: DayKey): DayKey | null {
  let i = dayIndex(today) - 1;
  if (!index.get(i)?.outOfStock) return null;
  while (index.get(i - 1)?.outOfStock) i--;
  return fromDayIndex(i);
}

function earlierDay(a: DayKey | null, b: DayKey | null): DayKey | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function laterDay(a: DayKey | null, b: DayKey | null): DayKey | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** The order cycle's demand never counts fewer days than one weekly review (Order now, the Monday email). */
export const MIN_REVIEW_DAYS = 7;

/**
 * The forecast-error backtest (error-shared): at each origin, the engine's own pace as of that day
 * (spike cap, rate windows, the in-stock pace fallback, a level shift) × the season multiplier of
 * the P days from it, against what those days sold (capped at today's cap; sold-out and missing
 * days left out on both sides, a day it ran out counted at least at the pace).
 */
export function pastErrors(
  hist: ReadonlyMap<number, DailyRow>,
  today: DayKey,
  P: number,
  settings: EngineSettings,
  capOff: boolean,
  capNow: number | null,
  origins: readonly { day: DayKey; multiplier: number }[],
  levels?: ReadonlyMap<DayKey, number> | null,
): ErrorSample[] {
  const t = dayIndex(today);
  const p = Math.max(1, Math.round(P));
  const out: ErrorSample[] = [];
  for (const o of origins) {
    const oi = dayIndex(o.day);
    if (oi + p > t || !(o.multiplier >= 0) || !Number.isFinite(o.multiplier)) continue;
    const sp = spikeCap(hist, o.day, { k: settings.spikeCapK, off: capOff });
    const capped = applyCap(hist, sp.cap);
    const r = salesRate(capped, o.day, settings);
    let rate: number | null = null;
    let sigma: number | null = null;
    let vf: number | null = null;
    if (r.enoughData && r.rate !== null) {
      const sh = levels && levels.size && settings.levelShiftZ > 0 ? levelShift(capped, o.day, settings.rateWindows, levels, { z: settings.levelShiftZ }) : null;
      rate = sh ? sh.rate : r.rate;
      sigma = sigmaDaily(capped, o.day, sh ? daysBetween(sh.day, o.day) : settings.historyDays);
      vf = sh ? 1 / Math.max(1, sh.afterDays) : paceVarianceFactor(r.windows);
    } else {
      const pc = inStockPace(capped, o.day, settings);
      if (pc) {
        rate = pc.rate;
        sigma = pc.sigma;
        vf = 1 / Math.max(1, pc.inStockDays);
      }
    }
    if (rate === null || sigma === null || vf === null) continue;
    const daily = rate * o.multiplier;
    let n = 0;
    let actual = 0;
    for (let i = oi; i < oi + p; i++) {
      const row = hist.get(i);
      if (!row || soldOutDay(row)) continue;
      const sold = capNow !== null && row.sold > capNow ? capNow : row.sold;
      actual += row.partial ? Math.max(sold, daily) : sold;
      n++;
    }
    if (n < FORECAST_ERROR_MIN_SHARE * p) continue;
    const sd = Math.max(sigma * o.multiplier, Math.sqrt(Math.max(0, daily)));
    out.push({ day: o.day, forecast: daily * n, actual, model: structuralSigma(sd, n, vf) });
  }
  return out;
}

const FORECAST_ERROR_MIN_SHARE = 0.6;

/** One variant × scope. Returns null for bundles. */
export function computeVariant(input: VariantInput): VariantResult | null {
  if (input.isBundle) return null;
  const settings = resolveSettings(input.settings);
  const today = toDayKey(input.today);
  const index = indexSeries(input.series, today);

  const seasonal = multiplier(input.seasonal);
  const trend = multiplier(input.trend);
  const plan = multiplier(input.plan);
  const incoming = Math.max(0, input.incoming ?? 0);
  const onHand = input.onHand;

  // Older rows (before the window, up to 14 months) for the in-stock pace fallback (data audit #2).
  const all = new Map(index);
  if (input.olderSeries?.length) {
    const start = dayIndex(today) - settings.historyDays;
    const oldest = dayIndex(today) - PACE_LOOKBACK_DAYS;
    for (const row of input.olderSeries) {
      const i = dayIndex(row.day);
      if (i < start && i >= oldest && Number.isFinite(row.sold) && !all.has(i)) all.set(i, row);
    }
  }
  // Every older row (history) for the spike cap's one-off rule.
  const hist = new Map(all);
  if (input.history?.length) {
    const oldest = dayIndex(today) - PACE_LOOKBACK_DAYS;
    for (const row of input.history) {
      const i = dayIndex(row.day);
      if (i < dayIndex(today) && i >= oldest && Number.isFinite(row.sold) && !hist.has(i)) hist.set(i, row);
    }
  }
  // R4: one-off spikes are capped before the pace and σ are measured (outliers-shared).
  const capOff = input.noCap === true || !(settings.spikeCapK > 0);
  const spikes = spikeCap(hist, today, { k: settings.spikeCapK, off: capOff });
  const capped = applyCap(index, spikes.cap);

  // §7.2 rate and σ.
  const r = salesRate(capped, today, settings);
  // Data audit #2: out of stock most of the window → the pace of the most recent in-stock days,
  // older history included (up to 14 months), before "can't be planned yet".
  let pace: ReturnType<typeof inStockPace> = null;
  if (!r.enoughData && input.olderSeries?.length) pace = inStockPace(applyCap(all, spikes.cap), today, settings);
  // B5: a sustained change in the sales level (went viral, died) → the level since the change.
  const shift: LevelShift | null =
    !pace && r.rate !== null && r.enoughData && settings.levelShiftZ > 0 && input.levels && input.levels.size
      ? levelShift(capped, today, settings.rateWindows, input.levels, { z: settings.levelShiftZ })
      : null;
  const ownRate = pace ? pace.rate : shift ? shift.rate : r.rate;
  // σ on de-seasonalised demand, scaled to the protection period's season (R4); else the raw σ.
  // Used only when it explains part of the variation (de-seasonalised σ below the raw σ): a style
  // whose own sales don't follow its group's shape — a new collection filling up, a group whose
  // level is its product count growing — keeps the raw σ instead of one inflated by ÷ level.
  const levels = !pace && input.levels && input.levels.size ? input.levels : null;
  // After a level shift σ is measured on the days since it (the two levels are not noise).
  const sigmaDays = shift ? daysBetween(shift.day, today) : settings.historyDays;
  const rawSigma = pace ? pace.sigma : sigmaDaily(capped, today, sigmaDays);
  const dsSigma = levels && rawSigma !== null ? sigmaDaily(capped, today, sigmaDays, levels) : null;
  const sigmaSeasonal = dsSigma !== null && rawSigma !== null && dsSigma < rawSigma;
  const ownSigma = rawSigma === null ? null : sigmaSeasonal ? dsSigma! * seasonal : rawSigma;
  // "Plan like…" (R4): a new style borrows a reference pace until it has PLAN_LIKE_DAYS in-stock days.
  const ownDays = pace ? Math.max(r.inStockDays, pace.inStockDays) : r.inStockDays;
  const like = input.planLike;
  let planLike: VariantInputs["planLike"] = null;
  let rate = ownRate;
  let sigma = ownSigma;
  if (like && Number.isFinite(like.rate) && like.rate >= 0 && ownDays < PLAN_LIKE_DAYS) {
    const w = ownWeight(ownDays);
    rate = w * (ownRate ?? 0) + (1 - w) * like.rate;
    // Too few days for its own σ: the Poisson σ of the blended pace.
    sigma = ownDays >= settings.minInStockDays && ownSigma !== null ? Math.max(ownSigma, Math.sqrt(rate)) : Math.sqrt(rate);
    planLike = { ...like, weight: 1 - w, ownDays, ownRate };
  }
  const spikeDays = cappedSince(spikes.capped, today, pace ? dayIndex(today) - dayIndex(pace.from) : settings.historyDays);

  // §7.4 ordering.
  const lead = resolveLeadTime(input.supplierLeadTimeDays, settings);
  const cycle =
    typeof input.cycleDays === "number" && Number.isFinite(input.cycleDays) && input.cycleDays >= 0
      ? input.cycleDays
      : settings.cycleDays;
  const z = zForRole(input.role, settings);
  const m = { seasonal, trend, plan };
  const fRate = rate === null ? null : forecastRate(rate, m);
  const advice = (r.enoughData || pace !== null || planLike !== null) && rate !== null && sigma !== null;

  // H4 (audit 2026-10-17): periodic review — the stock must cover demand uncertainty until the
  // NEXT order lands, i.e. over lead time + order cycle (the protection period), not lead only.
  // Supplier module: + the variability of the supplier's measured lead time (σL), when measured.
  const leadSigma = typeof input.leadTimeSigmaDays === "number" && Number.isFinite(input.leadTimeSigmaDays) && input.leadTimeSigmaDays > 0 ? input.leadTimeSigmaDays : null;
  // B4: safety stock from the forecast's own error (error-shared), sized for the role's fill target.
  const P = lead.days + cycle;
  let error: VariantInputs["error"] = null;
  let safety: number | null = null;
  if (advice && settings.safetyModel === "sigma") safety = safetyStockWithLead(z, sigma!, P, fRate, leadSigma);
  else if (advice) {
    const daily = Math.max(0, fRate!);
    const sd = Math.max(sigma!, Math.sqrt(daily));
    const vf = pace ? 1 / Math.max(1, pace.inStockDays) : shift ? 1 / Math.max(1, shift.afterDays) : planLike ? 1 / Math.max(1, settings.minInStockDays) : (paceVarianceFactor(r.windows) ?? 1 / Math.max(1, r.inStockDays));
    const model = structuralSigma(sd, P, vf);
    const prior = typeof input.errorPrior === "number" && Number.isFinite(input.errorPrior) && input.errorPrior > 0 ? input.errorPrior : 1;
    const backtest: ErrorRatio = planLike || !input.errorOrigins?.length
      ? errorRatio([], P, prior)
      : errorRatio(pastErrors(hist, today, P, settings, capOff, spikes.cap, input.errorOrigins), P, prior);
    const sigmaP = model * backtest.used;
    const total = Math.sqrt(sigmaP * sigmaP + (leadSigma !== null ? daily * daily * leadSigma * leadSigma : 0));
    const fillTarget = normalCdf(z);
    const k = fillSafetyFactor(fillTarget, daily * Math.max(cycle, MIN_REVIEW_DAYS), total);
    safety = k * total;
    error = { horizonDays: P, model, sigma: total, ratio: backtest.ratio, prior, used: backtest.used, samples: backtest.samples, windows: backtest.windows, bias: backtest.bias, fill: fillTarget, k };
  }
  // In days of the FORECAST (the same daily demand days left is measured in).
  const sDays = advice ? safetyDaysOf(safety!, fRate!) : null;

  // H6: day-by-day projection with the seasonal shape over the days in question (status, days
  // left, cash stuck, sales at risk), not one rate for the next lead time + cycle.
  const projection =
    rate === null
      ? null
      : demandProjection({
          rate,
          trend,
          seasonal,
          curve: input.seasonCurve ?? null,
          horizonDays: lead.days + cycle,
          days: Math.max(settings.tooMuchDays + 1, settings.cashStuckCoverDays, settings.atRiskDays, lead.days + cycle + 1),
        });
  // Dated arrivals on their day, the rest of incoming after one lead time (the forward plan's rule).
  const arrivals = arrivalsFrom(today, incoming, input.arrivals ?? null, lead.days);
  let left: number | null;
  let cover: number | null;
  if (onHand <= 0 && !advice) {
    left = 0;
    cover = null;
  } else if (advice) {
    // Negative on hand (oversold): 0 days left; incoming fills the backlog first.
    left = onHand <= 0 ? 0 : coverDays(onHand, projection!);
    cover = coverDays(onHand, projection!, arrivals);
  } else {
    left = null;
    cover = null;
  }

  // §7.5 status inputs. Dead counts IN-STOCK days without a sale (M3): a sold-out day can't sell.
  const lastSale = laterDay(
    lastSaleDay(index),
    input.lastSaleDay ? toDayKey(input.lastSaleDay) : null,
  );
  const soldOutSince = (from: DayKey) => {
    const f = dayIndex(from);
    let n = 0;
    for (const [i, row] of index) if (i >= f && soldOutDay(row)) n++;
    return n;
  };
  let noSaleDays: number | null;
  let noSaleCalendarDays: number | null;
  if (lastSale !== null) {
    noSaleCalendarDays = Math.max(0, daysBetween(lastSale, today) - 1);
    noSaleDays = Math.max(0, noSaleCalendarDays - soldOutSince(addDays(lastSale, 1)));
  } else {
    const first = earlierDay(earliestDataDay(index), input.dataSinceDay ? toDayKey(input.dataSinceDay) : null);
    noSaleCalendarDays = first === null ? null : daysBetween(first, today);
    noSaleDays = first === null ? null : Math.max(0, noSaleCalendarDays! - soldOutSince(first));
  }
  const productAgeDays = input.productCreatedAt
    ? daysBetween(toDayKey(input.productCreatedAt), today)
    : null;
  // Off season (M3): it sold in the coming `deadDays` last year (weekdays aligned) — waiting for
  // its season, not dead: no Clear, not Too much, still planned with the seasonal shape.
  const soldAhead = typeof input.soldLastYearAhead === "number" && Number.isFinite(input.soldLastYearAhead) ? input.soldLastYearAhead : null;
  const offSeason = soldAhead !== null && soldAhead > 0;

  const status = variantStatus(
    {
      onHand,
      inStockDays: planLike ? Math.max(ownDays, settings.minInStockDays) : ownDays,
      noSaleDays,
      productAgeDays,
      daysLeft: left,
      coverDays: cover,
      leadTimeDays: lead.days,
      safetyDays: sDays ?? 0,
      trend,
      offSeason,
    },
    settings,
  );

  // Order advice only with ≥ minInStockDays in-stock days, and never for "Don't reorder" variants.
  let orderQty: number | null = null;
  let orderBy: DayKey | null = null;
  let orderNeed: number | null = null;
  const sellsWhenOut = input.sellsWhenOut === true || onHand < 0;
  if (advice && !input.noReorder) {
    const need = demand(rate!, m, lead.days + cycle);
    // Sells when out (or a negative on hand, a backlog): the order covers what is owed. Otherwise
    // the sales missed before today's order lands are lost — not ordered back (data audit #1).
    const missed = sellsWhenOut
      ? 0
      : lostUnits(onHand, plan === 1 ? projection! : { daily: projection!.daily.map((x) => x * plan), tail: projection!.tail * plan }, Math.round(lead.days), arrivals);
    orderNeed = need + safety! - (onHand + incoming) - missed;
    orderQty = orderQuantity({
      demand: need - missed,
      safety: safety!,
      onHand,
      incoming,
      caseQty: input.caseQty,
      minOrder: input.minOrder,
    });
    orderBy = orderByDate(today, cover!, lead.days, sDays!);
  }

  const inPrice = positive(input.price);
  const sPrice = inPrice === null ? seriesPrice(index, today, settings.historyDays) : null;
  const price = inPrice ?? sPrice;
  const inCost = positive(input.cost);
  const sCost = inCost === null ? seriesCost(index) : null;
  const cost = inCost ?? sCost;

  return {
    id: input.id,
    status,
    role: input.role,
    rate,
    forecastRate: fRate,
    sigma,
    daysLeft: left,
    coverDays: cover,
    projection,
    safety,
    safetyDays: sDays,
    orderQty,
    orderBy,
    onHand,
    incoming,
    seasonal,
    trend,
    plan,
    price,
    cost,
    inStockDays: r.inStockDays,
    outOfStockDays: r.outOfStockDays,
    inputs: {
      today,
      historyDays: settings.historyDays,
      dataDays: r.dataDays,
      inStockDays: r.inStockDays,
      outOfStockDays: r.outOfStockDays,
      enoughData: r.enoughData,
      windows: r.windows,
      seasonal,
      trend,
      plan,
      leadTimeDays: lead.days,
      leadTimeSource: lead.source,
      ...(leadSigma !== null ? { leadSigma } : {}),
      cycleDays: cycle,
      z,
      onHand,
      incoming,
      caseQty: input.caseQty ?? null,
      minOrder: input.minOrder ?? null,
      orderNeed,
      sellsWhenOut,
      pace: pace ? { from: pace.from, inStockDays: pace.inStockDays } : null,
      spikes: { cap: spikes.cap, days: spikeDays.slice(0, 10), count: spikeDays.length, off: capOff && input.noCap === true },
      sigmaSeasonal: sigmaSeasonal && planLike === null,
      error,
      levelShift: shift && planLike === null ? { day: shift.day, before: shift.before, after: shift.after, ratio: shift.ratio, afterDays: shift.afterDays } : null,
      planLike,
      outSince: ranOutDay(index, today),
      lastSaleDay: lastSale,
      dataSinceDay: lastSale === null ? earlierDay(earliestDataDay(index), input.dataSinceDay ? toDayKey(input.dataSinceDay) : null) : null,
      noSaleDays,
      noSaleCalendarDays,
      offSeason,
      soldLastYearAhead: soldAhead,
      noReorder: input.noReorder === true,
      coverDays: cover,
      productAgeDays,
      price,
      priceSource: inPrice !== null ? "input" : sPrice !== null ? "series" : null,
      cost,
      costSource: inCost !== null ? "input" : sCost !== null ? "series" : null,
    },
  };
}
