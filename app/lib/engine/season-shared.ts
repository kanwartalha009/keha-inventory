/**
 * Seasonality, trend and the plan multiplier (spec §7.3). Pure.
 *
 * Level: store, collection or product type — never per variant. A variant uses the most specific
 * (fewest products) of its collections and its product type that sold ≥ 2,000 units in the last
 * 12 months and is not a catch-all (≥ 60 % of the store: CATCH_ALL_SHARE); otherwise the store's.
 *
 * Definitions (all spans are inclusive calendar days; "today" is the store-local day):
 *  - Coverage. A day counts only when the sales history covers it (`Coverage`): inside
 *    [from, to] and not in a skipped month. A covered day with no units sold 0. A day outside
 *    coverage is MISSING: it counts in neither the units nor the day count (never a zero).
 *  - units/day over a span = Σ units on covered days ÷ covered days.
 *  - Seasonal index for a horizon of H days starting today (audit 2026-10-17, H5: copying last
 *    year's calendar dates hurt accuracy — an April Easter/promo spike was copied as ×1.38):
 *        year y (y = 1, 2) = the same WEEKDAYS 364·y days back (as the trend), so a Black Friday
 *                   or a weekend lines up with itself;
 *        LY span_y  = [today − 364y, today − 364y + H − 1], SMOOTHED: the mean, over its days, of a
 *                   centred 3-week (21-day) average of the units/day around each day, so one spike
 *                   week is spread over three;
 *        LY base_y  = the sales rate's own blend one year back: Σ wᵢ·units/day over the Nᵢ days
 *                   ending yesterday − 364y ÷ Σ wᵢ, with the rate's windows and weights
 *                   (28/56/90 d × 0.5/0.3/0.2); a window with < 80 % covered days is dropped and
 *                   the weights renormalised (as the rate drops windows), so "now" (the rate) and
 *                   "then" (the base) are the same blend of the same weeks a year apart;
 *        raw_y      = span_y ÷ base_y; raw = the mean over the usable years;
 *        index      = 1 + w × (raw − 1), SHRUNK toward 1: w = 0.5 with one usable year (one year
 *                   is one sample: half of a copied spike is noise), 1 with two; clamped 0.2–5.0.
 *    Requirements: the history starts on or before today − 13 calendar months; year 1's span and
 *    its 28-day base window have ≥ 80 % covered days; the base sold > 0. Otherwise 1.0, labelled
 *    "No seasonal data yet". H is capped at 364 days so the LY span is always in the past.
 *    The weekly shape (seasonCurve) uses the same years, base, smoothing and shrinkage.
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
  maxHorizonDays: 364,
  /** Last year = this many days back (52 weeks: weekdays aligned), × y for year y. */
  yearShiftDays: 364,
  /** Years of history the index averages (1 or 2). */
  maxYears: 2,
  /** Centred moving average around each day: ± this many days (21 days = 3 weeks). */
  smoothRadiusDays: 10,
  /** Weight of (index − 1) with only one usable year; two years → 1. */
  oneYearWeight: 0.5,
  /** The LY base blend: the sales rate's own windows and weights (types-shared ENGINE_DEFAULTS). */
  baseWindows: Object.freeze([
    { days: 28, weight: 0.5 },
    { days: 56, weight: 0.3 },
    { days: 90, weight: 0.2 },
  ]),
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
  /** The multiplier to apply: the shrunk, clamped index, or 1 when not applied. */
  value: number;
  applied: boolean;
  reason: SeasonalReason;
  /** Mean of the usable years' smoothed span ÷ base, before shrinking and clamping (null when not computable). */
  raw: number | null;
  horizonDays: number;
  /** Year 1's span (raw, unsmoothed stats; `smoothedPerDay` holds the 3-week smoothed level). */
  span: SpanStats & { smoothedPerDay: number | null };
  /** Year 1's 28-day base window (`blendedPerDay` = the rate-window blend actually used). */
  base: SpanStats & { blendedPerDay: number | null };
  /** Usable years (0–2) and the shrink weight used (0.5 for one year, 1 for two). */
  years: number;
  weight: number;
}

