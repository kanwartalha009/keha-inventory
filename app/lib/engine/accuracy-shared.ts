/**
 * Forecast accuracy (spec §7.8). Pure.
 *
 * On the 1st of each month (store time zone):
 *  - snapshot: per variant with a sales rate, predicted units for the new month =
 *    rate × seasonal × trend × days in the month (seasonal for the horizon = that month), plus
 *    one store-total row (variantId "__store__") = Σ of those predictions;
 *  - grade last month: actual units per snapshotted variant (online pool view), the store row's
 *    actual = Σ of the same variants' actuals (so both sides cover the same variants), then
 *      storeErrorPct  = |predicted − actual| ÷ actual × 100 of the store row;
 *      top20ErrorPct  = mean of the same over the top 20 snapshotted variants by last month's
 *                       revenue (revenue > 0, actual > 0 — a % error of a 0 actual is undefined);
 *      graded         = how many variants that mean used.
 *    Null ("—") when there is not enough data: no snapshot, < 80 % of the month's days covered,
 *    a store actual of 0, or no variant to average.
 */
import { addDays, daysBetween, toDayKey, type DayKey } from "./dates-shared";

export const STORE_ROW = "__store__";
export const ACCURACY_TOP = 20;
export const ACCURACY_MIN_COVERAGE = 0.8;

export function monthStart(day: DayKey): DayKey {
  return `${toDayKey(day).slice(0, 7)}-01`;
}

export function nextMonthStart(month: DayKey): DayKey {
  const m = monthStart(month);
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
}

export function previousMonthStart(month: DayKey): DayKey {
  return monthStart(addDays(monthStart(month), -1));
}

export function daysInMonth(month: DayKey): number {
  return daysBetween(monthStart(month), nextMonthStart(month));
}

export function monthEnd(month: DayKey): DayKey {
  return addDays(nextMonthStart(month), -1);
}

/** Forecast units for `days` days: rate × seasonal × trend × days. Null without a rate. */
export function forecastUnits(rate: number | null, seasonal: number, trend: number, days: number): number | null {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  return rate * seasonal * trend * days;
}

export interface SnapshotInput {
  variantId: string;
  rate: number | null;
  seasonal: number;
  trend: number;
}

/** The ForecastSnapshot rows for a month; empty when no variant has a rate. */
export function snapshotRows(variants: readonly SnapshotInput[], month: DayKey): { variantId: string; predicted: number }[] {
  const days = daysInMonth(month);
  const rows: { variantId: string; predicted: number }[] = [];
  let total = 0;
  for (const v of variants) {
    if (v.variantId === STORE_ROW) continue;
    const p = forecastUnits(v.rate, v.seasonal, v.trend, days);
    if (p === null) continue;
    rows.push({ variantId: v.variantId, predicted: p });
    total += p;
  }
  if (rows.length) rows.push({ variantId: STORE_ROW, predicted: total });
  return rows;
}

/** |predicted − actual| ÷ actual × 100; null when the actual is not > 0. */
export function absPctError(predicted: number, actual: number | null): number | null {
  if (actual === null || !Number.isFinite(actual) || actual <= 0 || !Number.isFinite(predicted)) return null;
  return (Math.abs(predicted - actual) / actual) * 100;
}

export interface GradeInput {
  snapshot: readonly { variantId: string; predicted: number }[];
  /** Units sold last month per variant (online pool view). A variant missing here sold 0. */
  actualUnits: ReadonlyMap<string, number>;
  /** Gross revenue last month per variant (ranks the top 20). */
  revenue: ReadonlyMap<string, number>;
  /** Share of last month's days the sales history covers (0–1). */
  coverage: number;
}

export interface GradeResult {
  /** Actual per snapshot row (incl. the store row); empty when not enough data. */
  actual: Map<string, number>;
  storeErrorPct: number | null;
  top20ErrorPct: number | null;
  graded: number;
}

export function gradeMonth(g: GradeInput): GradeResult {
  const none: GradeResult = { actual: new Map(), storeErrorPct: null, top20ErrorPct: null, graded: 0 };
  const variants = g.snapshot.filter((r) => r.variantId !== STORE_ROW);
  const store = g.snapshot.find((r) => r.variantId === STORE_ROW);
  if (!variants.length || g.coverage < ACCURACY_MIN_COVERAGE) return none;
  const actual = new Map<string, number>();
  let storeActual = 0;
  for (const r of variants) {
    const a = Math.max(0, g.actualUnits.get(r.variantId) ?? 0);
    actual.set(r.variantId, a);
    storeActual += a;
  }
  actual.set(STORE_ROW, storeActual);
  const top = variants
    .filter((r) => (g.revenue.get(r.variantId) ?? 0) > 0)
    .sort((a, b) => (g.revenue.get(b.variantId) ?? 0) - (g.revenue.get(a.variantId) ?? 0) || (a.variantId < b.variantId ? -1 : 1))
    .slice(0, ACCURACY_TOP);
  const errors = top.map((r) => absPctError(r.predicted, actual.get(r.variantId) ?? null)).filter((e): e is number => e !== null);
  return {
    actual,
    storeErrorPct: store ? absPctError(store.predicted, storeActual) : null,
    top20ErrorPct: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    graded: errors.length,
  };
}
