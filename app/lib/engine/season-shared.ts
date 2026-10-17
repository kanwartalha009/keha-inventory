/**
 * Seasonality, trend and the plan multiplier (spec §7.3). Pure.
 *
 * Level: store or collection, never per variant. A collection uses its own index when it sold
 * ≥ 2,000 units in the last 12 months; otherwise the store's is used.
 *
 * Definitions (all spans are inclusive calendar days; "today" is the store-local day):
 *  - Coverage. A day counts only when the sales history covers it (`Coverage`): inside
 *    [from, to] and not in a skipped month. A covered day with no units sold 0. A day outside
 *    coverage is MISSING: it counts in neither the units nor the day count (never a zero).
 *  - units/day over a span = Σ units on covered days ÷ covered days.
 *  - Seasonal index for a horizon of H days starting today:
 *        LY span  = the same calendar dates one year back: [today − 1y, today − 1y + H − 1]
 *        LY base  = the 28 days ending yesterday, one year back: [yesterday − 1y − 27, yesterday − 1y]
 *        index    = units/day(LY span) ÷ units/day(LY base), clamped to 0.2–5.0.
 *    BASE WINDOW CHOICE: 28 days, because (a) it is the heaviest of the sales-rate windows
 *    (rate = 0.5·rate_28 + …), so "now" and "base" describe the same weeks a year apart;
 *    (b) it matches the trend window; (c) it fits inside 13 months of history
 *    (365 + 28 = 393 days), which is the spec's history requirement. A 90-day base would need
 *    ~15 months, so seasonality could not start from a 13-month backfill.
 *    Requirements: the history starts on or before today − 13 calendar months; both spans have
 *    ≥ 80 % covered days; the base sold > 0. Otherwise 1.0, labelled "No seasonal data yet".
 *    H is capped at 365 days so the LY span is always in the past.
 *  - Trend = units/day(last 28 days) ÷ units/day(the same 28 days 364 days earlier, weekdays
 *    aligned), clamped to 0.5–2.0. Needs ≥ 80 % covered days in both windows and last year's
 *    window sold > 0; otherwise 1.0 (spec: "without last year's data: 1.0").
 *    Growth assumption (Shop.settings.trendMode, audit 2026-10-17 C4): the trend is always
 *    MEASURED (`measured`, shown on the product page), but only APPLIED (`value`) when the mode
 *    is "store". "off" (the default) → value 1, reason "off": today's sales pace already
 *    contains the growth, and multiplying by the trend again forecast ~85 % too high on a real
 *    store (WAPE 90 % vs 36 %).
 *  - Plan multiplier: keep pace = 1.0; grow X % = 1 + X/100; revenue target = target ÷ baseline
 *    forecast revenue (null when the baseline is unknown or ≤ 0).
 */
import { addDays, daysBetween, toDayKey, type DayKey } from "./dates-shared";

export const SEASON = Object.freeze({
  minHistoryMonths: 13,
  minCoverage: 0.8,
  seasonalMin: 0.2,
  seasonalMax: 5,
  baseDays: 28,
  maxHorizonDays: 365,
  trendDays: 28,
  trendShiftDays: 364,
  trendMin: 0.5,
  trendMax: 2,
  /** A collection uses its own index from this many units in the last 12 months. */
  collectionMinUnits12m: 2000,
  units12mDays: 365,
});

/** Shown when the seasonal index (or trend) is not applied. English key, translated in the UI. */
export const NO_SEASONAL_DATA = "No seasonal data yet";

/** Which days the sales history covers. `skippedMonths` are "YYYY-MM" (or a day in that month). */
export interface Coverage {
  from: DayKey | null;
  to: DayKey | null;
  skippedMonths?: readonly string[];
}

/** Units sold per day for the store or one collection. A covered day with no entry sold 0. */
export interface UnitsSeries {
  units: ReadonlyMap<DayKey, number>;
  coverage: Coverage;
}

export function isCovered(c: Coverage, day: DayKey): boolean {
  if (!c.from || !c.to || day < c.from || day > c.to) return false;
  const month = day.slice(0, 7);
  return !(c.skippedMonths ?? []).some((m) => m.slice(0, 7) === month);
}