/** Covered-day units/day per day of [from, to] for fast windowed means (prefix sums). */
function dailyIndex(s: UnitsSeries, from: DayKey, to: DayKey) {
  const n = Math.max(0, daysBetween(from, to) + 1);
  const units = new Float64Array(n + 1);
  const days = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const day = addDays(from, i);
    const c = isCovered(s.coverage, day);
    const u = c ? s.units.get(day) : undefined;
    units[i + 1] = units[i]! + (c && typeof u === "number" && Number.isFinite(u) ? u : 0);
    days[i + 1] = days[i]! + (c ? 1 : 0);
  }
  /** Units/day over offsets [a, b] (clipped), null when no day there is covered. */
  const mean = (a: number, b: number): number | null => {
    const lo = Math.max(0, a);
    const hi = Math.min(n - 1, b);
    if (hi < lo) return null;
    const d = days[hi + 1]! - days[lo]!;
    return d > 0 ? (units[hi + 1]! - units[lo]!) / d : null;
  };
  return { n, mean };
}

/** The rate-window blend of units/day over the windows ending on `end` (null = no usable window). */
function blendedBase(s: UnitsSeries, end: DayKey): { perDay: number | null; first: SpanStats } {
  let num = 0;
  let den = 0;
  let first: SpanStats | null = null;
  for (const w of SEASON.baseWindows) {
    const st = spanStats(s, addDays(end, -(w.days - 1)), end);
    if (!first) first = st;
    if (st.coverage < SEASON.minCoverage || st.unitsPerDay === null) continue;
    num += w.weight * st.unitsPerDay;
    den += w.weight;
  }
  // The shortest (28-day) window must be usable: it is the heaviest part of the rate.
  const okFirst = first !== null && first.coverage >= SEASON.minCoverage;
  return { perDay: okFirst && den > 0 ? num / den : null, first: first! };
}

/** Smoothed (centred 3-week) units/day averaged over the days of [from, from + len − 1]. */
function smoothedSpan(s: UnitsSeries, from: DayKey, len: number): number | null {
  const R = SEASON.smoothRadiusDays;
  const idx = dailyIndex(s, addDays(from, -R), addDays(from, len - 1 + R));
  let sum = 0;
  let k = 0;
  for (let d = 0; d < len; d++) {
    const m = idx.mean(d, d + 2 * R);
    if (m === null) continue;
    sum += m;
    k++;
  }
  return k > 0 ? sum / k : null;
}

/** One year back (y = 1, 2): span coverage, smoothed span level and the blended base. */
function yearRatio(s: UnitsSeries, t: DayKey, H: number, y: number) {
  const shift = SEASON.yearShiftDays * y;
  const spanFrom = addDays(t, -shift);
  const span = spanStats(s, spanFrom, addDays(spanFrom, H - 1));
  const base = blendedBase(s, addDays(t, -1 - shift));
  const smoothed = span.coverage >= SEASON.minCoverage ? smoothedSpan(s, spanFrom, H) : null;
  const ratio = smoothed !== null && base.perDay !== null && base.perDay > 0 ? smoothed / base.perDay : null;
  return { span, base, smoothed, ratio };
}

/** 1 + w × (raw − 1), clamped to 0.2 … 5. */
export function shrinkIndex(raw: number, years: number): number {
  const w = years >= 2 ? 1 : SEASON.oneYearWeight;
  return clamp(1 + w * (raw - 1), SEASON.seasonalMin, SEASON.seasonalMax);
}

