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

export interface RecurringSpikes {
  /** The units above the cap per in-stock day over the last year (added to the pace). */
  perDay: number;
  /** High days (above the cap) in the history, and the calendar months they fall in. */
  days: number;
  months: number;
  /** In-stock days the average is taken over (the last SPIKE_RECURRING.averageDays at most). */
  inStockDays: number;
}

export interface SpikeCapResult {
  /** The cap applied (null: nothing capped — too few days, or capping off). */
  cap: number | null;
  /** The days capped (above the cap, in short bursts), newest first. */
  capped: CappedDay[];
  /** Their day indices (applyCap lowers these only). */
  days: ReadonlySet<number>;
  /**
   * The high days recur (SPIKE_RECURRING): their units above the cap, averaged over the last
   * year, are added back to the pace (computeVariant) — null for one-offs, none, or capping off.
   */
  recurring: RecurringSpikes | null;
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
  if (opts.off) return { cap: null, capped: [], days: new Set(), recurring: null };
  const t = dayIndex(today);
  const want = opts.windowDays ?? SPIKE_CAP.windowDays;
  const values: number[] = [];
  for (let i = t - 1; i >= t - SPIKE_CAP.lookbackDays && values.length < want; i--) {
    const r = rows.get(i);
    if (!r || soldOut(r) || r.partial || !(r.sold >= 0)) continue;
    values.push(r.sold);
  }
  const robust = robustCap(values, opts.k ?? SPIKE_CAP.k, opts.minDays ?? SPIKE_CAP.minDays);
  if (robust === null) return { cap: null, capped: [], days: new Set(), recurring: null };
  const cap = robust;
  // High days grouped into bursts: only short bursts are spikes; a longer run is a season or a
  // new level (left as it is: the seasonal index and level-shift detection read it).
  const high: number[] = [];
  for (const [i, r] of rows) if (i < t && !soldOut(r) && r.sold > cap + 1e-9) high.push(i);
  const short = spikeBursts(high).filter(isShortBurst);
  const days = new Set(short.flat());
  const capped: CappedDay[] = [];
  for (const i of days) capped.push({ day: fromDayIndex(i), sold: rows.get(i)!.sold, cap });
  capped.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return { cap, capped, days, recurring: recurringSpikes(rows, t, cap, short, opts.k ?? SPIKE_CAP.k) };
}

/**
 * One-off or recurring (accuracy audit 2026-10-18; before: forecast quality 2026-10-17, B6).
 *
 * High days (in-stock days of the 14 months above the robust cap) are grouped into BURSTS (high
 * days at most `burstGapDays` apart). Bursts of at most `maxBurstDays` days are SPIKES — a
 * promotion day, a wholesale order, a campaign weekend. Spikes are RECURRING when there are at
 * least `minDays` such days spread over at least `minMonths` calendar months. Fewer, or all in one or two months: one-offs
 * (a single wholesale order, an influencer post, a data glitch), whatever the history's length.
 *
 * A run of high days longer than `maxBurstDays` (Black Friday into December, a product that went
 * viral) is not capped at all: it is a season or a new level, for the seasonal index and
 * level-shift detection. Every day of a short burst is capped in the pace windows; for recurring
 * bursts their units above the cap — and above their own weeks' level (ownLevel), so last winter's
 * peak against this summer's cap adds nothing — averaged over the last year's in-stock days
 * (`averageDays`; the history's when it is shorter), are added back to the pace: they are real
 * demand, but whether two of them fall in the last 90 days must not swing the order (a wholesale customer ordering 300 five times a year
 * adds ≈ 4 a day all year, not 0 one month and 6.6 the next).
 *
 * Before: only the top 1 % of the history's in-stock days could be capped (at least one day) and
 * more high days than that raised the cap to the highest day outside the top 1 %. With under
 * ~200 days of history that allowed one day, so two 300-unit wholesale days on a product selling
 * 2 a day both passed uncapped (pace 11.8 a day, an order of 606 instead of ≈ 40), and a store
 * with five 300-unit orders a year ordered 607 when two fell in the last 90 days.
 *
 * Measured (scripts/accuracy, docs/ACCURACY.md): counting every burst, the December peak of a
 * store without a seasonal index yet was spread over its first months (28-day bias +25 → +35 %)
 * and the simulated store's winter coats were ordered 40 % up in October (last winter's days added
 * back against the summer cap); with bursts of ≤ 7 days and the own-level floor the real store's
 * accuracy is neutral and the fixtures above are fixed.
 */
