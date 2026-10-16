/**
 * Sales per day while in stock (spec §7.2) and σ_daily (spec §7.4).
 *
 * Rules:
 *  - Only days WITH data count. A missing day is never treated as a 0-sale day.
 *  - A day is "in stock" when it has data and outOfStock is false.
 *  - `sold` is summed over in-stock days only: sales on a sell-out day are
 *    partial, so a stock-out window must not lower the rate.
 *  - Rows dated today or later are ignored (today is partial, §6.2).
 *  - A row whose `sold` is not a finite number is treated as missing.
 */
import { dayIndex, fromDayIndex, type DayKey } from "./dates-shared";
import {
  ENGINE_DEFAULTS,
  type DailyRow,
  type EngineSettings,
} from "./types-shared";

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
  /** Days with a row and outOfStock true. */
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
    if (row.outOfStock) {
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
 * σ_daily: POPULATION standard deviation of daily `sold` on in-stock days in
 * the last `days` days. Null when there is no in-stock day.
 */
export function sigmaDaily(index: SeriesIndex, today: DayKey, days: number): number | null {
  const t = dayIndex(today);
  const xs: number[] = [];
  for (let i = t - days; i < t; i++) {
    const row = index.get(i);
    if (row && !row.outOfStock) xs.push(row.sold);
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
