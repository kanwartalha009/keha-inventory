/**
 * The weekly backtest cache (perf 2026-10-18, "before 1,000 stores" #5 and #6). Pure.
 *
 * Why. Every night compute re-read 14 months of sales and stock for EVERY variant (the engine's
 * `history`: the spike cap's one-off rule reads 427 days, the forecast-error backtest 13 weekly
 * origins) and re-ran the backtest — on a 30,000-variant store ~65 s of reads and ~45 s of engine
 * work a night, for a figure whose origins step by a week.
 *
 * What is cached, per variant (VariantBacktest):
 *  - the history rows exactly as compute's history read builds them (compute-shared buildSeries,
 *    no bundle sales, no prices), over [day − 427, day − 84): every night of the next week needs
 *    [t − 427, t − 90), and those days no longer change (the nightly sync writes yesterday);
 *  - the backtest result of that night (error-shared errorRatio: ratio, windows, samples, bias)
 *    and the horizon P it was run for.
 * And per shop (BacktestRun): the ABC roles' pooled ratios (error-shared rolePrior) used for the
 * week, so safety stock does not move every night with the sample.
 *
 * Exactness. On a cached night the engine gets the same `history` rows a fresh read would give
 * (cachedHistory: the window cut, and the first day of a fresh read is never a "ran out" day —
 * it has no day before it in that read). The backtest is the cached one: the ratio used is the
 * same pooling errorRatio does (pooledUsed, tested against errorRatio), passed as the prior with no
 * origins (the engine then uses it as is), and inputs.error gets the cached ratio, samples,
 * windows, bias and the real prior back (withCachedBacktest). On the night the cache is written
 * the cached path gives exactly the full run's output (tests/backtest-cache-shared.test.ts).
 *
 * When the cache is not used (a fresh read and a fresh backtest instead): no row, a row older than
 * MAX_AGE_DAYS, a row from another scope (pool locations, demand view, engine settings, the facts'
 * backfill, the format — scopeKey), the variant's refresh night (one in seven, by variant: the
 * reads are spread over the week — refreshPhase), and a shop whose role priors are due again
 * (BacktestRun older than REFRESH_DAYS). The backtest alone is run again on the cached history
 * when the horizon changed, when the cached night had no backtest (no order advice then), and for
 * products planned like another (the engine may skip the backtest for them).
 *
 * Variants that sold nothing in those 14 months (and nothing in the 90 days, with enough in-stock
 * days) skip the stock part of the history read: for them the engine's output is the same with or
 * without the rows (tests). Their cache row has no rows (history null) and is used only while
 * that still holds.
 */
import { addDays, dayIndex, fromDayIndex, type DayKey } from "./engine/dates-shared";
import { FORECAST_ERROR, type ErrorRatio } from "./engine/error-shared";
import type { AbcRole, DailyRow, VariantInputs } from "./engine/index-shared";
import { PACE_LOOKBACK_DAYS } from "./engine/rate-shared";

export const BACKTEST_CACHE = Object.freeze({
  /** Cache format (rows encoding, window); part of the scope key. */
  version: 1,
  /** A row is used on the nights day … day + MAX_AGE_DAYS (its window covers them). */
  maxAgeDays: 6,
  /** Each variant's history and backtest are read again once in this many nights. */
  refreshDays: 7,
  /** The shop's role priors are measured again after this many nights. */
  priorDays: 7,
});

/** The cached window's first day for a cache night (the engine's 14 months back, PACE_LOOKBACK_DAYS). */
export const cacheFrom = (day: DayKey): DayKey => addDays(day, -PACE_LOOKBACK_DAYS);
/** The cached window's end (exclusive): the history window start (`today − historyDays`) + maxAgeDays. */
export const cacheTo = (day: DayKey, historyDays: number): DayKey => addDays(day, -historyDays + BACKTEST_CACHE.maxAgeDays);

/** The cached backtest of one variant (VariantBacktest without shop / variantId). */
export interface BacktestCache {
  /** The night it was read (store-local day). */
  day: DayKey;
  /** The horizon P (lead time + cycle) the backtest ran for. */
  horizon: number;
  scopeKey: string;
  /** A backtest ran (the variant had order advice that night). */
  backtested: boolean;
  ratio: number | null;
  windows: number;
  samples: number;
  bias: number | null;
  /** encodeHistory over [cacheFrom(day), cacheTo(day)); null = no sales in it (rows not stored). */
  history: string | null;
}

// ---------------------------------------------------------------------------------------- rows

/**
 * History rows → text: `dd:sold:end:flags` per row (dd = days after the previous row, the first
 * one after `from`; flags 1 = out of stock, 2 = ran out that day), a run of identical consecutive
 * rows as `token*n`. Numbers are written in JavaScript's shortest round-trip form (exact).
 */
