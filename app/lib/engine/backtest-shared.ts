/**
 * Backtest harness, pure core (spec §16, Phase 0 task 0.3). No I/O: scripts/backtest.ts reads
 * the app's own database and hands the facts in here.
 *
 * For a month M, the store is replayed "as of" the first day of M+1 (so the newest fact used is
 * the last day of M — the same view compute has on that morning), and:
 *  - forecast:  every considered variant gets the real engine's sales rate (salesRate on the
 *               series buildSeries makes — the online pool, sell-out days and missing days
 *               handled exactly like compute) × seasonal × trend for a horizon of the days in
 *               M+1 (createSeasonContext, store or collection level, as accuracy's snapshot),
 *               × days in M+1 (snapshotRows / forecastUnits);
 *  - actual:    units sold in M+1 in the online pool (location view, pool keys), as accuracy's
 *               grading reads them;
 *  - errors:    gradeMonth (the app's own accuracy maths) with the top 20 ranked by revenue in
 *               MONTH M (the as-of month — no look-ahead; accuracy-shared rankingWindow, the
 *               same rule the app's accuracy job and scorecard use), plus one row per top-20
 *               variant;
 *  - money:     the 4 money-at-stake cards as of the end of M (salesAtRisk,
 *               salesLostToSellOuts, cashStuck, soldOutPageTraffic over computeVariant results).
 *
 * Honest limits (reported in `notes`, never hidden):
 *  - stock on hand as of the end of M = the pooled ending units of the newest pool stock day in
 *    the last 7 days of M; a variant with no such day is left out of the money cards;
 *  - incoming stock is not stored per day, so it is 0 in the replay (sales at risk can be
 *    higher than the app showed that day);
 *  - price, cost, suppliers, lead times and settings are today's values (no history is kept);
 *  - which variants are considered (tracked, not a bundle, ACTIVE) is today's catalog.
 * Missing data stays null ("—"), never 0.
 */
import { addDays, type DayKey } from "./dates-shared";
import {
  ACCURACY_MIN_COVERAGE,
  ACCURACY_TOP,
  STORE_ROW,
  absPctError,
  isReservedRow,
  daysInMonth,
  gradeMonth,
  monthEnd,
  nextMonthStart,
  rankingWindow,
  snapshotRows,
} from "./accuracy-shared";
import {
  abcRoles,
  cashStuck,
  computeVariant,
  indexSeries,
  resolveLeadTime,
  resolveSettings,
  salesAtRisk,
  salesLostToSellOuts,
  salesRate,
  soldOutPageTraffic,
  type DailyRow,
  type EngineSettings,
  type VariantResult,
} from "./index-shared";
import { SEASON, buildSeasonGroups, createSeasonContext, seasonGroupsOf, spanStats, type Coverage, type TrendMode, type UnitsSeries } from "./season-shared";
import {
  buildSeries,
  productTraffic,
  sessionsByHandle,
  storeConversion,
  type PooledStockDay,
  type SalesDay,
  type TrafficProduct,
} from "../compute-shared";
import { casePackFor, supplierFor, type SupplierLite } from "../supplier-shared";

/** How far back the as-of stock may be (days before the end of M). */
export const AS_OF_STOCK_MAX_AGE_DAYS = 7;
const HISTORY_DAYS = 90;
const TRAFFIC_DAYS = 30;

export interface BacktestVariant {
  id: string;
  productId: string;
  /** "Product — Variant", for the report only. */
  title: string;
  handle: string;
  vendor: string | null;
  collections: string[];
  /** Shopify product type (a season group when it sells enough); null / absent = none. */
  productType?: string | null;
  tracked: boolean;
  isBundle: boolean;
  /** ACTIVE | DRAFT | ARCHIVED (today's value). */
  status: string;
  price: number | null;
  cost: number | null;
  productCreatedAt: string | null;
  caseQty: number | null;
  supplierId: string | null;
}

