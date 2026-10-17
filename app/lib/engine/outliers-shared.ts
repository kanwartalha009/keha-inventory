/**
 * One-off spike capping (forecast quality, R4 2026-10-18). Pure.
 *
 * A wholesale order, an influencer post or a data glitch can put 300 units on one day of a
 * product that sells 10 a day. Averaged into the sales pace it orders weeks of stock nobody
 * will buy; in σ it inflates safety stock for months. Each day's demand is capped (winsorised)
 * before the pace and σ are measured:
 *
 *   cap = median + k × scale,   scale = max(1.4826 × MAD, √mean)
 *
 * over the most recent `windowDays` in-stock days (sold-out days and return-heavy negative days
 * left out). 1.4826 × MAD is the robust standard deviation; √mean is the Poisson floor, so a slow
 * seller (median 0, MAD 0) is not capped to nothing: at 0.3 a day the cap is 4 × √0.3 ≈ 2.2 units,
 * so a 30-unit day counts as 2.2 (a 2-unit day stays). k = 4 (tuned on a real store's history, docs/ACCURACY.md;
 * a lower k caps real promotions, a higher one lets wholesale orders through). Fewer than
 * `minDays` in-stock days: nothing is capped (too little to tell a spike from the pace).
 *
 * Only the pace and σ read the capped values; units sold, the last sale and "Dead" keep the real
 * figures. The merchant can switch it off per product ("Don't cap").
 */
import { addDays, dayIndex, fromDayIndex, type DayKey } from "./dates-shared";
import type { DailyRow } from "./types-shared";

export const SPIKE_CAP = Object.freeze({
  /** Multiplier of the robust scale above the median. */
  k: 4,
  /** In-stock days the median and MAD are measured over (the most recent ones). */
  windowDays: 90,
  /** Below this many in-stock days nothing is capped. */
  minDays: 14,
  /** How far back the in-stock days may be searched (the 14 months the app stores). */
  lookbackDays: 427,
});

export interface CappedDay {
  day: DayKey;
  /** Units the day really sold. */
  sold: number;
  /** What the pace and σ used instead. */
  cap: number;
}

export interface SpikeCapResult {
  /** The cap applied (null: nothing capped — too few days, or capping off). */
  cap: number | null;
  /** The days above it, newest first. */
  capped: CappedDay[];
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

/** median + k × max(1.4826 × MAD, √mean) of `values`; null when there are fewer than `minDays`. */
export function robustCap(values: readonly number[], k: number = SPIKE_CAP.k, minDays: number = SPIKE_CAP.minDays): number | null {
  if (!(values.length >= minDays) || !(k > 0) || !Number.isFinite(k)) return null;
  const m = median(values);
  const mad = median(values.map((x) => Math.abs(x - m)));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const scale = Math.max(1.4826 * mad, Math.sqrt(Math.max(0, mean)));
  return m + k * scale;
}

/** A sold-out day (out of stock, nothing sold) — the same rule as rate-shared soldOutDay. */
const soldOut = (r: Pick<DailyRow, "outOfStock" | "sold">) => r.outOfStock && !(r.sold > 0);

/**
 * The cap for a series as of `today` and the days it caps (see the module header). `rows` by day
 * index (rate-shared SeriesIndex); rows dated today or later are never read.
 */
export function spikeCap(
  rows: ReadonlyMap<number, DailyRow>,
  today: DayKey,
  opts: { k?: number; windowDays?: number; minDays?: number; off?: boolean } = {},
): SpikeCapResult {
  if (opts.off) return { cap: null, capped: [] };
  const t = dayIndex(today);
  const want = opts.windowDays ?? SPIKE_CAP.windowDays;
  const values: number[] = [];
  for (let i = t - 1; i >= t - SPIKE_CAP.lookbackDays && values.length < want; i--) {
    const r = rows.get(i);
    if (!r || soldOut(r) || r.partial || !(r.sold >= 0)) continue;
    values.push(r.sold);
  }
  const robust = robustCap(values, opts.k ?? SPIKE_CAP.k, opts.minDays ?? SPIKE_CAP.minDays);
  if (robust === null) return { cap: null, capped: [] };
  const cap = recurringCap(rows, t, robust);
  const capped: CappedDay[] = [];
  for (const [i, r] of rows) {
    if (i >= t || soldOut(r)) continue;
    if (r.sold > cap + 1e-9) capped.push({ day: fromDayIndex(i), sold: r.sold, cap });
  }
  capped.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return { cap, capped };
}

/**
 * One-off, not recurring (forecast quality 2026-10-17, B6): only the top 1 % of the in-stock days of
 * the history (at least one day) can be capped. When more days than that are above the robust cap,
 * they are the product's own recurring high days (promotions, campaign days) — real demand, not
 * one-offs — and the cap rises to the highest day that is not among that top 1 %. Measured on a real
 * store: 2.5 % of the A items' days were above the robust cap, removing 3.3 % of their units, and
 * the forecast of fast sellers ran 8–12 % low (docs/ACCURACY.md). The k = 4 cap had been chosen on
 * WAPE, which rewards a median-like forecast — and on right-skewed daily sales the median is below
 * the mean the order quantity needs.
 */
export const SPIKE_SHARE = 0.01;

function recurringCap(rows: ReadonlyMap<number, DailyRow>, t: number, robust: number): number {
  const all: number[] = [];
  for (let i = t - 1; i >= t - SPIKE_CAP.lookbackDays; i--) {
    const r = rows.get(i);
    if (!r || soldOut(r) || r.partial || !(r.sold >= 0)) continue;
    all.push(r.sold);
  }
  const allowed = Math.max(1, Math.floor(SPIKE_SHARE * all.length));
  const above = all.filter((x) => x > robust + 1e-9).length;
  if (above <= allowed) return robust;
  all.sort((a, b) => b - a);
  return Math.max(robust, all[allowed]!);
}

/** A copy of `rows` with every day's sold above `cap` lowered to it (null cap: the same map). */
export function applyCap<M extends ReadonlyMap<number, DailyRow>>(rows: M, cap: number | null): Map<number, DailyRow> {
  const out = new Map<number, DailyRow>();
  for (const [i, r] of rows) out.set(i, cap !== null && r.sold > cap ? { ...r, sold: cap } : r);
  return out;
}

/** The capped days inside [from, today) only (the window the merchant is shown). */
export function cappedSince(capped: readonly CappedDay[], today: DayKey, days: number): CappedDay[] {
  const from = addDays(today, -days);
  return capped.filter((c) => c.day >= from && c.day < today);
}
