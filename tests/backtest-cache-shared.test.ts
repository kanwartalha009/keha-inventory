/**
 * The weekly backtest cache (perf 2026-10-18, lib/backtest-cache-shared): the cached history is
 * the same rows a fresh read builds, the cached backtest gives the same order quantities as a full
 * run on the same day, variants that sold nothing compute the same without their history, and
 * the refresh nights are spread over the week.
 */
import { describe, expect, it } from "vitest";
import {
  BACKTEST_CACHE,
  anySales,
  backtestOf,
  backtestReusable,
  backtestScopeKey,
  cacheFrom,
  cacheTo,
  cachedErrorRatio,
  cachedHistory,
  decodeHistory,
  encodeHistory,
  factsStamp,
  historyUsable,
  isRefreshNight,
  pooledUsed,
  priorsUsable,
  refreshPhase,
  rolePriorsFrom,
  withCachedBacktest,
  type BacktestCache,
} from "../app/lib/backtest-cache-shared";
import { buildSeries, type PooledStockDay, type SalesDay } from "../app/lib/compute-shared";
import { addDays } from "../app/lib/engine/dates-shared";
import { computeVariant, errorOriginDays, errorRatio, rolePrior, type AbcRole, type DailyRow, type VariantInput } from "../app/lib/engine/index-shared";

const T0 = "2026-10-18";
const HISTORY_DAYS = 90;

/** A deterministic store's facts for one variant: sales and pooled stock per day (gaps, sell-outs, returns). */
function facts(seed: number, opts: { density?: number; noSales?: boolean } = {}) {
  let x = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0), x / 2 ** 32);
  const density = opts.density ?? 0.25;
  const sales: SalesDay[] = [];
  const stock: PooledStockDay[] = [];
  let units = 20 + Math.floor(rnd() * 40);
  for (let o = -520; o <= 10; o++) {
    const day = addDays(T0, o);
    if (rnd() < 0.03) continue; // no stock row that day: missing data
    let sold = 0;
    if (!opts.noSales) {
      if (rnd() < density) sold = 1 + Math.floor(rnd() * (rnd() < 0.02 ? 40 : 4)); // a spike now and then
      if (rnd() < 0.01) sold = -1; // a return-heavy day
    }
    if (units <= 0 && rnd() < 0.7) sold = Math.min(sold, 0); // mostly no sales while out
    units -= Math.max(0, sold);
    if (units <= 0 && rnd() < 0.15) units = 15 + Math.floor(rnd() * 30); // restocked
    stock.push({ variantId: "v", day, endUnits: units, reported: 2, outReported: units <= 0 ? 2 : rnd() < 0.05 ? 1 : 0 });
    if (sold !== 0) sales.push({ variantId: "v", day, sold, gross: 0 });
  }
  /** What compute's history read builds over [from, before) (buildSeries, no bundles, no prices). */
  const read = (from: string, before: string): DailyRow[] =>
    buildSeries(
      sales.filter((s) => s.day >= from && s.day < before),
      stock.filter((s) => s.day >= from && s.day < before),
    ).get("v") ?? [];
  /** The 90-day series as compute builds it. */
  const series = (today: string) => read(addDays(today, -HISTORY_DAYS), today);
  return { read, series };
}

/** A cache row as compute writes it on `day`. */
function cacheOf(f: ReturnType<typeof facts>, day: string, over: Partial<BacktestCache> = {}): BacktestCache {
  return {
    day,
    horizon: 44,
    scopeKey: "k",
    backtested: true,
    ratio: 1.1,
    windows: 3,
    samples: 13,
    bias: 0.05,
    history: encodeHistory(f.read(cacheFrom(day), cacheTo(day, HISTORY_DAYS)), cacheFrom(day)),
    ...over,
  };
}

const base = (id: string, today: string, role: AbcRole = "B"): Omit<VariantInput, "series"> => ({
  id,
  today,
  onHand: 12,
  incoming: 4,
  role,
  supplierLeadTimeDays: 30,
  cycleDays: 14,
  seasonal: 1.1,
  trend: 1,
  plan: 1,
  price: 25,
  cost: 9,
  caseQty: 6,
});