export interface BacktestData {
  currency: string;
  /** Shop overrides (engineSettingsFrom(readSettings(shop.settings))). */
  settings?: Partial<EngineSettings> | null;
  /** Growth assumption (readSettings(shop.settings).trendMode); default "off", as the app. */
  trendMode?: TrendMode;
  /** Days the sales history covers (salesCoverage of the backfill state). */
  coverage: Coverage;
  variants: readonly BacktestVariant[];
  suppliers?: readonly SupplierLite[];
  /** Pool demand (compute-shared demandWhere: channel view, or the location view minus left-out locations); per variant × day. */
  poolSales: readonly SalesDay[];
  /** SalesDaily channel view (locationKey "all"): revenue (ABC, top 20) and unit price. */
  channelSales: readonly SalesDay[];
  /** StockDaily summed over the pool locations, per variant × day. */
  stock: readonly PooledStockDay[];
  /** SessionsDaily per landing path × day. */
  sessions?: readonly { landingPath: string; day: DayKey; sessions: number; checkouts: number }[];
  /** ShopDaily (orders, gross) per day. */
  shopDays?: readonly { day: DayKey; orders: number; gross: number }[];
  /** Latest pool sale (sold > 0) per variant older than the loaded facts, if the caller has it. */
  lastSaleBefore?: ReadonlyMap<string, DayKey>;
  /** Oldest pool stock day per variant, if the caller has it. */
  firstStockDay?: ReadonlyMap<string, DayKey>;
}

export interface BacktestRow {
  variantId: string;
  title: string;
  /** Gross revenue in month M (channel view). */
  revenueM: number;
  /** Forecast units for M+1; null when the variant had no sales rate ("—"). */
  predicted: number | null;
  /** Units sold in M+1 (online pool). */
  actual: number;
  /** |predicted − actual| ÷ actual × 100; null when not computable. */
  absPctError: number | null;
}

export interface BacktestMoney {
  currency: string;
  atRisk: number | null;
  lost90: number | null;
  cashStuck: number | null;
  soldOutTraffic: number | null;
  /** Variants run through the engine for the cards. */
  variantsValued: number;
  /** Considered variants with no pool stock day in the last 7 days of M (left out). */
  variantsWithoutStock: number;
}

export type BacktestStatus = "ok" | "not_gradable";
export type BacktestReason = "actuals_incomplete" | "low_coverage" | "no_forecast" | null;

export interface BacktestMonthResult {
  /** "YYYY-MM": the history month M. */
  month: string;
  /** First day of M+1: facts up to the end of M are used. */
  asOf: DayKey;
  /** "YYYY-MM": the forecast month M+1. */
  forecastMonth: string;
  status: BacktestStatus;
  reason: BacktestReason;
  /** Share of M+1's days the sales history covers (0–1). */
  forecastMonthCoverage: number;
  variantsConsidered: number;
  variantsForecast: number;
  store: { predicted: number; actual: number | null; absPctError: number | null } | null;
  top20: {
    rows: BacktestRow[];
    /** Mean abs % error over rows with an error (rows with a sale). */
    meanAbsPctError: number | null;
    /** The app's top-20 WAPE (accuracy-shared gradeMonth top20ErrorPct). */
    wapePct: number | null;
    graded: number;
    /** Of the top 20 considered variants by revenue in M, how many had no forecast. */
    topSellersWithoutForecast: number;
  };
  season: { seasonal: number; seasonalApplied: boolean; seasonalReason: string; trend: number; trendApplied: boolean };
  money: BacktestMoney;
  notes: string[];
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** "YYYY-MM" → first day; throws on a malformed month. */
export function monthFirstDay(month: string): DayKey {
  const m = MONTH_RE.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`backtest: bad month "${month}" (expected YYYY-MM)`);
  return `${month}-01`;
}