export const SPIKE_RECURRING = Object.freeze({
  minDays: 3,
  minMonths: 3,
  maxBurstDays: 7,
  burstGapDays: 2,
  /** A recurring burst adds back only its units above its own weeks' level (this many days before and after it). */
  localDays: 28,
  averageDays: 365,
});

/** High days grouped into bursts (oldest first); shared with the e2e invariants. */
export function spikeBursts(high: readonly number[]): number[][] {
  const out: number[][] = [];
  for (const i of [...high].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && i - last[last.length - 1]! <= SPIKE_RECURRING.burstGapDays) last.push(i);
    else out.push([i]);
  }
  return out;
}

/**
 * A burst's own level (accuracy audit 2026-10-18): the higher of the robust caps of the in-stock
 * days in the `localDays` before it and in the `localDays` after it (the burst itself left out;
 * days from today on never read; a side with fewer than SPIKE_CAP.minDays days counts as −∞).
 * A recurring burst adds back only its units above max(today's cap, this level): a few strong days
 * inside last winter's peak are high against this summer's cap but not against their own weeks, so
 * they add (almost) nothing — the seasonal index carries the season.
 */
function ownLevel(rows: ReadonlyMap<number, DailyRow>, burst: readonly number[], t: number, k: number): number {
  const side = (from: number, to: number) => {
    const xs: number[] = [];
    for (let j = from; j <= to; j++) {
      const r = rows.get(j);
      if (!r || soldOut(r) || r.partial || !(r.sold >= 0)) continue;
      xs.push(r.sold);
    }
    return robustCap(xs, k) ?? -Infinity;
  };
  const W = SPIKE_RECURRING.localDays;
  const first = burst[0]!;
  const last = burst[burst.length - 1]!;
  return Math.max(side(first - W, first - 1), side(last + 1, Math.min(t - 1, last + W)));
}

const isShortBurst = (b: readonly number[]) => b[b.length - 1]! - b[0]! + 1 <= SPIKE_RECURRING.maxBurstDays;

function recurringSpikes(rows: ReadonlyMap<number, DailyRow>, t: number, cap: number, short: readonly number[][], k: number): RecurringSpikes | null {
  let inStock = 0;
  for (let i = t - SPIKE_RECURRING.averageDays; i < t; i++) {
    const r = rows.get(i);
    if (r && !soldOut(r) && !r.partial && r.sold >= 0) inStock++;
  }
  const inLookback = short.filter((b) => b[0]! >= t - SPIKE_CAP.lookbackDays);
  const days = inLookback.reduce((a, b) => a + b.length, 0);
  const months = new Set(inLookback.map((b) => fromDayIndex(b[0]!).slice(0, 7)));
  if (days < SPIKE_RECURRING.minDays || months.size < SPIKE_RECURRING.minMonths || !(inStock > 0)) return null;
  let excess = 0;
  for (const b of inLookback) {
    if (b[b.length - 1]! < t - SPIKE_RECURRING.averageDays) continue;
    const floor = Math.max(cap, ownLevel(rows, b, t, k));
    for (const i of b) if (i >= t - SPIKE_RECURRING.averageDays) excess += Math.max(0, rows.get(i)!.sold - floor);
  }
  return { perDay: excess / inStock, days, months: months.size, inStockDays: inStock };
}

/** A copy of `rows` with each day's sold above `cap` lowered to it — only the days in `only` when given (spikeCap's `days`); null cap: unchanged. */
export function applyCap<M extends ReadonlyMap<number, DailyRow>>(rows: M, cap: number | null, only?: ReadonlySet<number>): Map<number, DailyRow> {
  const out = new Map<number, DailyRow>();
  for (const [i, r] of rows) out.set(i, cap !== null && r.sold > cap && (!only || only.has(i)) ? { ...r, sold: cap } : r);
  return out;
}

/** The capped days inside [from, today) only (the window the merchant is shown). */
export function cappedSince(capped: readonly CappedDay[], today: DayKey, days: number): CappedDay[] {
  const from = addDays(today, -days);
  return capped.filter((c) => c.day >= from && c.day < today);
}
