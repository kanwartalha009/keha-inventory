/**
 * Forecast accuracy (spec §7.8; audit 2026-10-17 M7). Pure.
 *
 * On the 1st of each month (store time zone):
 *  - snapshot: per variant with a sales rate, predicted units for the new month =
 *    rate × seasonal × trend × days in the month (seasonal for the horizon = that month), plus
 *    one store-total row (variantId "__store__") = Σ of those predictions, plus the NAIVE
 *    baseline per variant ("__naive__:<variantId>"): its last-28-day in-stock rate × days — what
 *    a merchant gets by assuming "the next month sells like the last four weeks";
 *  - grade last month, with stock-out days excluded the same way on both sides: each variant's
 *    forecasts are scaled to the share of the month it was IN STOCK (a sold-out day — ended at
 *    ≤ 0 units AND sold nothing — can't sell, so its demand isn't graded; "__instock__:<id>"
 *    rows keep the share), against units actually sold (the pool's demand view):
 *      store   WAPE = |ΣF − ΣA| ÷ ΣA × 100 and bias = (ΣF − ΣA) ÷ ΣA × 100 over the snapshotted
 *              variants (storeErrorPct = the engine's store WAPE);
 *      top 20  WAPE = Σ|F − A| ÷ ΣA × 100 and bias = Σ(F − A) ÷ ΣA × 100 over the top 20
 *              snapshotted variants by revenue in the month BEFORE the graded month
 *              (`rankingWindow`: known when the snapshot is taken — no look-ahead). Variants that
 *              sold nothing are graded too (WAPE never drops a zero actual); top20ErrorPct = the
 *              engine's top-20 WAPE, `graded` = how many variants it covered;
 *      naive   the same two numbers for the naive baseline, side by side (over the variants that
 *              have a naive forecast).
 *    Null ("—") when there is not enough data: no snapshot, < 80 % of the month's days covered,
 *    nothing sold.
 */
import { addDays, daysBetween, toDayKey, type DayKey } from "./dates-shared";

export const STORE_ROW = "__store__";
/** Reserved ForecastSnapshot rows (no real variant id starts with "__"). */
export const NAIVE_PREFIX = "__naive__:";
export const INSTOCK_PREFIX = "__instock__:";
export const isReservedRow = (variantId: string) => variantId.startsWith("__");
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

/**
 * The days whose revenue ranks a graded month's top 20 (review fix, one rule everywhere —
 * accuracy, the scorecard and the backtest): the whole month BEFORE the graded month, which is
 * known when the snapshot is taken on the graded month's first days.
 */
export function rankingWindow(gradedMonth: DayKey): { from: DayKey; to: DayKey } {
  const from = previousMonthStart(gradedMonth);
  return { from, to: monthEnd(from) };
}

/** Days into the month on which a missing snapshot is still taken (the first run of days 1–3). */
export const SNAPSHOT_LATE_DAYS = 3;

/** Is the snapshot for today's month still due by date? Day 1…SNAPSHOT_LATE_DAYS of the month. */
export function snapshotDue(today: DayKey): boolean {
  const day = Number(toDayKey(today).slice(8, 10));
  return day >= 1 && day <= SNAPSHOT_LATE_DAYS;
}

/**
 * Snapshotted months to grade now (review fix: none is skipped): every month before today's
 * month with a snapshot and no grade yet whose sales history is complete (`coverageTo` ≥ the
 * month's last day), oldest first.
 */
export function monthsToGrade(
  snapshotMonths: readonly DayKey[],
  gradedMonths: readonly DayKey[],
  today: DayKey,
  coverageTo: DayKey | null,
): { due: DayKey[]; waiting: DayKey[] } {
  const current = monthStart(today);
  const graded = new Set(gradedMonths.map(monthStart));
  const due: DayKey[] = [];
  const waiting: DayKey[] = [];
  for (const m of [...new Set(snapshotMonths.map(monthStart))].sort()) {
    if (m >= current || graded.has(m)) continue;
    if (coverageTo && coverageTo >= monthEnd(m)) due.push(m);
    else waiting.push(m);
  }
  return { due, waiting };
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
  /** Last-28-day in-stock rate (VariantMetric.inputs.windows, 28 days) for the naive baseline. */
  naiveRate?: number | null;
}

