/**
 * Sales per day while in stock (spec §7.2) and σ_daily (spec §7.4).
 *
 * Rules:
 *  - Only days WITH data count. A missing day is never treated as a 0-sale day.
 *  - A day is SOLD OUT only when the caller flagged it out of stock (ending units ≤ 0) AND
 *    it sold nothing (`soldOutDay`, audit 2026-10-17, H1). A day that ended at ≤ 0 but still
 *    sold (backorders, "continue selling when out of stock", the day the last units went) is
 *    an in-stock day: its sales are real demand. Every other day with data is "in stock".
 *  - `sold` is summed over in-stock days only, so a real sold-out spell (no sales) does not
 *    lower the rate.
 *  - Rows dated today or later are ignored (today is partial, §6.2).
 *  - A row whose `sold` is not a finite number is treated as missing.
 */
import { dayIndex, fromDayIndex, type DayKey } from "./dates-shared";
import {
  ENGINE_DEFAULTS,
  type DailyRow,
  type EngineSettings,
} from "./types-shared";

/**
 * A sold-out day (H1): out of stock AND nothing sold. Out-of-stock days that still sold
 * (backorders / continue selling) count as in stock everywhere: the rate, σ, the in-stock day
 * count, "sales lost to sell-outs" and Dead.
 */
export function soldOutDay(row: Pick<DailyRow, "outOfStock" | "sold">): boolean {
  return row.outOfStock && !(row.sold > 0);
}

/** Rows by day index, before `today` only. Throws on a duplicate day. */
export type SeriesIndex = Map<number, DailyRow>;

export function indexSeries(series: readonly DailyRow[], today: DayKey): SeriesIndex {
  const t = dayIndex(today);
  const out: SeriesIndex = new Map();
  for (const row of series) {
    const i = dayIndex(row.day);
    if (i >= t) continue;
    if (!Number.isFinite(row.sold)) continue;
    if (out.has(i)) throw new Error(`engine: duplicate day ${row.day} in series`);
    out.set(i, row);
  }
  return out;
}

export interface WindowStats {
  days: number;
  /** Days in the window that have a row. */
  dataDays: number;
  inStockDays: number;
  /** Sold-out days with data (soldOutDay). */
  outOfStockDays: number;
  /** Σ sold over in-stock days. */
  soldInStock: number;
}

/** Stats for the last `days` days: [today − days, today − 1]. */
export function windowStats(index: SeriesIndex, today: DayKey, days: number): WindowStats {
  const t = dayIndex(today);
  const s: WindowStats = { days, dataDays: 0, inStockDays: 0, outOfStockDays: 0, soldInStock: 0 };
  for (let i = t - days; i < t; i++) {
    const row = index.get(i);
    if (!row) continue;
    s.dataDays++;
    if (soldOutDay(row)) {
      s.outOfStockDays++;
    } else {
      s.inStockDays++;
      s.soldInStock += row.sold;
    }
  }
  return s;
}

export interface RateWindowResult {
  days: number;
  weight: number;
  inStockDays: number;
  soldInStock: number;
  /** rate_N, null when the window has no in-stock day. Clamped at 0. */
  rate: number | null;
  /** False when dropped (< minWindowInStockDays in-stock days). */
  used: boolean;
}

export interface RateResult {
  /** Weighted rate, null when every window was dropped. */
  rate: number | null;
  windows: RateWindowResult[];
  /** In-stock days over `historyDays`. */
  inStockDays: number;
  /** Days with data over `historyDays`. */
  dataDays: number;
  /** Out-of-stock days with data over `historyDays`. */
  outOfStockDays: number;
  /** inStockDays ≥ minInStockDays. Below it: no order advice. */
  enoughData: boolean;
}