/** Same month and day `years` years later (negative = earlier); 29 Feb → 28 Feb. */
export function shiftYears(day: DayKey, years: number): DayKey {
  const d = toDayKey(day);
  const y = Number(d.slice(0, 4)) + years;
  const m = Number(d.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dd = Math.min(Number(d.slice(8, 10)), last);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Same day of month `n` months earlier, clamped to the month's length. */
export function monthsEarlier(day: DayKey, n: number): DayKey {
  const d = toDayKey(day);
  const total = Number(d.slice(0, 4)) * 12 + (Number(d.slice(5, 7)) - 1) - n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dd = Math.min(Number(d.slice(8, 10)), last);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

export interface SpanStats {
  from: DayKey;
  to: DayKey;
  days: number;
  coveredDays: number;
  units: number;
  /** null when no day is covered. */
  unitsPerDay: number | null;
  coverage: number;
}

export function spanStats(s: UnitsSeries, from: DayKey, to: DayKey): SpanStats {
  const days = daysBetween(from, to) + 1;
  let covered = 0;
  let units = 0;
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    if (!isCovered(s.coverage, day)) continue;
    covered++;
    const u = s.units.get(day);
    if (typeof u === "number" && Number.isFinite(u)) units += u;
  }
  return {
    from,
    to,
    days,
    coveredDays: covered,
    units,
    unitsPerDay: covered > 0 ? units / covered : null,
    coverage: days > 0 ? covered / days : 0,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export type SeasonalReason = "ok" | "short_history" | "low_coverage" | "no_base_sales";

export interface SeasonalResult {
  /** The multiplier to apply: the clamped index, or 1 when not applied. */
  value: number;
  applied: boolean;
  reason: SeasonalReason;
  /** Index before clamping (null when not computable). */
  raw: number | null;
  horizonDays: number;
  span: SpanStats;
  base: SpanStats;
}

/** Seasonal index for the H days starting today (see the module header). */
export function seasonalIndex(s: UnitsSeries, today: DayKey, horizonDays: number): SeasonalResult {
  const t = toDayKey(today);
  const H = Math.max(1, Math.min(SEASON.maxHorizonDays, Math.round(Number.isFinite(horizonDays) ? horizonDays : 1)));
  const spanFrom = shiftYears(t, -1);
  const span = spanStats(s, spanFrom, addDays(spanFrom, H - 1));
  const baseTo = shiftYears(addDays(t, -1), -1);
  const base = spanStats(s, addDays(baseTo, -(SEASON.baseDays - 1)), baseTo);
  const out = (reason: SeasonalReason, raw: number | null = null): SeasonalResult => ({
    value: reason === "ok" && raw !== null ? clamp(raw, SEASON.seasonalMin, SEASON.seasonalMax) : 1,
    applied: reason === "ok",
    reason,
    raw,
    horizonDays: H,
    span,
    base,
  });
  const from = s.coverage.from;
  if (!from || from > monthsEarlier(t, SEASON.minHistoryMonths)) return out("short_history");
  if (span.coverage < SEASON.minCoverage || base.coverage < SEASON.minCoverage) return out("low_coverage");
  if (!base.unitsPerDay || base.unitsPerDay <= 0) return out("no_base_sales");
  return out("ok", (span.unitsPerDay ?? 0) / base.unitsPerDay);
}

export type TrendReason = "ok" | "off" | "low_coverage" | "no_last_year_sales";

/** Growth assumption (settings-shared TrendMode): "off" = never applied, "store" = applied. */
export type TrendMode = "off" | "store";

/** Shown next to a measured trend that is not applied (growth assumption off). English key. */
export const TREND_NOT_APPLIED = "Not applied: the growth assumption is off";

export interface TrendResult {
  /** The multiplier to apply: the clamped trend in "store" mode when computable, else 1. */
  value: number;
  applied: boolean;
  reason: TrendReason;
  raw: number | null;
  /** The clamped trend whether or not it is applied (null when not computable). */
  measured: number | null;
  mode: TrendMode;
  current: SpanStats;
  lastYear: SpanStats;
}

/**
 * Last 28 days ÷ the same 28 days 364 days earlier, clamped 0.5–2.0 (`measured`). Applied
 * (`value`) only in "store" mode; otherwise 1.0. Default "off" (settings-shared DEFAULT_SETTINGS).
 */
export function trendFactor(s: UnitsSeries, today: DayKey, mode: TrendMode = "off"): TrendResult {
  const t = toDayKey(today);
  const to = addDays(t, -1);
  const from = addDays(t, -SEASON.trendDays);
  const current = spanStats(s, from, to);
  const lastYear = spanStats(s, addDays(from, -SEASON.trendShiftDays), addDays(to, -SEASON.trendShiftDays));
  const out = (reason: TrendReason, raw: number | null = null): TrendResult => {
    const measured = raw !== null ? clamp(raw, SEASON.trendMin, SEASON.trendMax) : null;
    const applied = reason === "ok" && measured !== null && mode === "store";
    return {
      value: applied ? measured! : 1,
      applied,
      reason: reason === "ok" && !applied ? "off" : reason,
      raw,
      measured,
      mode: mode === "store" ? "store" : "off",
      current,
      lastYear,
    };
  };
  if (current.coverage < SEASON.minCoverage || lastYear.coverage < SEASON.minCoverage) return out("low_coverage");
  if (!lastYear.unitsPerDay || lastYear.unitsPerDay <= 0) return out("no_last_year_sales");
  return out("ok", (current.unitsPerDay ?? 0) / lastYear.unitsPerDay);
}

/** Longest seasonal curve kept (weeks): every week of it must lie fully in the past last year. */
export const CURVE_MAX_WEEKS = 50;

/**
 * Weekly seasonal shape for the forward order plan (forward-plan-shared): for week k starting
 * today (days 7k … 7k+6), units/day over the same calendar dates one year back ÷ units/day over
 * the seasonal index's own base (the 28 days ending yesterday, one year back). Unclamped,
 * rounded to 3 decimals; a week with < 80 % covered days is null. Null when the base itself is
 * unusable. Only used when the seasonal index was applied, with the same source (store or
 * collection) as the index, so it never introduces data the index didn't use.
 */
export function seasonCurve(s: UnitsSeries, today: DayKey, weeks: number): (number | null)[] | null {
  const t = toDayKey(today);
  const baseTo = shiftYears(addDays(t, -1), -1);
  const base = spanStats(s, addDays(baseTo, -(SEASON.baseDays - 1)), baseTo);
  if (base.coverage < SEASON.minCoverage || !base.unitsPerDay || base.unitsPerDay <= 0) return null;
  const from = shiftYears(t, -1);
  const n = Math.max(1, Math.min(CURVE_MAX_WEEKS, Math.ceil(Number.isFinite(weeks) ? weeks : 1)));
  const out: (number | null)[] = [];
  for (let k = 0; k < n; k++) {
    const w = spanStats(s, addDays(from, 7 * k), addDays(from, 7 * k + 6));
    out.push(w.coverage >= SEASON.minCoverage && w.unitsPerDay !== null ? Math.round((w.unitsPerDay / base.unitsPerDay) * 1000) / 1000 : null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store vs collection
// ---------------------------------------------------------------------------

export interface SeasonSourceChoice {
  level: "store" | "collection";
  collectionId: string | null;
}

/**
 * Which index a variant uses: among its collections that sold ≥ 2,000 units in the last 12
 * months, the MOST SPECIFIC one (fewest units; ties by id), so a catch-all "All products"
 * collection never hides a seasonal sub-collection. None qualifies → the store.
 */
export function chooseSeasonSource(
  collections: readonly string[],
  units12m: ReadonlyMap<string, number>,
  minUnits: number = SEASON.collectionMinUnits12m,
): SeasonSourceChoice {
  const ok = collections
    .map((id) => ({ id, units: units12m.get(id) ?? 0 }))
    .filter((c) => c.units >= minUnits)
    .sort((a, b) => a.units - b.units || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok.length ? { level: "collection", collectionId: ok[0].id } : { level: "store", collectionId: null };
}

/** The seasonal + trend multipliers one variant gets, with where they came from. */
export interface VariantSeason {
  seasonal: number;
  /** The APPLIED trend (1 when the growth assumption is off); trendResult.measured has the value. */
  trend: number;
  level: "store" | "collection";
  collectionId: string | null;
  seasonalResult: SeasonalResult;
  trendResult: TrendResult;
}

/**
 * Memoised per (source, horizon). A qualifying collection whose own index can't be computed
 * falls back to the store's (and so does its trend: both always come from one level).
 */
export function createSeasonContext(input: {
  today: DayKey;
  store: UnitsSeries;
  collections: ReadonlyMap<string, UnitsSeries>;
  units12m: ReadonlyMap<string, number>;
  /** Growth assumption (settings trendMode); default "off": trend measured, never applied. */
  trendMode?: TrendMode;
}) {
  const seasonalMemo = new Map<string, SeasonalResult>();
  const trendMemo = new Map<string, TrendResult>();
  const seriesOf = (id: string | null) => (id === null ? input.store : (input.collections.get(id) ?? null));
  const seasonal = (id: string | null, H: number): SeasonalResult | null => {
    const s = seriesOf(id);
    if (!s) return null;
    const key = `${id ?? ""}|${H}`;
    let r = seasonalMemo.get(key);
    if (!r) seasonalMemo.set(key, (r = seasonalIndex(s, input.today, H)));
    return r;
  };
  const trend = (id: string | null): TrendResult | null => {
    const s = seriesOf(id);
    if (!s) return null;
    const key = id ?? "";
    let r = trendMemo.get(key);
    if (!r) trendMemo.set(key, (r = trendFactor(s, input.today, input.trendMode ?? "off")));
    return r;
  };
  const curveMemo = new Map<string, (number | null)[] | null>();
  return {
    /** The weekly seasonal shape from the same source as `season` (seasonCurve); null when its index wasn't applied. */
    curveFor(season: VariantSeason, weeks: number): (number | null)[] | null {
      if (!season.seasonalResult.applied) return null;
      const key = `${season.collectionId ?? ""}|${weeks}`;
      if (curveMemo.has(key)) return curveMemo.get(key)!;
      const s = seriesOf(season.level === "collection" ? season.collectionId : null);
      const c = s ? seasonCurve(s, input.today, weeks) : null;
      curveMemo.set(key, c);
      return c;
    },
    forVariant(collections: readonly string[], horizonDays: number): VariantSeason {
      const choice = chooseSeasonSource(collections, input.units12m);
      if (choice.level === "collection") {
        const sr = seasonal(choice.collectionId, horizonDays);
        const tr = trend(choice.collectionId);
        if (sr && tr && sr.applied) {
          return { seasonal: sr.value, trend: tr.value, level: "collection", collectionId: choice.collectionId, seasonalResult: sr, trendResult: tr };
        }
      }
      const sr = seasonal(null, horizonDays)!;
      const tr = trend(null)!;
      return { seasonal: sr.value, trend: tr.value, level: "store", collectionId: null, seasonalResult: sr, trendResult: tr };
    },
  };
}

/** Flat summary for VariantMetric.inputs (the "how we got this" popover). */
export function seasonFacts(s: VariantSeason) {
  return {
    level: s.level,
    collectionId: s.collectionId,
    seasonalApplied: s.seasonalResult.applied,
    seasonalReason: s.seasonalResult.reason,
    seasonalRaw: s.seasonalResult.raw,
    horizonDays: s.seasonalResult.horizonDays,
    lastYearSpan: { from: s.seasonalResult.span.from, to: s.seasonalResult.span.to, unitsPerDay: s.seasonalResult.span.unitsPerDay, coverage: s.seasonalResult.span.coverage },
    lastYearBase: { from: s.seasonalResult.base.from, to: s.seasonalResult.base.to, unitsPerDay: s.seasonalResult.base.unitsPerDay, coverage: s.seasonalResult.base.coverage },
    trendApplied: s.trendResult.applied,
    trendReason: s.trendResult.reason,
    trendRaw: s.trendResult.raw,
    /** The measured trend (clamped), applied or not; the product page shows it with trendNote. */
    trendMeasured: s.trendResult.measured,
    trendMode: s.trendResult.mode,
    trendNote: s.trendResult.reason === "off" ? TREND_NOT_APPLIED : null,
    trendCurrentPerDay: s.trendResult.current.unitsPerDay,
    trendLastYearPerDay: s.trendResult.lastYear.unitsPerDay,
    label: s.seasonalResult.applied ? null : NO_SEASONAL_DATA,
  };
}

// ---------------------------------------------------------------------------
// Plan multiplier
// ---------------------------------------------------------------------------

export type PlanTarget =
  | { type: "keep_pace" }
  | { type: "growth"; pct: number }
  | { type: "revenue"; target: number; baselineRevenue: number | null };

/** keep pace = 1; grow X % = 1 + X/100; revenue = target ÷ baseline forecast revenue. Null = unknown. */
export function planMultiplier(t: PlanTarget): number | null {
  if (t.type === "keep_pace") return 1;
  if (t.type === "growth") {
    if (!Number.isFinite(t.pct)) return null;
    return Math.max(0, 1 + t.pct / 100);
  }
  const base = t.baselineRevenue;
  if (base === null || !Number.isFinite(base) || base <= 0 || !Number.isFinite(t.target) || t.target < 0) return null;
  return t.target / base;
}