/** The `count` months ending with `last`, oldest first ("YYYY-MM"). */
export function monthsEndingWith(last: string, count: number): string[] {
  const first = monthFirstDay(last);
  if (!Number.isInteger(count) || count < 1) throw new Error(`backtest: months must be a whole number ≥ 1`);
  const y = Number(first.slice(0, 4));
  const mo = Number(first.slice(5, 7)) - 1;
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const total = y * 12 + mo - i;
    out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * The top `n` variants by revenue (revenue > 0), highest first, ties by id — the same order
 * gradeMonth uses.
 */
export function topByRevenue<T extends { variantId: string }>(rows: readonly T[], revenue: ReadonlyMap<string, number>, n: number = ACCURACY_TOP): T[] {
  return rows
    .filter((r) => (revenue.get(r.variantId) ?? 0) > 0)
    .sort((a, b) => (revenue.get(b.variantId) ?? 0) - (revenue.get(a.variantId) ?? 0) || (a.variantId < b.variantId ? -1 : 1))
    .slice(0, n);
}

/** Coverage as compute saw it on `asOf`: never past the day before. */
export function coverageAsOf(c: Coverage, asOf: DayKey): Coverage {
  const yesterday = addDays(asOf, -1);
  if (!c.from || !c.to || c.from > yesterday) return { from: null, to: null };
  return { from: c.from, to: c.to < yesterday ? c.to : yesterday, skippedMonths: c.skippedMonths };
}

const sumBy = (rows: readonly SalesDay[], from: DayKey, to: DayKey, pick: (r: SalesDay) => number) => {
  const m = new Map<string, number>();
  for (const r of rows) if (r.day >= from && r.day <= to) m.set(r.variantId, (m.get(r.variantId) ?? 0) + pick(r));
  return m;
};

/** Replays one month (see the module header). */
export function backtestMonth(data: BacktestData, month: string): BacktestMonthResult {
  const mStart = monthFirstDay(month);
  const asOf = nextMonthStart(mStart);
  const yesterday = addDays(asOf, -1);
  const fStart = asOf;
  const fEnd = monthEnd(fStart);
  const fDays = daysInMonth(fStart);
  const forecastMonth = fStart.slice(0, 7);
  const notes: string[] = [];
  const overrides = data.settings ?? null;
  const settings = resolveSettings(overrides);
  const suppliers = data.suppliers ?? [];

  const considered = data.variants.filter((v) => v.tracked && !v.isBundle && v.status === "ACTIVE");
  const nonBundle = data.variants.filter((v) => !v.isBundle);

  // ---- facts before the as-of day only (no look-ahead) ----
  const pastPool = data.poolSales.filter((s) => s.day < asOf);
  const pastStock = data.stock.filter((s) => s.day < asOf);
  const pastChannel = data.channelSales.filter((s) => s.day < asOf);
  const series = buildSeries([...pastPool], [...pastStock], [...pastChannel]);

  // ---- seasonality and trend, as season.server builds them on the as-of day ----
  const coverage = coverageAsOf(data.coverage, asOf);
  const storeUnits = new Map<string, number>();
  for (const s of pastPool) storeUnits.set(s.day, (storeUnits.get(s.day) ?? 0) + s.sold);
  const units12 = sumBy(pastPool, addDays(asOf, -SEASON.units12mDays), yesterday, (r) => r.sold);
  const { groups, members } = buildSeasonGroups(
    nonBundle.map((v) => ({ id: v.id, productId: v.productId, collections: v.collections, productType: v.productType, counted: v.tracked && v.status === "ACTIVE" })),
    units12,
  );
  const groupSeries = new Map<string, UnitsSeries>();
  const byVariantDay = new Map<string, Map<string, number>>();
  for (const s of pastPool) {
    const m = byVariantDay.get(s.variantId) ?? byVariantDay.set(s.variantId, new Map()).get(s.variantId)!;
    m.set(s.day, (m.get(s.day) ?? 0) + s.sold);
  }
  for (const g of groups.values()) {
    if (!g.qualifies) continue;
    const units = new Map<string, number>();
    for (const id of members.get(g.id) ?? []) for (const [day, n] of byVariantDay.get(id) ?? []) units.set(day, (units.get(day) ?? 0) + n);
    groupSeries.set(g.id, { units, coverage });
  }
  const season = createSeasonContext({ today: asOf, store: { units: storeUnits, coverage }, groupSeries, groups, trendMode: data.trendMode ?? "off" });
  const storeSeason = season.forVariant([], fDays);

  // ---- forecast for M+1 (accuracy's snapshot) ----
  const snapshot = snapshotRows(
    considered.map((v) => {
      const r = salesRate(indexSeries(series.get(v.id) ?? [], asOf), asOf, settings);
      const s = season.forVariant(seasonGroupsOf(v), fDays);
      return { variantId: v.id, rate: r.rate, seasonal: s.seasonal, trend: s.trend };
    }),
    fStart,
  );
  const predicted = new Map(snapshot.map((r) => [r.variantId, r.predicted]));

  // ---- actuals and grading ----
  const fCoverage = spanStats({ units: new Map(), coverage: data.coverage }, fStart, fEnd).coverage;
  const actualUnits = sumBy(data.poolSales, fStart, fEnd, (r) => r.sold);
  // Top-20 ranking: revenue in the month before the graded month — the app's rule (rankingWindow).
  const rank = rankingWindow(fStart);
  const revenueM = sumBy(data.channelSales, rank.from, rank.to, (r) => r.gross);
  let reason: BacktestReason = null;
  if (!snapshot.length) reason = "no_forecast";
  else if (!data.coverage.to || data.coverage.to < fEnd) reason = "actuals_incomplete";
  else if (fCoverage < ACCURACY_MIN_COVERAGE) reason = "low_coverage";
  const g = reason ? null : gradeMonth({ snapshot, actualUnits, revenue: revenueM, coverage: fCoverage });

  const titleOf = new Map(data.variants.map((v) => [v.id, v.title]));
  const forecastRows = snapshot.filter((r) => !isReservedRow(r.variantId));
  const rows: BacktestRow[] = g
    ? topByRevenue(forecastRows, revenueM).map((r) => {
        const actual = g.actual.get(r.variantId) ?? 0;
        return {
          variantId: r.variantId,
          title: titleOf.get(r.variantId) ?? r.variantId,
          revenueM: revenueM.get(r.variantId) ?? 0,
          predicted: r.predicted,
          actual,
          absPctError: absPctError(r.predicted, actual),
        };
      })
    : [];
  const topConsidered = topByRevenue(
    considered.map((v) => ({ variantId: v.id })),
    revenueM,
  );
  const topSellersWithoutForecast = topConsidered.filter((r) => !predicted.has(r.variantId)).length;
  if (topSellersWithoutForecast > 0)
    notes.push(`${topSellersWithoutForecast} of the top ${ACCURACY_TOP} variants by revenue in ${month} had no sales rate, so no forecast (not graded).`);

  const storePredicted = predicted.get(STORE_ROW);
  const storeActual = g ? (g.actual.get(STORE_ROW) ?? null) : null;

  // ---- money at stake as of the end of M ----
  const money = moneyAsOf(data, { asOf, considered, series, overrides, settings, suppliers, seasonCtx: season });
  if (money.variantsWithoutStock > 0)
    notes.push(`${money.variantsWithoutStock} considered variant(s) had no pool stock day in the last ${AS_OF_STOCK_MAX_AGE_DAYS} days of ${month}: left out of the money cards.`);
  notes.push("Incoming stock is not stored per day: 0 in the replay, so sales at risk can be higher than the app showed.");
  notes.push("Price, cost, suppliers, lead times, settings and the product list are today's values.");

  return {
    month,
    asOf,
    forecastMonth,
    status: reason ? "not_gradable" : "ok",
    reason,
    forecastMonthCoverage: fCoverage,
    variantsConsidered: considered.length,
    variantsForecast: forecastRows.length,
    store:
      storePredicted === undefined
        ? null
        : { predicted: storePredicted, actual: storeActual, absPctError: g ? g.storeErrorPct : null },
    top20: {
      rows,
      // The mean of the rows' % errors (rows with a sale), as this report always showed it…
      meanAbsPctError: g ? meanOf(rows.map((x) => x.absPctError)) : null,
      // …and the app's own top-20 figure since M7 (WAPE: Σ|F − A| ÷ ΣA, zero actuals included).
      wapePct: g ? g.top20ErrorPct : null,
      graded: g ? rows.filter((x) => x.absPctError !== null).length : 0,
      topSellersWithoutForecast,
    },
    season: {
      seasonal: storeSeason.seasonal,
      seasonalApplied: storeSeason.seasonalResult.applied,
      seasonalReason: storeSeason.seasonalResult.reason,
      trend: storeSeason.trend,
      trendApplied: storeSeason.trendResult.applied,
    },
    money,
    notes,
  };
}

function moneyAsOf(
  data: BacktestData,
  x: {
    asOf: DayKey;
    considered: readonly BacktestVariant[];
    series: Map<string, DailyRow[]>;
    overrides: Partial<EngineSettings> | null;
    settings: EngineSettings;
    suppliers: readonly SupplierLite[];
    seasonCtx: ReturnType<typeof createSeasonContext>;
  },
): BacktestMoney {
  const { asOf, settings } = x;
  const yesterday = addDays(asOf, -1);
  const oldestStock = addDays(asOf, -AS_OF_STOCK_MAX_AGE_DAYS);
  // Newest pool stock day in the last 7 days of M → on hand at the end of M.
  const onHandAsOf = new Map<string, { day: DayKey; units: number }>();
  for (const s of data.stock) {
    if (s.day < oldestStock || s.day > yesterday) continue;
    const cur = onHandAsOf.get(s.variantId);
    if (!cur || s.day > cur.day) onHandAsOf.set(s.variantId, { day: s.day, units: s.endUnits });
  }
  const lastSale = new Map<string, DayKey>();
  for (const [id, d] of data.lastSaleBefore ?? []) if (d < asOf) lastSale.set(id, d);
  for (const s of data.poolSales) {
    if (s.day >= asOf || s.sold <= 0) continue;
    const cur = lastSale.get(s.variantId);
    if (!cur || s.day > cur) lastSale.set(s.variantId, s.day);
  }
  const dataSince = new Map<string, DayKey>();
  for (const [id, d] of data.firstStockDay ?? []) if (d < asOf) dataSince.set(id, d);
  for (const s of data.stock) {
    if (s.day >= asOf) continue;
    const cur = dataSince.get(s.variantId);
    if (!cur || s.day < cur) dataSince.set(s.variantId, s.day);
  }
  const revenue90 = sumBy(data.channelSales, addDays(asOf, -HISTORY_DAYS), yesterday, (r) => r.gross);
  const roles = abcRoles(
    x.considered.map((v) => ({ id: v.id, revenue90: revenue90.get(v.id) ?? 0 })),
    settings,
  );
  const results: VariantResult[] = [];
  let withoutStock = 0;
  for (const v of x.considered) {
    const stockAt = onHandAsOf.get(v.id);
    if (!stockAt) {
      withoutStock++;
      continue;
    }
    const supplier = supplierFor(v, x.suppliers);
    const lead = resolveLeadTime(supplier?.leadTimeDays ?? null, settings);
    const s = x.seasonCtx.forVariant(seasonGroupsOf(v), lead.days + settings.cycleDays);
    const r = computeVariant({
      id: v.id,
      isBundle: false,
      series: x.series.get(v.id) ?? [],
      today: asOf,
      onHand: stockAt.units,
      incoming: 0,
      role: roles.get(v.id) ?? "C",
      productCreatedAt: v.productCreatedAt,
      lastSaleDay: lastSale.get(v.id) ?? null,
      dataSinceDay: dataSince.get(v.id) ?? null,
      supplierLeadTimeDays: supplier?.leadTimeDays ?? null,
      caseQty: casePackFor(v.caseQty, supplier),
      minOrder: supplier?.minOrder ?? null,
      seasonal: s.seasonal,
      trend: s.trend,
      plan: 1,
      price: v.price,
      cost: v.cost,
      settings: x.overrides,
    });
    if (r) results.push(r);
  }

  const ctx = { today: asOf, currency: data.currency, settings };
  const trafficFrom = addDays(asOf, -TRAFFIC_DAYS);
  const landing = (data.sessions ?? []).filter((l) => l.day >= trafficFrom && l.day <= yesterday);
  const totals = { sessions: 0, checkouts: 0, orders: 0, gross: 0 };
  for (const l of landing) {
    totals.sessions += l.sessions;
    totals.checkouts += l.checkouts;
  }
  for (const d of data.shopDays ?? []) {
    if (d.day < trafficFrom || d.day > yesterday) continue;
    totals.orders += d.orders;
    totals.gross += d.gross;
  }
  const products = new Map<string, TrafficProduct>();
  for (const v of x.considered) {
    const p = products.get(v.productId) ?? { productId: v.productId, handle: v.handle, variantIds: [] };
    p.variantIds.push(v.id);
    products.set(v.productId, p);
  }
  const traffic = soldOutPageTraffic(
    productTraffic([...products.values()], x.series, sessionsByHandle([...landing]), trafficFrom, yesterday),
    storeConversion(totals),
    ctx,
  );
  return {
    currency: data.currency,
    atRisk: salesAtRisk(results, ctx).amount,
    lost90: salesLostToSellOuts(results, ctx).amount,
    cashStuck: cashStuck(results, ctx).amount,
    soldOutTraffic: traffic.amount,
    variantsValued: results.length,
    variantsWithoutStock: withoutStock,
  };
}

/** Mean of the non-null values; null when there is none. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface BacktestSummary {
  months: number;
  gradedMonths: number;
  /** Mean of the graded months' top-20 errors. */
  top20MeanAbsPctError: number | null;
  /** Mean of the graded months' store-total errors. */
  storeMeanAbsPctError: number | null;
}

export function summarize(results: readonly BacktestMonthResult[]): BacktestSummary {
  const graded = results.filter((r) => r.status === "ok");
  return {
    months: results.length,
    gradedMonths: graded.length,
    top20MeanAbsPctError: meanOf(graded.map((r) => r.top20.meanAbsPctError)),
    storeMeanAbsPctError: meanOf(graded.map((r) => r.store?.absPctError ?? null)),
  };
}