/** Seasonal index for the H days starting today (see the module header). */
export function seasonalIndex(s: UnitsSeries, today: DayKey, horizonDays: number): SeasonalResult {
  const t = toDayKey(today);
  const H = Math.max(1, Math.min(SEASON.maxHorizonDays, Math.round(Number.isFinite(horizonDays) ? horizonDays : 1)));
  const y1 = yearRatio(s, t, H, 1);
  const ys = [y1];
  for (let y = 2; y <= SEASON.maxYears; y++) ys.push(yearRatio(s, t, H, y));
  const usable = ys.filter((x) => x.ratio !== null);
  const raw = usable.length && y1.ratio !== null ? usable.reduce((a, x) => a + x.ratio!, 0) / usable.length : null;
  const out = (reason: SeasonalReason): SeasonalResult => ({
    value: reason === "ok" && raw !== null ? shrinkIndex(raw, usable.length) : 1,
    applied: reason === "ok",
    reason,
    raw: reason === "ok" ? raw : null,
    horizonDays: H,
    span: { ...y1.span, smoothedPerDay: y1.smoothed },
    base: { ...y1.base.first, blendedPerDay: y1.base.perDay },
    years: reason === "ok" ? usable.length : 0,
    weight: reason === "ok" ? (usable.length >= 2 ? 1 : SEASON.oneYearWeight) : 0,
  });
  const from = s.coverage.from;
  if (!from || from > monthsEarlier(t, SEASON.minHistoryMonths)) return out("short_history");
  if (y1.span.coverage < SEASON.minCoverage || y1.base.first.coverage < SEASON.minCoverage) return out("low_coverage");
  if (!y1.base.perDay || y1.base.perDay <= 0) return out("no_base_sales");
  if (y1.ratio === null) return out("low_coverage");
  return out("ok");
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
 * Weekly seasonal shape for the forward order plan and the status / money projections: for week
 * k starting today (days 7k … 7k+6), per usable year (as seasonalIndex: weekdays aligned, 364·y
 * days back) the centred 3-week units/day around that week ÷ that year's blended base, averaged
 * over the years and shrunk toward 1 like the index (0.5 with one year). Unclamped (the users
 * clamp), rounded to 3 decimals; a week with < 80 % covered days is null. Null when year 1's
 * base is unusable. Only used when the seasonal index was applied, with the same source (store
 * or collection) as the index, so it never introduces data the index didn't use.
 */
export function seasonCurve(s: UnitsSeries, today: DayKey, weeks: number): (number | null)[] | null {
  const t = toDayKey(today);
  const n = Math.max(1, Math.min(CURVE_MAX_WEEKS, Math.ceil(Number.isFinite(weeks) ? weeks : 1)));
  const years: { from: DayKey; base: number; idx: ReturnType<typeof dailyIndex> }[] = [];
  for (let y = 1; y <= SEASON.maxYears; y++) {
    const shift = SEASON.yearShiftDays * y;
    const base = blendedBase(s, addDays(t, -1 - shift)).perDay;
    if (base === null || !(base > 0)) {
      if (y === 1) return null;
      continue;
    }
    const from = addDays(t, -shift);
    years.push({ from, base, idx: dailyIndex(s, addDays(from, -7), addDays(from, 7 * n + 6)) });
  }
  const out: (number | null)[] = [];
  for (let k = 0; k < n; k++) {
    const ratios: number[] = [];
    for (const y of years) {
      const week = spanStats(s, addDays(y.from, 7 * k), addDays(y.from, 7 * k + 6));
      if (week.coverage < SEASON.minCoverage) continue;
      // Offsets in y.idx start 7 days before y.from: the week is [7k + 7, 7k + 13], ± 7 days.
      const m = y.idx.mean(7 * k, 7 * k + 20);
      if (m !== null) ratios.push(m / y.base);
    }
    if (!ratios.length) {
      out.push(null);
      continue;
    }
    const raw = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const w = ratios.length >= 2 ? 1 : SEASON.oneYearWeight;
    out.push(Math.round(Math.max(0, 1 + w * (raw - 1)) * 1000) / 1000);
  }
  return out;
}

/**
 * Each past day's seasonal LEVEL for de-seasonalising σ (R4, analyst item 6; rate-shared
 * sigmaDaily): the centred 3-week units/day around the day (the same smoothing as the index;
 * truncated at yesterday for the last days), divided by the mean of those levels over the
 * `days` days, so the levels average 1 over the window, then bounded to LEVEL_BOUNDS (a group
 * that sold almost nothing at the start of the window must not multiply those days' noise by
 * ten). Days the history doesn't cover get no level (σ uses the raw sales for them). Empty when
 * nothing is covered.
 */
export const LEVEL_BOUNDS = Object.freeze({ min: 0.5, max: 2 });

export function dailyLevels(s: UnitsSeries, today: DayKey, days: number): Map<DayKey, number> {
  const t = toDayKey(today);
  const n = Math.max(1, Math.round(days));
  const R = SEASON.smoothRadiusDays;
  const from = addDays(t, -n);
  const idx = dailyIndex(s, addDays(from, -R), addDays(t, -1));
  const raw: { day: DayKey; m: number }[] = [];
  for (let d = 0; d < n; d++) {
    const day = addDays(from, d);
    if (!isCovered(s.coverage, day)) continue;
    const m = idx.mean(d, d + 2 * R);
    if (m !== null && m > 0) raw.push({ day, m });
  }
  const out = new Map<DayKey, number>();
  if (!raw.length) return out;
  const mean = raw.reduce((a, x) => a + x.m, 0) / raw.length;
  if (!(mean > 0)) return out;
  for (const x of raw) out.set(x.day, Math.min(LEVEL_BOUNDS.max, Math.max(LEVEL_BOUNDS.min, x.m / mean)));
  return out;
}

// ---------------------------------------------------------------------------
// Store vs season group (collection or product type)
// ---------------------------------------------------------------------------

/**
 * A group covering this share of the store is a CATCH-ALL ("All products", "Sale", "New in",
 * "Home page"): its shape is the whole store's, blurred by everything else in it, so it is never a
 * season source. Data-driven, never by name: a group is a catch-all when its variants are ≥ 60 %
 * of the store's active tracked variants, OR its products are ≥ 60 % of the catalogue (products
 * with an active tracked variant) — whatever units it sold. Owner decision 2026-10-17. Applied to
 * product types too: a type covering most of the store is the store.
 */
export const CATCH_ALL_SHARE = 0.6;

/** Group ids of product types (collection ids are Shopify gids, so they never collide). */
export const PRODUCT_TYPE_GROUP = "type:";

/** The season group id of a product type; null when the product has none. */
export function productTypeGroupId(productType: string | null | undefined): string | null {
  return typeof productType === "string" && productType.trim() !== "" ? PRODUCT_TYPE_GROUP + productType : null;
}

/** A variant's candidate season groups: its collections, then its product type. */
export function seasonGroupsOf(v: { collections?: readonly string[] | null; productType?: string | null }): string[] {
  const out = [...new Set(v.collections ?? [])];
  const t = productTypeGroupId(v.productType);
  if (t) out.push(t);
  return out;
}

export interface SeasonGroup {
  id: string;
  kind: "collection" | "productType";
  /** Collection id, or the product type itself. */
  key: string;
  /** Units its member variants sold in the last 12 months. */
  units12m: number;
  /** Its active tracked variants, and the products they belong to. */
  variants: number;
  products: number;
  catchAll: boolean;
  /** ≥ 2,000 units in 12 months and not a catch-all: its own index may be used. */
  qualifies: boolean;
}

export interface SeasonGroupVariant {
  id: string;
  productId: string;
  collections?: readonly string[] | null;
  productType?: string | null;
  /** Active and tracked (not a bundle): counts toward the catalogue the catch-all rule compares with. */
  counted: boolean;
}

/**
 * Every collection and product type of the variants with its 12-month units (all given variants,
 * as the series are summed), its size (active tracked variants and their products) and whether it
 * is a catch-all / qualifies. `members` = the variant ids per group.
 */
export function buildSeasonGroups(
  variants: readonly SeasonGroupVariant[],
  variantUnits12m: ReadonlyMap<string, number>,
  minUnits: number = SEASON.collectionMinUnits12m,
): { groups: Map<string, SeasonGroup>; members: Map<string, string[]> } {
  const members = new Map<string, string[]>();
  const countedVariants = new Map<string, number>();
  const countedProducts = new Map<string, Set<string>>();
  let totalVariants = 0;
  const allProducts = new Set<string>();
  for (const v of variants) {
    if (v.counted) {
      totalVariants++;
      allProducts.add(v.productId);
    }
    for (const g of seasonGroupsOf(v)) {
      (members.get(g) ?? members.set(g, []).get(g)!).push(v.id);
      if (!v.counted) continue;
      countedVariants.set(g, (countedVariants.get(g) ?? 0) + 1);
      (countedProducts.get(g) ?? countedProducts.set(g, new Set()).get(g)!).add(v.productId);
    }
  }
  const groups = new Map<string, SeasonGroup>();
  for (const [id, ids] of members) {
    const units12m = ids.reduce((a, x) => a + (variantUnits12m.get(x) ?? 0), 0);
    const nv = countedVariants.get(id) ?? 0;
    const np = countedProducts.get(id)?.size ?? 0;
    const catchAll =
      (totalVariants > 0 && nv / totalVariants >= CATCH_ALL_SHARE) || (allProducts.size > 0 && np / allProducts.size >= CATCH_ALL_SHARE);
    const isType = id.startsWith(PRODUCT_TYPE_GROUP);
    groups.set(id, {
      id,
      kind: isType ? "productType" : "collection",
      key: isType ? id.slice(PRODUCT_TYPE_GROUP.length) : id,
      units12m,
      variants: nv,
      products: np,
      catchAll,
      qualifies: !catchAll && units12m >= minUnits,
    });
  }
  return { groups, members };
}

export type SeasonLevel = "store" | "collection" | "productType";

export interface SeasonSourceChoice {
  level: SeasonLevel;
  /** The season group id (collection id or "type:<product type>"); null for the store. */
  groupId: string | null;
  collectionId: string | null;
  productType: string | null;
}

function choiceOf(g: SeasonGroup | null): SeasonSourceChoice {
  if (!g) return { level: "store", groupId: null, collectionId: null, productType: null };
  return g.kind === "collection"
    ? { level: "collection", groupId: g.id, collectionId: g.key, productType: null }
    : { level: "productType", groupId: g.id, collectionId: null, productType: g.key };
}

/**
 * Which index a variant uses: among its groups (non-catch-all collections and its product type)
 * that sold ≥ 2,000 units in the last 12 months, the MOST SPECIFIC one — fewest products (then
 * fewest units, then id). None qualifies → the store.
 */
export function chooseSeasonSource(groupIds: readonly string[], groups: ReadonlyMap<string, SeasonGroup>): SeasonSourceChoice {
  return choiceOf(rankedSources(groupIds, groups)[0] ?? null);
}

/** The variant's qualifying groups, most specific first (chooseSeasonSource's order). */
function rankedSources(groupIds: readonly string[], groups: ReadonlyMap<string, SeasonGroup>): SeasonGroup[] {
  return [...new Set(groupIds)]
    .map((id) => groups.get(id))
    .filter((g): g is SeasonGroup => !!g && g.qualifies)
    .sort((a, b) => a.products - b.products || a.units12m - b.units12m || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The seasonal + trend multipliers one variant gets, with where they came from. */
export interface VariantSeason {
  seasonal: number;
  /** The APPLIED trend (1 when the growth assumption is off); trendResult.measured has the value. */
  trend: number;
  level: SeasonLevel;
  collectionId: string | null;
  productType: string | null;
  seasonalResult: SeasonalResult;
  trendResult: TrendResult;
}

const groupIdOf = (s: { level: SeasonLevel; collectionId: string | null; productType: string | null }) =>
  s.level === "collection" ? s.collectionId : s.level === "productType" ? productTypeGroupId(s.productType) : null;

/**
 * Memoised per (source, horizon). The chosen group (chooseSeasonSource) whose own index can't be
 * computed falls back to the store's (and so does its trend: both always come from one level).
 */
export function createSeasonContext(input: {
  today: DayKey;
  store: UnitsSeries;
  /** Units series per qualifying season group id (collections and product types). */
  groupSeries?: ReadonlyMap<string, UnitsSeries>;
  /** Season groups (buildSeasonGroups); empty → always the store. */
  groups?: ReadonlyMap<string, SeasonGroup>;
  /** Growth assumption (settings trendMode); default "off": trend measured, never applied. */
  trendMode?: TrendMode;
}) {
  const groupSeries = input.groupSeries ?? new Map<string, UnitsSeries>();
  const groups = input.groups ?? new Map<string, SeasonGroup>();
  const seasonalMemo = new Map<string, SeasonalResult>();
  const trendMemo = new Map<string, TrendResult>();
  const seriesOf = (id: string | null) => (id === null ? input.store : (groupSeries.get(id) ?? null));
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
  const levelMemo = new Map<string, Map<DayKey, number>>();
  return {
    /**
     * The past daily levels (dailyLevels) of the source `season` came from, for σ on
     * de-seasonalised demand; null when its seasonal index wasn't applied (no seasonality known).
     */
    levelsFor(season: VariantSeason, days: number): Map<DayKey, number> | null {
      if (!season.seasonalResult.applied) return null;
      const id = groupIdOf(season);
      const key = `${id ?? ""}|${days}`;
      let m = levelMemo.get(key);
      if (!m) {
        const s = seriesOf(id);
        levelMemo.set(key, (m = s ? dailyLevels(s, input.today, days) : new Map()));
      }
      return m.size ? m : null;
    },
    /** The weekly seasonal shape from the same source as `season` (seasonCurve); null when its index wasn't applied. */
    curveFor(season: VariantSeason, weeks: number): (number | null)[] | null {
      if (!season.seasonalResult.applied) return null;
      const id = groupIdOf(season);
      const key = `${id ?? ""}|${weeks}`;
      if (curveMemo.has(key)) return curveMemo.get(key)!;
      const s = seriesOf(id);
      const c = s ? seasonCurve(s, input.today, weeks) : null;
      curveMemo.set(key, c);
      return c;
    },
    /** `groupIds`: the variant's season groups (seasonGroupsOf: its collections and product type). */
    forVariant(groupIds: readonly string[], horizonDays: number): VariantSeason {
      const c = chooseSeasonSource(groupIds, groups);
      if (c.groupId !== null) {
        const sr = seasonal(c.groupId, horizonDays);
        const tr = trend(c.groupId);
        if (sr && tr && sr.applied) {
          return { seasonal: sr.value, trend: tr.value, level: c.level, collectionId: c.collectionId, productType: c.productType, seasonalResult: sr, trendResult: tr };
        }
      }
      const sr = seasonal(null, horizonDays)!;
      const tr = trend(null)!;
      return { seasonal: sr.value, trend: tr.value, level: "store", collectionId: null, productType: null, seasonalResult: sr, trendResult: tr };
    },
  };
}

/** Flat summary for VariantMetric.inputs (the "how we got this" popover). */
export function seasonFacts(s: VariantSeason) {
  return {
    level: s.level,
    collectionId: s.collectionId,
    productType: s.productType,
    seasonalApplied: s.seasonalResult.applied,
    seasonalReason: s.seasonalResult.reason,
    seasonalRaw: s.seasonalResult.raw,
    seasonalYears: s.seasonalResult.years,
    seasonalWeight: s.seasonalResult.weight,
    horizonDays: s.seasonalResult.horizonDays,
    lastYearSpan: { from: s.seasonalResult.span.from, to: s.seasonalResult.span.to, unitsPerDay: s.seasonalResult.span.unitsPerDay, smoothedPerDay: s.seasonalResult.span.smoothedPerDay, coverage: s.seasonalResult.span.coverage },
    lastYearBase: { from: s.seasonalResult.base.from, to: s.seasonalResult.base.to, unitsPerDay: s.seasonalResult.base.unitsPerDay, blendedPerDay: s.seasonalResult.base.blendedPerDay, coverage: s.seasonalResult.base.coverage },
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