/** The ForecastSnapshot rows for a month (engine, store total, naive); empty when no variant has a rate. */
export function snapshotRows(variants: readonly SnapshotInput[], month: DayKey): { variantId: string; predicted: number }[] {
  const days = daysInMonth(month);
  const rows: { variantId: string; predicted: number }[] = [];
  const naive: { variantId: string; predicted: number }[] = [];
  let total = 0;
  for (const v of variants) {
    if (isReservedRow(v.variantId)) continue;
    const p = forecastUnits(v.rate, v.seasonal, v.trend, days);
    if (p === null) continue;
    rows.push({ variantId: v.variantId, predicted: p });
    total += p;
    const n = forecastUnits(v.naiveRate ?? null, 1, 1, days);
    if (n !== null) naive.push({ variantId: NAIVE_PREFIX + v.variantId, predicted: n });
  }
  if (rows.length) rows.push({ variantId: STORE_ROW, predicted: total });
  return [...rows, ...naive];
}

/** |predicted − actual| ÷ actual × 100; null when the actual is not > 0. */
export function absPctError(predicted: number, actual: number | null): number | null {
  if (actual === null || !Number.isFinite(actual) || actual <= 0 || !Number.isFinite(predicted)) return null;
  return (Math.abs(predicted - actual) / actual) * 100;
}

/** One error figure: WAPE and bias in %, over `n` variants; null when nothing sold. */
export interface Score {
  wapePct: number | null;
  biasPct: number | null;
  n: number;
  forecast: number;
  actual: number;
}

export interface MonthScore {
  store: { engine: Score; naive: Score };
  top20: { engine: Score; naive: Score };
}

function score(pairs: readonly { f: number; a: number }[], level: "store" | "items"): Score {
  let F = 0;
  let A = 0;
  let abs = 0;
  for (const p of pairs) {
    F += p.f;
    A += p.a;
    abs += Math.abs(p.f - p.a);
  }
  const ok = A > 0 && pairs.length > 0;
  const err = level === "store" ? Math.abs(F - A) : abs;
  return { wapePct: ok ? (err / A) * 100 : null, biasPct: ok ? ((F - A) / A) * 100 : null, n: pairs.length, forecast: F, actual: A };
}

export interface GradeInput {
  /** The month's ForecastSnapshot rows (engine, store, naive; in-stock rows are ignored). */
  snapshot: readonly { variantId: string; predicted: number }[];
  /** Units sold last month per variant (the pool's demand view). A variant missing here sold 0. */
  actualUnits: ReadonlyMap<string, number>;
  /** Gross revenue per variant over rankingWindow(graded month) (ranks the top 20). */
  revenue: ReadonlyMap<string, number>;
  /** Share of last month's days the sales history covers (0–1). */
  coverage: number;
  /** Share of the month each variant was in stock (0–1; absent = 1: unknown, not adjusted). */
  inStockShare?: ReadonlyMap<string, number>;
}

export interface GradeResult {
  /** Actual per snapshot row (incl. the store and naive rows); empty when not enough data. */
  actual: Map<string, number>;
  /** The engine's store WAPE (|ΣF − ΣA| ÷ ΣA × 100). */
  storeErrorPct: number | null;
  /** The engine's top-20 WAPE (Σ|F − A| ÷ ΣA × 100), zero actuals included. */
  top20ErrorPct: number | null;
  graded: number;
  /** Every figure, engine and naive side by side (null when not enough data). */
  score: MonthScore | null;
  /** In-stock share per graded variant (the "__instock__:" rows to keep). */
  shares: Map<string, number>;
}

/** The variants that rank the top 20 (revenue > 0, by revenue desc, ties by id). */
export function topVariants<T extends { variantId: string }>(rows: readonly T[], revenue: ReadonlyMap<string, number>): T[] {
  return rows
    .filter((r) => !isReservedRow(r.variantId) && (revenue.get(r.variantId) ?? 0) > 0)
    .sort((a, b) => (revenue.get(b.variantId) ?? 0) - (revenue.get(a.variantId) ?? 0) || (a.variantId < b.variantId ? -1 : 1))
    .slice(0, ACCURACY_TOP);
}

