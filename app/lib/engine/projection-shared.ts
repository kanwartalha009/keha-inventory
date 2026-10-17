/**
 * Day-by-day demand projection (audit 2026-10-17: H6 status horizon, H3 sales at risk, M2
 * running low with incoming, negative positions). Pure.
 *
 * The nightly numbers used to divide stock by ONE forecast rate — rate × the seasonal index
 * for lead time + cycle. In January (index 0.4) that made every product look like a year of
 * stock ("Too much"); before a peak (index high now, low after) real overstock hid. Here demand
 * is projected day by day with the seasonal SHAPE, the same one the forward order plan uses:
 *   c(d) = rate × trend × S(d),  S = forward-plan-shared seasonalFactors(index, weekly curve, H):
 *   the weekly curve scaled so its mean over the order horizon H equals the stored index, so
 *   over the first H days the projection sells exactly what the order quantity assumes. Days
 *   past the curve use the curve's own mean (≈ a normal week of the year), not the index for
 *   the next few weeks. No curve → flat at the index (the old maths, exactly).
 *
 * On-hand may be negative (oversold / continue selling): a negative start is a backlog that
 * incoming stock fills first. Nothing here returns NaN.
 */
import { seasonalFactors } from "./forward-plan-shared";
import { addDays, daysBetween, toDayKey, type DayKey } from "./dates-shared";

export interface Projection {
  /** Forecast units per day for days 0 … daily.length − 1 (day 0 = today). */
  daily: number[];
  /** Units per day after the array (flat). */
  tail: number;
}

/** Arrivals by day offset from today (offset ≥ 0; overdue arrivals land today). */
export type Arrivals = ReadonlyMap<number, number>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * c(d) for d = 0 … days − 1 (see the header). `rate` and `trend` ≥ 0; `seasonal` is the stored
 * index for the horizon `horizonDays`; `curve` its weekly shape (season-shared seasonCurve).
 */
export function demandProjection(x: {
  rate: number;
  trend: number;
  seasonal: number;
  curve?: readonly (number | null)[] | null;
  horizonDays: number;
  days: number;
}): Projection {
  const base = Math.max(0, finite(x.rate) ? x.rate : 0) * (finite(x.trend) && x.trend > 0 ? x.trend : 1);
  const len = Math.max(1, Math.floor(finite(x.days) ? x.days : 1));
  const level = finite(x.seasonal) && x.seasonal > 0 ? x.seasonal : 1;
  const S = seasonalFactors(level, x.curve ?? null, Math.max(1, Math.round(x.horizonDays)), len, 0);
  const span = x.curve && x.curve.some(finite) ? Math.min(len, x.curve.length * 7) : 0;
  let tailFactor = level;
  if (span > 0) {
    let sum = 0;
    for (let d = 0; d < span; d++) sum += S[d]!;
    tailFactor = sum / span;
    for (let d = span; d < len; d++) S[d] = tailFactor;
  }
  return { daily: S.map((f) => base * f), tail: base * tailFactor };
}

/** A flat projection (no seasonal shape): `perDay` every day. */
export function flatProjection(perDay: number, days = 1): Projection {
  const p = Math.max(0, finite(perDay) ? perDay : 0);
  return { daily: new Array<number>(Math.max(1, days)).fill(p), tail: p };
}

const demandOn = (p: Projection, d: number) => (d < p.daily.length ? p.daily[d]! : p.tail);

/** Forecast units over days 0 … days − 1. */
export function cumulativeDemand(p: Projection, days: number): number {
  const n = Math.max(0, finite(days) ? days : 0);
  const whole = Math.floor(n);
  let sum = 0;
  for (let d = 0; d < Math.min(whole, p.daily.length); d++) sum += p.daily[d]!;
  if (whole > p.daily.length) sum += (whole - p.daily.length) * p.tail;
  if (n > whole) sum += (n - whole) * demandOn(p, whole);
  return sum;
}

/**
 * Days until the stock runs out (fractional; 0 when it starts at ≤ 0 with nothing arriving
 * today; Infinity when the forecast is 0 for good). Arrivals land at the START of their day.
 * The first day the stock can't cover that day's demand ends the count — an arrival after a
 * stock-out does not undo it. Flat forecast, no arrivals → exactly onHand ÷ forecast.
 */
export function coverDays(onHand: number, p: Projection, arrivals?: Arrivals): number {
  let s = (finite(onHand) ? onHand : 0) + (arrivals?.get(0) ?? 0);
  if (!(s > 0)) return 0;
  let lastArrival = 0;
  for (const k of arrivals?.keys() ?? []) if (k > lastArrival) lastArrival = k;
  const horizon = Math.max(p.daily.length, lastArrival + 1);
  for (let d = 0; d < horizon; d++) {
    if (d > 0) s += arrivals?.get(d) ?? 0;
    const c = demandOn(p, d);
    if (s - c < -1e-9) return d + (c > 0 ? s / c : 0);
    s -= c;
  }
  if (!(p.tail > 0)) return Infinity;
  return horizon + s / p.tail;
}

/**
 * Forecast units the stock can't serve over days 0 … days − 1 (sales at risk, H3): each day,
 * arrivals land first, then the day's demand is served from what is on hand; demand that can't
 * be served is lost (not carried). A negative start (oversold) is a backlog the first arrivals
 * fill. An out-of-stock product selling 10 a day with 300 arriving on day 25 risks 250 units.
 */
export function lostUnits(onHand: number, p: Projection, days: number, arrivals?: Arrivals): number {
  let s = finite(onHand) ? onHand : 0;
  let lost = 0;
  const n = Math.max(0, Math.floor(finite(days) ? days : 0));
  for (let d = 0; d < n; d++) {
    s += arrivals?.get(d) ?? 0;
    const c = demandOn(p, d);
    const served = Math.min(Math.max(0, s), c);
    lost += c - served;
    s -= served;
  }
  return lost;
}

/**
 * Arrivals by day offset: dated units on their day (overdue → today; capped at the total on
 * order, earliest first), the rest of `incoming` (undated) after `undatedAfterDays` (the lead
 * time, as the forward order plan) — or today when that is unknown (null).
 */
export function arrivalsFrom(
  today: DayKey,
  incoming: number,
  dated: readonly { day: DayKey; units: number }[] | null | undefined,
  undatedAfterDays: number | null,
): Map<number, number> {
  const out = new Map<number, number>();
  let left = Math.max(0, finite(incoming) ? incoming : 0);
  const t = toDayKey(today);
  const list = [...(dated ?? [])].filter((a) => finite(a.units) && a.units > 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const a of list) {
    const u = Math.min(a.units, left);
    if (u <= 0) break;
    const off = Math.max(0, daysBetween(t, toDayKey(a.day)));
    out.set(off, (out.get(off) ?? 0) + u);
    left -= u;
  }
  if (left > 0) {
    const off = undatedAfterDays !== null && finite(undatedAfterDays) ? Math.max(0, Math.round(undatedAfterDays)) : 0;
    out.set(off, (out.get(off) ?? 0) + left);
  }
  return out;
}

/** The day a cover of `days` runs out (today + ⌊days⌋); null for Infinity. */
export function runOutDay(today: DayKey, days: number): DayKey | null {
  return Number.isFinite(days) ? addDays(toDayKey(today), Math.floor(days + 1e-9)) : null;
}