describe("history rows", () => {
  it("encode → decode gives the rows back, exactly as buildSeries makes them", () => {
    let partial = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rows = facts(seed).read(cacheFrom(T0), cacheTo(T0, HISTORY_DAYS));
      partial += rows.filter((r) => r.partial).length;
      const text = encodeHistory(rows, cacheFrom(T0));
      expect(decodeHistory(text, cacheFrom(T0))).toEqual(rows);
    }
    expect(partial).toBeGreaterThan(20); // "ran out that day" rows are covered
    expect(decodeHistory("", cacheFrom(T0))).toEqual([]);
    expect(encodeHistory([], cacheFrom(T0))).toBe("");
  });

  it("a slow seller's steady stock compresses to a few runs", () => {
    const rows = facts(3, { noSales: true }).read(cacheFrom(T0), cacheTo(T0, HISTORY_DAYS));
    expect(rows.length).toBeGreaterThan(300);
    expect(encodeHistory(rows, cacheFrom(T0)).length).toBeLessThan(400);
  });

  it("on every night of the week the cached rows equal a fresh read of [today − 427, today − 90)", () => {
    let partialFirstDays = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const f = facts(seed, { density: seed % 3 === 0 ? 0.05 : 0.3 });
      const c = cacheOf(f, T0);
      for (let d = 0; d <= BACKTEST_CACHE.maxAgeDays; d++) {
        const today = addDays(T0, d);
        const from = addDays(today, -HISTORY_DAYS);
        const fresh = f.read(addDays(today, -427), from);
        expect(cachedHistory(c, today, from), `seed ${seed}, night +${d}`).toEqual(fresh);
        if (f.read(addDays(today, -428), from).find((r) => r.day === addDays(today, -427))?.partial) partialFirstDays++;
      }
    }
    // The first-day rule was exercised (a read starting a day earlier would have flagged it).
    expect(partialFirstDays).toBeGreaterThan(0);
  });
});

