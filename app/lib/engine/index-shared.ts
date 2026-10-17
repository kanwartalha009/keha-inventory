/**
 * Engine entry point (spec §7.2–§7.5): re-exports plus computeVariant(), which
 * runs rate → safety/role → days left → status → order advice for one
 * variant × scope and returns the `inputs` behind every number (the "how we
 * got this" popover, spec §2.4 / §12).
 */
import { dayIndex, daysBetween, toDayKey, type DayKey } from "./dates-shared";
import {
  daysLeft as daysLeftOf,
  demand,
  forecastRate,
  orderByDate,
  orderQuantity,
  resolveLeadTime,
  safetyDays as safetyDaysOf,
  safetyStock,
  zForRole,
} from "./order-shared";
import {
  earliestDataDay,
  indexSeries,
  lastSaleDay,
  salesRate,
  sigmaDaily,
  type RateWindowResult,
  type SeriesIndex,
} from "./rate-shared";
import { variantStatus } from "./status-shared";
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

export interface VariantInput {
  id: string;
  /** Bundles are excluded from everything: computeVariant returns null. */
  isBundle?: boolean;
  /** Daily facts for this scope; missing days are simply absent. */
  series: readonly DailyRow[];
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
  cycleDays?: number | null;
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
  /** 0 when onHand ≤ 0; Infinity when the forecast rate is 0; null when no advice. */
  daysLeft: number | null;
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
  cycleDays: number;
  z: number;
  onHand: number;
  incoming: number;
  caseQty: number | null;
  minOrder: number | null;
  /**
   * The unrounded need behind orderQty: demand(leadTime + cycle) + safety − (onHand + incoming),
   * before the case pack and the minimum order; null when there is no order advice. The Reorder
   * screen nets open drafts from it before rounding (review fix).
   */
  orderNeed: number | null;
  lastSaleDay: DayKey | null;
  /** Start of the no-sale period when the variant never sold (oldest day with data). */
  dataSinceDay: DayKey | null;
  noSaleDays: number | null;
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

  // §7.2 rate and σ.
  const r = salesRate(index, today, settings);
  const sigma = sigmaDaily(index, today, settings.historyDays);

  // §7.4 ordering.
  const lead = resolveLeadTime(input.supplierLeadTimeDays, settings);
  const cycle =
    typeof input.cycleDays === "number" && Number.isFinite(input.cycleDays) && input.cycleDays >= 0
      ? input.cycleDays
      : settings.cycleDays;
  const z = zForRole(input.role, settings);
  const m = { seasonal, trend, plan };
  const fRate = r.rate === null ? null : forecastRate(r.rate, m);
  const advice = r.enoughData && r.rate !== null && sigma !== null;

  // H4 (audit 2026-10-17): periodic review — the stock must cover demand uncertainty until the
  // NEXT order lands, i.e. over lead time + order cycle (the protection period), not lead only.
  const safety = advice ? safetyStock(z, sigma!, lead.days + cycle) : null;
  // In days of the FORECAST (the same daily demand days left is measured in).
  const sDays = advice ? safetyDaysOf(safety!, fRate!) : null;
  let left: number | null;
  if (onHand <= 0) left = 0;
  else if (advice) left = daysLeftOf(onHand, fRate!);
  else left = null;

  // §7.5 status inputs.
  const lastSale = laterDay(
    lastSaleDay(index),
    input.lastSaleDay ? toDayKey(input.lastSaleDay) : null,
  );
  let noSaleDays: number | null;
  if (lastSale !== null) {
    noSaleDays = Math.max(0, daysBetween(lastSale, today) - 1);
  } else {
    const first = earlierDay(earliestDataDay(index), input.dataSinceDay ? toDayKey(input.dataSinceDay) : null);
    noSaleDays = first === null ? null : daysBetween(first, today);
  }
  const productAgeDays = input.productCreatedAt
    ? daysBetween(toDayKey(input.productCreatedAt), today)
    : null;

  const status = variantStatus(
    {
      onHand,
      inStockDays: r.inStockDays,
      noSaleDays,
      productAgeDays,
      daysLeft: left,
      leadTimeDays: lead.days,
      safetyDays: sDays ?? 0,
      trend,
    },
    settings,
  );

  // Order advice only with ≥ minInStockDays in-stock days.
  let orderQty: number | null = null;
  let orderBy: DayKey | null = null;
  let orderNeed: number | null = null;
  if (advice) {
    const need = demand(r.rate!, m, lead.days + cycle);
    orderNeed = need + safety! - (onHand + incoming);
    orderQty = orderQuantity({
      demand: need,
      safety: safety!,
      onHand,
      incoming,
      caseQty: input.caseQty,
      minOrder: input.minOrder,
    });
    orderBy = orderByDate(today, left!, lead.days, sDays!);
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
    rate: r.rate,
    forecastRate: fRate,
    sigma,
    daysLeft: left,
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
      cycleDays: cycle,
      z,
      onHand,
      incoming,
      caseQty: input.caseQty ?? null,
      minOrder: input.minOrder ?? null,
      orderNeed,
      lastSaleDay: lastSale,
      dataSinceDay: lastSale === null ? earlierDay(earliestDataDay(index), input.dataSinceDay ? toDayKey(input.dataSinceDay) : null) : null,
      noSaleDays,
      productAgeDays,
      price,
      priceSource: inPrice !== null ? "input" : sPrice !== null ? "series" : null,
      cost,
      costSource: inCost !== null ? "input" : sCost !== null ? "series" : null,
    },
  };
}