const clamp01 = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1);

/**
 * Every figure for a graded month from its rows (see the module header). Shared by grading and
 * the scorecard so both always agree.
 */
export function scoreMonth(
  snapshot: readonly { variantId: string; predicted: number }[],
  actualOf: (variantId: string) => number,
  revenue: ReadonlyMap<string, number>,
  shareOf: (variantId: string) => number,
): MonthScore {
  const variants = snapshot.filter((r) => !isReservedRow(r.variantId));
  const naive = new Map(snapshot.filter((r) => r.variantId.startsWith(NAIVE_PREFIX)).map((r) => [r.variantId.slice(NAIVE_PREFIX.length), r.predicted]));
  const pair = (r: { variantId: string; predicted: number }) => ({ f: r.predicted * shareOf(r.variantId), a: actualOf(r.variantId) });
  const naivePair = (r: { variantId: string }) => ({ f: naive.get(r.variantId)! * shareOf(r.variantId), a: actualOf(r.variantId) });
  const top = topVariants(variants, revenue);
  return {
    store: { engine: score(variants.map(pair), "store"), naive: score(variants.filter((r) => naive.has(r.variantId)).map(naivePair), "store") },
    top20: { engine: score(top.map(pair), "items"), naive: score(top.filter((r) => naive.has(r.variantId)).map(naivePair), "items") },
  };
}

export function gradeMonth(g: GradeInput): GradeResult {
  const none: GradeResult = { actual: new Map(), storeErrorPct: null, top20ErrorPct: null, graded: 0, score: null, shares: new Map() };
  const variants = g.snapshot.filter((r) => !isReservedRow(r.variantId));
  const store = g.snapshot.find((r) => r.variantId === STORE_ROW);
  if (!variants.length || g.coverage < ACCURACY_MIN_COVERAGE) return none;
  const actual = new Map<string, number>();
  const shares = new Map<string, number>();
  let storeActual = 0;
  for (const r of variants) {
    const a = Math.max(0, g.actualUnits.get(r.variantId) ?? 0);
    actual.set(r.variantId, a);
    storeActual += a;
    if (g.inStockShare?.has(r.variantId)) shares.set(r.variantId, clamp01(g.inStockShare.get(r.variantId)));
  }
  actual.set(STORE_ROW, storeActual);
  for (const r of g.snapshot) if (r.variantId.startsWith(NAIVE_PREFIX)) actual.set(r.variantId, actual.get(r.variantId.slice(NAIVE_PREFIX.length)) ?? 0);
  const sc = scoreMonth(g.snapshot, (id) => actual.get(id) ?? 0, g.revenue, (id) => shares.get(id) ?? 1);
  return {
    actual,
    storeErrorPct: store ? sc.store.engine.wapePct : null,
    top20ErrorPct: sc.top20.engine.wapePct,
    graded: sc.top20.engine.wapePct === null ? 0 : sc.top20.engine.n,
    score: sc,
    shares,
  };
}

/**
 * In-stock share of a month for one variant from its daily rows: (days with data − sold-out
 * days) ÷ days with data; null when no day has data (then nothing is adjusted).
 */
export function inStockShareOf(days: readonly { outOfStock: boolean; sold: number }[]): number | null {
  if (!days.length) return null;
  const soldOut = days.filter((d) => d.outOfStock && !(d.sold > 0)).length;
  return (days.length - soldOut) / days.length;
}

/** The month's score back from its stored rows (scorecard): in-stock shares from the "__instock__:" rows. */
export function scoreFromRows(
  rows: readonly { variantId: string; predicted: number; actual: number | null }[],
  revenue: ReadonlyMap<string, number>,
): MonthScore {
  const actual = new Map(rows.map((r) => [r.variantId, r.actual ?? 0]));
  const share = new Map(rows.filter((r) => r.variantId.startsWith(INSTOCK_PREFIX)).map((r) => [r.variantId.slice(INSTOCK_PREFIX.length), clamp01(r.predicted)]));
  return scoreMonth(rows, (id) => actual.get(id) ?? 0, revenue, (id) => share.get(id) ?? 1);
}