/** rate = Σ wᵢ·rate_Nᵢ ÷ Σ wᵢ over the windows that are kept (spec §7.2). */
export function salesRate(
  index: SeriesIndex,
  today: DayKey,
  settings: EngineSettings = ENGINE_DEFAULTS,
): RateResult {
  const windows: RateWindowResult[] = settings.rateWindows.map(({ days, weight }) => {
    const st = windowStats(index, today, days);
    const rate = st.inStockDays > 0 ? Math.max(0, st.soldInStock / st.inStockDays) : null;
    return {
      days,
      weight,
      inStockDays: st.inStockDays,
      soldInStock: st.soldInStock,
      rate,
      used: rate !== null && st.inStockDays >= settings.minWindowInStockDays,
    };
  });
  let num = 0;
  let den = 0;
  for (const w of windows) {
    if (!w.used || w.rate === null) continue;
    num += w.weight * w.rate;
    den += w.weight;
  }
  const hist = windowStats(index, today, settings.historyDays);
  return {
    rate: den > 0 ? num / den : null,
    windows,
    inStockDays: hist.inStockDays,
    dataDays: hist.dataDays,
    outOfStockDays: hist.outOfStockDays,
    enoughData: hist.inStockDays >= settings.minInStockDays,
  };
}

/**
 * σ_daily: POPULATION standard deviation of daily demand on in-stock days in the last `days`
 * days. Days with negative net sales (returns larger than sales) are left out: a return is
 * not negative demand. Null when there is no such day.
 */
export function sigmaDaily(index: SeriesIndex, today: DayKey, days: number): number | null {
  const t = dayIndex(today);
  const xs: number[] = [];
  for (let i = t - days; i < t; i++) {
    const row = index.get(i);
    if (row && !soldOutDay(row) && row.sold >= 0) xs.push(row.sold);
  }
  if (xs.length === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

/** Latest day with sold > 0 in the indexed series, or null. */
export function lastSaleDay(index: SeriesIndex): DayKey | null {
  let best: number | null = null;
  for (const [i, row] of index) {
    if (row.sold > 0 && (best === null || i > best)) best = i;
  }
  return best === null ? null : fromDayIndex(best);
}

/** Earliest day with data in the indexed series, or null. */
export function earliestDataDay(index: SeriesIndex): DayKey | null {
  let best: number | null = null;
  for (const i of index.keys()) if (best === null || i < best) best = i;
  return best === null ? null : fromDayIndex(best);
}

/** How far back the in-stock pace fallback reaches: the 14 months of history the app stores. */
export const PACE_LOOKBACK_DAYS = 427;
/** In-stock days the fallback pace is measured over (as the shortest rate window). */
export const PACE_TARGET_DAYS = 28;

export interface InStockPace {
  /** Units per in-stock day over the days used (clamped at 0). */
  rate: number;
  /** σ_daily over the same days (negative return days left out, as sigmaDaily). */
  sigma: number;
  inStockDays: number;
  /** The earliest day used ("based on in-stock days since {month}"). */
  from: DayKey;
}

/**
 * Data audit 2026-10-17 #2: a best seller out of stock most of the last 90 days has fewer than
 * `minInStockDays` in-stock days there and would drop out of the plan ("can't be planned yet").
 * Its pace comes from the most recent in-stock days instead, reaching back before the 90 days
 * (up to PACE_LOOKBACK_DAYS): walking back from yesterday, the first PACE_TARGET_DAYS in-stock
 * days (sold-out days skipped, missing days skipped). Null when fewer than `minInStockDays` exist.
 */
export function inStockPace(index: SeriesIndex, today: DayKey, settings: EngineSettings = ENGINE_DEFAULTS): InStockPace | null {
  const t = dayIndex(today);
  const target = Math.max(settings.minInStockDays, PACE_TARGET_DAYS);
  const used: { i: number; sold: number }[] = [];
  for (let i = t - 1; i >= t - PACE_LOOKBACK_DAYS && used.length < target; i--) {
    const row = index.get(i);
    if (!row || soldOutDay(row)) continue;
    used.push({ i, sold: row.sold });
  }
  if (used.length < settings.minInStockDays) return null;
  const sold = used.reduce((a, d) => a + d.sold, 0);
  const xs = used.filter((d) => d.sold >= 0).map((d) => d.sold);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const sigma = xs.length ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / xs.length) : 0;
  return { rate: Math.max(0, sold / used.length), sigma, inStockDays: used.length, from: fromDayIndex(used[used.length - 1]!.i) };
}