export function encodeHistory(rows: readonly DailyRow[], from: DayKey): string {
  const base = dayIndex(from);
  const out: string[] = [];
  let prev = base - 1;
  let last: string | null = null;
  let run = 0;
  const flush = () => {
    if (last !== null) out.push(run > 1 ? `${last}*${run}` : last);
  };
  for (const r of [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    const i = dayIndex(r.day);
    const flags = (r.outOfStock ? 1 : 0) | (r.partial ? 2 : 0);
    const token = `${i - prev}:${r.sold}:${r.endStock}:${flags}`;
    if (token === last && i - prev === 1) run++;
    else {
      flush();
      last = token;
      run = 1;
    }
    prev = i;
  }
  flush();
  return out.join(";");
}

/** Day keys from `from`, memoised (decoding builds hundreds of rows per variant). */
const dayKeys = new Map<string, DayKey[]>();
function keyOf(from: DayKey, offset: number): DayKey {
  let keys = dayKeys.get(from);
  if (!keys) {
    if (dayKeys.size > 32) dayKeys.clear();
    dayKeys.set(from, (keys = []));
  }
  return (keys[offset] ??= fromDayIndex(dayIndex(from) + offset));
}

/** Text → rows, shaped as buildSeries makes them ({ day, sold, endStock, outOfStock, price: null, partial? }). */
export function decodeHistory(text: string, from: DayKey): DailyRow[] {
  const out: DailyRow[] = [];
  if (!text) return out;
  let offset = -1;
  for (const part of text.split(";")) {
    const star = part.indexOf("*");
    const token = star < 0 ? part : part.slice(0, star);
    const n = star < 0 ? 1 : Number(part.slice(star + 1));
    const [dd, sold, end, flags] = token.split(":");
    const f = Number(flags);
    for (let k = 0; k < n; k++) {
      offset += k === 0 ? Number(dd) : 1;
      const row: DailyRow = { day: keyOf(from, offset), sold: Number(sold), endStock: Number(end), outOfStock: (f & 1) === 1, price: null };
      if (f & 2) row.partial = true;
      out.push(row);
    }
  }
  return out;
}

/**
 * The engine's `history` for `today` from a cache row: the rows a fresh read of
 * [today − 427, historyFrom) gives. That read's first day has no day before it, so it is never a
 * "ran out" day (buildSeries); the cached read reaches further back, so its flag is cleared here.
 */
export function cachedHistory(cache: Pick<BacktestCache, "day" | "history">, today: DayKey, historyFrom: DayKey): DailyRow[] {
  if (!cache.history) return [];
  const first = addDays(today, -PACE_LOOKBACK_DAYS);
  const out: DailyRow[] = [];
  for (const r of decodeHistory(cache.history, cacheFrom(cache.day))) {
    if (r.day < first || r.day >= historyFrom) continue;
    if (r.day === first && r.partial) {
      const { partial: _p, ...rest } = r;
      out.push(rest);
    } else out.push(r);
  }
  return out;
}

/** Any non-zero units in the rows (sales or returns)? */
export const anySales = (rows: readonly DailyRow[] | null | undefined): boolean => !!rows?.some((r) => Number.isFinite(r.sold) && r.sold !== 0);

// ---------------------------------------------------------------------------------- when to use

/** A stable 0 … refreshDays − 1 for a variant: its refresh nights (FNV-1a of the id). */
export function refreshPhase(variantId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < variantId.length; i++) {
    h ^= variantId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % BACKTEST_CACHE.refreshDays;
}

/** Is `today` this variant's refresh night (one in refreshDays, spread over the variants)? */
export function isRefreshNight(variantId: string, today: DayKey): boolean {
  return (dayIndex(today) + refreshPhase(variantId)) % BACKTEST_CACHE.refreshDays === 0;
}

/** Can tonight's history come from this cache row (scope, age, not the refresh night)? */
export function historyUsable(cache: Pick<BacktestCache, "day" | "scopeKey"> | null | undefined, x: { variantId: string; today: DayKey; scopeKey: string }): boolean {
  if (!cache || cache.scopeKey !== x.scopeKey) return false;
  const age = dayIndex(x.today) - dayIndex(cache.day);
  if (age < 0 || age > BACKTEST_CACHE.maxAgeDays) return false;
  return age === 0 || !isRefreshNight(x.variantId, x.today);
}

/** Can tonight reuse the cached backtest (same horizon, it ran, no "Plan like…")? */
export function backtestReusable(cache: Pick<BacktestCache, "horizon" | "backtested">, x: { horizon: number; planLike: boolean }): boolean {
  return cache.backtested && cache.horizon === x.horizon && !x.planLike;
}

/**
 * The scope a cache row belongs to: anything that changes the history rows or the backtest
 * besides the calendar — the pool's locations, the demand view (channels / locations left out),
 * the engine settings, the backfill's covered months, the cache format.
 */
export function backtestScopeKey(x: { pool: readonly string[]; demand: unknown; settings: unknown; facts: unknown }): string {
  const text = JSON.stringify([BACKTEST_CACHE.version, PACE_LOOKBACK_DAYS, [...x.pool].sort(), x.demand, x.settings, x.facts]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `v${BACKTEST_CACHE.version}-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** What of the backfill state changes the stored history (not the nightly `syncedThrough`). */
export function factsStamp(state: { finishedAt?: string | null; datasets?: Partial<Record<string, { doneThrough?: string | null; skippedMonths?: string[] } | undefined>> }): unknown {
  const d = (k: string) => [state.datasets?.[k]?.doneThrough ?? null, state.datasets?.[k]?.skippedMonths ?? []];
  return { sales: d("sales"), stock: d("stock") };
}

// ------------------------------------------------------------------------------------ backtest

/**
 * The ratio used for safety from a cached backtest and tonight's role prior — error-shared
 * errorRatio's pooling: √((n·ρ² + n₀·prior²) ÷ (n + n₀)), the prior alone without samples.
 */
export function pooledUsed(cache: Pick<BacktestCache, "ratio" | "windows" | "samples">, prior: number): number {
  if (!cache.samples || cache.ratio === null) return prior;
  const n0 = FORECAST_ERROR.priorWindows;
  return Math.sqrt((cache.windows * cache.ratio * cache.ratio + n0 * prior * prior) / (cache.windows + n0));
}

/** The cached backtest as error-shared's ErrorRatio (for tests and the result patch). */
export function cachedErrorRatio(cache: Pick<BacktestCache, "ratio" | "windows" | "samples" | "bias">, prior: number): ErrorRatio {
  return { ratio: cache.samples ? cache.ratio : null, used: pooledUsed(cache, prior), windows: cache.samples ? cache.windows : 0, samples: cache.samples, bias: cache.samples ? cache.bias : null };
}

/**
 * inputs.error after a cached-backtest run (the engine ran with prior = pooledUsed and no origins,
 * so its error holds ratio null, prior = used): the cached figures and the real prior back.
 * Every number the engine derived from `used` (σ, k, safety, quantities) is already right.
 */
export function withCachedBacktest(error: VariantInputs["error"], cache: Pick<BacktestCache, "ratio" | "windows" | "samples" | "bias">, prior: number): VariantInputs["error"] {
  if (!error) return error;
  const b = cachedErrorRatio(cache, prior);
  return { ...error, ratio: b.ratio, prior, used: error.used, samples: b.samples, windows: b.windows, bias: b.bias };
}

/** The backtest fields of a cache row from a full run's inputs.error (null: no backtest ran). */
export function backtestOf(error: VariantInputs["error"]): Pick<BacktestCache, "backtested" | "ratio" | "windows" | "samples" | "bias"> {
  if (!error) return { backtested: false, ratio: null, windows: 0, samples: 0, bias: null };
  return { backtested: true, ratio: error.ratio, windows: error.windows, samples: error.samples, bias: error.bias };
}

/**
 * Item 6: the roles' pooled ratios from the stored backtests — the same sample the pre-pass used
 * (each role's variants, highest 90-day revenue first, then id; up to FORECAST_ERROR.roleSample),
 * their cached ratios (no row / no backtest = null, as a pre-pass variant without one). null when
 * no variant of the shop has a stored backtest (first run: the pre-pass measures them).
 */
export function rolePriorsFrom(
  plans: readonly { id: string }[],
  roles: ReadonlyMap<string, AbcRole>,
  revenue: ReadonlyMap<string, number>,
  ratioOf: ReadonlyMap<string, number | null>,
  rolePrior: (ratios: readonly (number | null)[]) => number | null,
): Map<AbcRole, number> | null {
  if (![...ratioOf.values()].some((r) => typeof r === "number")) return null;
  const byRole = new Map<AbcRole, (number | null)[]>();
  for (const role of ["A", "B", "C"] as const) {
    const mine = plans.filter((p) => (roles.get(p.id) ?? "C") === role);
    mine.sort((a, b) => (revenue.get(b.id) ?? 0) - (revenue.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1));
    byRole.set(role, mine.slice(0, FORECAST_ERROR.roleSample).map((p) => ratioOf.get(p.id) ?? null));
  }
  const store = rolePrior([...byRole.values()].flat());
  const out = new Map<AbcRole, number>();
  for (const role of ["A", "B", "C"] as const) out.set(role, rolePrior(byRole.get(role) ?? []) ?? store ?? 1);
  return out;
}

/** Are the stored role priors still the week's (same scope, at most priorDays − 1 nights old)? */
export function priorsUsable(run: { day: DayKey; scopeKey: string } | null | undefined, x: { today: DayKey; scopeKey: string }): boolean {
  if (!run || run.scopeKey !== x.scopeKey) return false;
  const age = dayIndex(x.today) - dayIndex(run.day);
  return age >= 0 && age < BACKTEST_CACHE.priorDays;
}