describe("engine output from the cache", () => {
  const P = 44;
  const prior = 1.07;

  /** Full run: fresh history, the backtest at its origins, the role prior. */
  const full = (f: ReturnType<typeof facts>, id: string, today: string, role: AbcRole) =>
    computeVariant({
      ...base(id, today, role),
      series: f.series(today),
      history: f.read(addDays(today, -427), addDays(today, -HISTORY_DAYS)),
      errorOrigins: errorOriginDays(today, P).map((day) => ({ day, multiplier: 1.1 })),
      errorPrior: prior,
    })!;

  it("cached history + a fresh backtest = the full run, exactly, on every night of the week", () => {
    let historyMatters = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const f = facts(seed);
      const noHistory = computeVariant({ ...base(`v${seed}`, T0), series: f.series(T0), history: null, errorOrigins: errorOriginDays(T0, P).map((day) => ({ day, multiplier: 1.1 })), errorPrior: prior });
      if (JSON.stringify(noHistory) !== JSON.stringify(full(f, `v${seed}`, T0, "B"))) historyMatters++;
      const c = cacheOf(f, T0);
      for (const d of [0, 1, 3, 6]) {
        const today = addDays(T0, d);
        const cached = computeVariant({
          ...base(`v${seed}`, today),
          series: f.series(today),
          history: cachedHistory(c, today, addDays(today, -HISTORY_DAYS)),
          errorOrigins: errorOriginDays(today, P).map((day) => ({ day, multiplier: 1.1 })),
          errorPrior: prior,
        });
        expect(cached, `seed ${seed}, night +${d}`).toEqual(full(f, `v${seed}`, today, "B"));
      }
    }
    expect(historyMatters).toBeGreaterThan(20); // the rows do change the output: the equality means something
  });

  it("a reused backtest gives the full run's order quantities on the same day (and its error figures)", () => {
    let withSamples = 0;
    let ordering = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const f = facts(seed, { density: [0.05, 0.2, 0.6][seed % 3] });
      const role = (["A", "B", "C"] as const)[seed % 3]!;
      const want = full(f, `v${seed}`, T0, role);
      // The cache row compute writes from the full run, then the cached path that night.
      const c: BacktestCache = { ...cacheOf(f, T0), horizon: P, ...backtestOf(want.inputs.error) };
      const reused = computeVariant({
        ...base(`v${seed}`, T0, role),
        series: f.series(T0),
        history: cachedHistory(c, T0, addDays(T0, -HISTORY_DAYS)),
        errorOrigins: null,
        errorPrior: pooledUsed(c, prior),
      })!;
      reused.inputs.error = withCachedBacktest(reused.inputs.error, c, prior);
      if (want.inputs.error?.samples) withSamples++;
      if ((want.orderQty ?? 0) > 0) ordering++;
      expect(reused.orderQty, `seed ${seed}`).toBe(want.orderQty);
      expect(reused.status).toBe(want.status);
      expect(reused.daysLeft).toBe(want.daysLeft);
      if (want.safety === null) expect(reused.safety).toBeNull();
      else expect(reused.safety!).toBeCloseTo(want.safety, 9);
      if (want.inputs.error === null) expect(reused.inputs.error).toBeNull();
      else {
        const e = reused.inputs.error!;
        const w = want.inputs.error;
        expect({ ratio: e.ratio, samples: e.samples, windows: e.windows, bias: e.bias, prior: e.prior, horizonDays: e.horizonDays, fill: e.fill }).toEqual({
          ratio: w.ratio,
          samples: w.samples,
          windows: w.windows,
          bias: w.bias,
          prior: w.prior,
          horizonDays: w.horizonDays,
          fill: w.fill,
        });
        expect(e.used).toBeCloseTo(w.used, 12);
        expect(e.sigma).toBeCloseTo(w.sigma, 9);
        expect(e.k).toBeCloseTo(w.k, 9);
      }
    }
    expect(withSamples).toBeGreaterThan(30);
    expect(ordering).toBeGreaterThan(10);
  });

  it("pooledUsed is errorRatio's pooling (and the prior alone without samples)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      let x = seed;
      const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0), x / 2 ** 32);
      const samples = Array.from({ length: 1 + (seed % 13) }, (_, k) => ({ day: addDays(T0, -50 - 7 * k), forecast: 10 * rnd(), actual: 12 * rnd(), model: 0.5 + 3 * rnd() }));
      const P = 7 + (seed % 60);
      const p = 0.5 + rnd();
      const e = errorRatio(samples, P, p);
      const c = { ratio: e.ratio, windows: e.windows, samples: e.samples, bias: e.bias };
      expect(pooledUsed(c, p)).toBeCloseTo(e.used, 12);
      expect(cachedErrorRatio(c, p)).toEqual({ ...e, used: cachedErrorRatio(c, p).used });
    }
    expect(pooledUsed({ ratio: null, windows: 0, samples: 0 }, 1.3)).toBe(1.3);
    expect(errorRatio([], 44, 1.3).used).toBe(1.3);
  });

  it("a variant that sold nothing in 14 months computes the same without its history (the stock read is skipped)", () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const f = facts(seed, { noSales: true });
      const series = f.series(T0);
      const history = f.read(addDays(T0, -427), addDays(T0, -HISTORY_DAYS));
      expect(anySales(series) || anySales(history)).toBe(false);
      if (series.filter((r) => !(r.outOfStock && !(r.sold > 0))).length < 14) continue;
      checked++;
      const input = { ...base(`v${seed}`, T0), series, errorOrigins: errorOriginDays(T0, P).map((day) => ({ day, multiplier: 1 })), errorPrior: prior };
      expect(computeVariant({ ...input, history: null }), `seed ${seed}`).toEqual(computeVariant({ ...input, history }));
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("when the cache is used", () => {
  it("each variant refreshes on one night in seven, spread evenly over the variants", () => {
    const counts = new Array(BACKTEST_CACHE.refreshDays).fill(0);
    for (let i = 0; i < 7000; i++) counts[refreshPhase(`gid://shopify/ProductVariant/${4000000 + i}`)]++;
    for (const n of counts) expect(n).toBeGreaterThan(850);
    for (const id of ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/77"]) {
      const nights = Array.from({ length: 14 }, (_, d) => isRefreshNight(id, addDays(T0, d)));
      expect(nights.filter(Boolean)).toHaveLength(2);
      expect(nights.indexOf(true, nights.indexOf(true) + 1) - nights.indexOf(true)).toBe(7);
    }
  });

  it("history: same scope, at most maxAgeDays old, not the variant's refresh night (but always the night it was written)", () => {
    const id = "gid://shopify/ProductVariant/9";
    const c = { day: T0, scopeKey: "k" };
    expect(historyUsable(null, { variantId: id, today: T0, scopeKey: "k" })).toBe(false);
    expect(historyUsable(c, { variantId: id, today: T0, scopeKey: "other" })).toBe(false);
    expect(historyUsable(c, { variantId: id, today: addDays(T0, -1), scopeKey: "k" })).toBe(false);
    expect(historyUsable(c, { variantId: id, today: addDays(T0, 7), scopeKey: "k" })).toBe(false);
    expect(historyUsable(c, { variantId: id, today: T0, scopeKey: "k" })).toBe(true);
    const nights = Array.from({ length: 7 }, (_, d) => historyUsable(c, { variantId: id, today: addDays(T0, d), scopeKey: "k" }));
    // Usable on every night but its refresh night (at most one of the 6 after the write).
    expect(nights.filter((x) => !x).length).toBeLessThanOrEqual(1);
    for (let d = 1; d <= 6; d++) expect(nights[d]).toBe(!isRefreshNight(id, addDays(T0, d)));
  });

  it("the backtest is reused only for the same horizon, when one ran, and without Plan like", () => {
    expect(backtestReusable({ horizon: 44, backtested: true }, { horizon: 44, planLike: false })).toBe(true);
    expect(backtestReusable({ horizon: 44, backtested: true }, { horizon: 51, planLike: false })).toBe(false);
    expect(backtestReusable({ horizon: 44, backtested: false }, { horizon: 44, planLike: false })).toBe(false);
    expect(backtestReusable({ horizon: 44, backtested: true }, { horizon: 44, planLike: true })).toBe(false);
  });

  it("the scope key moves with the pool, the demand view, the settings and the backfill, not with key order of the pool", () => {
    const k = (x: Partial<Parameters<typeof backtestScopeKey>[0]> = {}) => backtestScopeKey({ pool: ["a", "b"], demand: { locationKey: "all" }, settings: { z: 1.65 }, facts: { sales: ["2025-01-01", []] }, ...x });
    expect(k()).toBe(k({ pool: ["b", "a"] }));
    expect(k()).not.toBe(k({ pool: ["a"] }));
    expect(k()).not.toBe(k({ demand: { locationKey: { in: ["x"] } } }));
    expect(k()).not.toBe(k({ settings: { z: 1.28 } }));
    expect(k()).not.toBe(k({ facts: { sales: ["2024-01-01", []] } }));
    expect(k()).toMatch(/^v1-[0-9a-f]{16}$/);
    // The nightly syncedThrough is not part of it; doneThrough and skipped months are.
    const st = (syncedThrough: string, doneThrough = "2024-10-01") => factsStamp({ datasets: { sales: { doneThrough, syncedThrough, skippedMonths: [] } as never, stock: { doneThrough } as never } });
    expect(st("2026-10-17")).toEqual(st("2026-10-18"));
    expect(st("2026-10-17")).not.toEqual(st("2026-10-17", "2025-01-01"));
  });

  it("the role priors: the week's stored ones, else the stored backtests' ratios in the pre-pass's sample", () => {
    expect(priorsUsable({ day: T0, scopeKey: "k" }, { today: addDays(T0, 6), scopeKey: "k" })).toBe(true);
    expect(priorsUsable({ day: T0, scopeKey: "k" }, { today: addDays(T0, 7), scopeKey: "k" })).toBe(false);
    expect(priorsUsable({ day: T0, scopeKey: "k" }, { today: T0, scopeKey: "x" })).toBe(false);
    const plans = Array.from({ length: 30 }, (_, i) => ({ id: `v${i}` }));
    const roles = new Map(plans.map((p, i) => [p.id, (i < 10 ? "A" : i < 20 ? "B" : "C") as AbcRole]));
    const revenue = new Map(plans.map((p, i) => [p.id, 100 - i]));
    const ratios = new Map(plans.map((p, i) => [p.id, i % 4 === 0 ? null : 0.8 + i / 50]));
    const got = rolePriorsFrom(plans, roles, revenue, ratios, rolePrior)!;
    const roleOf = (r: AbcRole) => plans.filter((p) => roles.get(p.id) === r).map((p) => ratios.get(p.id) ?? null);
    expect(got.get("A")).toBe(rolePrior(roleOf("A")));
    expect(got.get("C")).toBe(rolePrior(roleOf("C")));
    expect(rolePriorsFrom(plans, roles, revenue, new Map(), rolePrior)).toBeNull();
    // A role with too few ratios takes the store's.
    const few = new Map([...ratios].map(([id, r]) => [id, roles.get(id) === "B" && id !== "v11" ? null : r]));
    expect(rolePriorsFrom(plans, roles, revenue, few, rolePrior)!.get("B")).toBe(rolePrior([...few.values()]));
  });
});
