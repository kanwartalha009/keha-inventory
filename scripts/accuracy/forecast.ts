/**
 * Forecast backtest on the frozen dataset: the app's REAL engine (computeVariant →
 * cumulativeDemand over H days) at many as-of days ("cutoffs"), each seeing only the days before
 * it, against what really sold, and against two baselines:
 *  - naive: the last 28 days' mean × H (from the launch for a younger variant);
 *  - seasonal naive: the same H days 364 days earlier (weekdays aligned); a variant younger than
 *    that falls back to naive (counted in `snaiveFallback`).
 * WAPE = Σ|F − A| ÷ ΣA, bias = Σ(F − A) ÷ ΣA (negative: too low). A variant-cutoff where the
 * engine gives no forecast is left out of every method.
 *
 * Cutoff sets (`mode`):
 *  - rolling: every 28 days from 2025-10-06 (the R4 / 2026-10-17 grid), split into TUNE (horizon
 *    ends before the hold-out period) and HOLD-OUT;
 *  - holdout: weekly cutoffs whose whole horizon lies in the last HOLDOUT_DAYS days of the data —
 *    with `strict` no engine parameter may be changed (the run refuses overrides);
 *  - random: `samples` random (cutoff, variant) pairs, cutoffs uniform over the whole history (also
 *    before the seasonal index exists), variants drawn among those selling for 28 days by then —
 *    not only the cutoffs on a grid and not only today's view of the catalogue.
 */
import { computeVariant, cumulativeDemand, type EngineSettings, type VariantInput } from "../../app/lib/engine/index-shared";
import { rng, rowsFor, seasonContextAt, type Dataset, type Variant } from "./data";

export const HORIZONS = [28, 56, 90] as const;
/** The hold-out: the last 120 days (2026-06-19 … 2026-10-16 on the committed data). */
export const HOLDOUT_DAYS = 120;
export const ROLLING_FROM = "2025-10-06";

export type Mode = "rolling" | "holdout" | "random";

export interface ForecastOptions {
  mode: Mode;
  strict?: boolean;
  horizons?: readonly number[];
  /** Engine settings overrides (refused with `strict`). */
  settings?: Partial<EngineSettings>;
  /** Extra computeVariant input (refused with `strict`). */
  engine?: Partial<VariantInput>;
  /** Pretend the store is young: only the last `historyDays` days before each cutoff exist. */
  historyDays?: number;
  samples?: number;
  seed?: number;
}

export interface Agg {
  n: number;
  actual: number;
  keha: { ae: number; e: number };
  naive: { ae: number; e: number };
  snaive: { ae: number; e: number };
  snaiveFallback: number;
}

export type Report = Record<number, { cutoffs: number; skipped: number; groups: Record<string, Agg> }>;

const emptyAgg = (): Agg => ({ n: 0, actual: 0, keha: { ae: 0, e: 0 }, naive: { ae: 0, e: 0 }, snaive: { ae: 0, e: 0 }, snaiveFallback: 0 });

export function wape(a: Agg, m: "keha" | "naive" | "snaive"): number {
  return a.actual > 0 ? (100 * a[m].ae) / a.actual : NaN;
}
export function bias(a: Agg, m: "keha" | "naive" | "snaive"): number {
  return a.actual > 0 ? (100 * a[m].e) / a.actual : NaN;
}

/** Season contexts per (cutoff, history start): every variant at a cutoff shares one. */
function seasonCache(ds: Dataset) {
  const m = new Map<string, ReturnType<typeof seasonContextAt>>();
  return (T: number, from: number) => {
    const k = `${T}|${from}`;
    let c = m.get(k);
    if (!c) m.set(k, (c = seasonContextAt(ds, T, from)));
    return c;
  };
}

export function engineForecast(ds: Dataset, v: Variant, T: number, H: number, o: Pick<ForecastOptions, "settings" | "engine" | "historyDays"> = {}, season = seasonCache(ds)) {
  const floor = o.historyDays ? Math.max(0, T - o.historyDays) : 0;
  const ctx = season(T, floor);
  const s = ctx.forVariant([], H);
  const older = rowsFor(ds, v, T - 427, T - 91, { floor });
  const r = computeVariant({
    id: v.id,
    series: rowsFor(ds, v, T - 90, T - 1, { floor }),
    olderSeries: older,
    history: older,
    today: ds.dayOf(T),
    onHand: 100000,
    incoming: 0,
    role: v.role,
    supplierLeadTimeDays: H - 14,
    cycleDays: 14,
    seasonal: s.seasonal,
    trend: s.trend,
    seasonCurve: ctx.curveFor(s, Math.ceil((H + 200) / 7)),
    levels: ctx.levelsFor(s, 90),
    seasonKnown: s.seasonalResult.applied,
    settings: o.settings ?? null,
    ...(o.engine ?? {}),
  } as VariantInput);
  if (!r || r.rate === null || !r.projection || (!r.inputs.enoughData && !r.inputs.pace)) return null;
  return { f: cumulativeDemand(r.projection, H), r, seasonApplied: s.seasonalResult.applied };
}

export function naiveForecast(v: Variant, T: number, H: number, floor = 0): number {
  const from = Math.max(T - 28, v.launch, floor);
  let s = 0;
  for (let i = from; i < T; i++) s += v.sold[i]!;
  const days = T - from;
  return days > 0 ? Math.max(0, (s / days) * H) : 0;
}

export function seasonalNaive(v: Variant, T: number, H: number, floor = 0): number | null {
  if (v.launch > T - 364 || T - 364 < floor) return null;
  let s = 0;
  for (let i = T - 364; i < T - 364 + H; i++) s += v.sold[i]!;
  return Math.max(0, s);
}

export function actualUnits(v: Variant, T: number, H: number): number {
  let s = 0;
  for (let i = T; i < T + H; i++) s += v.sold[i]!;
  return s;
}

/** Cutoffs per horizon for a mode, each tagged with the groups it counts in. */
export function cutoffs(ds: Dataset, mode: Mode, H: number): { T: number; tag: string }[] {
  const hs = ds.days - HOLDOUT_DAYS;
  if (mode === "holdout") {
    const out: { T: number; tag: string }[] = [];
    for (let T = hs; T + H <= ds.days; T += 7) out.push({ T, tag: "hold" });
    return out;
  }
  const out: { T: number; tag: string }[] = [];
  for (let T = ds.idxOf(ROLLING_FROM); T + H <= ds.days; T += 28) out.push({ T, tag: T + H <= hs ? "tune" : T >= hs ? "hold" : "overlap" });
  return out;
}

export function runForecast(ds: Dataset, o: ForecastOptions): Report {
  if (o.strict && (o.settings || o.engine || o.historyDays)) throw new Error("strict hold-out: engine parameters can't be changed");
  const season = seasonCache(ds);
  const report: Report = {};
  for (const H of o.horizons ?? HORIZONS) {
    const groups: Record<string, Agg> = {};
    let skipped = 0;
    const add = (keys: string[], f: number, nf: number, sf: number | null, a: number) => {
      for (const k of keys) {
        const g = (groups[k] ??= emptyAgg());
        g.n++;
        g.actual += a;
        g.keha.ae += Math.abs(f - a);
        g.keha.e += f - a;
        g.naive.ae += Math.abs(nf - a);
        g.naive.e += nf - a;
        const s = sf ?? nf;
        if (sf === null) g.snaiveFallback++;
        g.snaive.ae += Math.abs(s - a);
        g.snaive.e += s - a;
      }
    };
    const pairs: { T: number; v: Variant; tag: string }[] = [];
    let ncut = 0;
    if (o.mode === "random") {
      const rand = rng(o.seed ?? 1);
      const want = o.samples ?? 400;
      const lo = 120;
      const hi = ds.days - H;
      const ts = new Set<number>();
      for (let tries = 0; pairs.length < want && tries < want * 50; tries++) {
        const T = lo + Math.floor(rand() * (hi - lo + 1));
        const pool = ds.variants.filter((v) => v.launch <= T - 28);
        if (!pool.length) continue;
        const v = pool[Math.floor(rand() * pool.length)]!;
        ts.add(T);
        pairs.push({ T, v, tag: T >= ds.days - HOLDOUT_DAYS ? "hold" : "before-hold" });
      }
      ncut = ts.size;
    } else {
      const cs = cutoffs(ds, o.mode, H);
      ncut = cs.length;
      for (const { T, tag } of cs) for (const v of ds.variants) if (v.launch < T) pairs.push({ T, v, tag });
    }
    const floorOf = (T: number) => (o.historyDays ? Math.max(0, T - o.historyDays) : 0);
    for (const { T, v, tag } of pairs) {
      const e = engineForecast(ds, v, T, H, o, season);
      if (!e) {
        skipped++;
        continue;
      }
      const a = actualUnits(v, T, H);
      const keys = ["all", v.role, tag];
      if (o.mode === "random") keys.push(e.seasonApplied ? "season known" : "season unknown");
      add(keys, e.f, naiveForecast(v, T, H, floorOf(T)), seasonalNaive(v, T, H, floorOf(T)), a);
    }
    report[H] = { cutoffs: ncut, skipped, groups };
  }
  return report;
}

export function formatReport(r: Report, title: string): string {
  const lines = [title];
  const order = ["all", "A", "B", "C", "tune", "overlap", "before-hold", "hold", "season known", "season unknown"];
  for (const [H, x] of Object.entries(r)) {
    lines.push(`H = ${H} days · ${x.cutoffs} cutoffs · ${x.skipped} without a forecast`);
    lines.push("  group           n   Keha WAPE  bias  | naive WAPE  bias  | seasonal-naive WAPE  bias (fallback)");
    for (const k of order) {
      const g = x.groups[k];
      if (!g) continue;
      const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1).padStart(6) : "     —");
      lines.push(
        `  ${k.padEnd(14)} ${String(g.n).padStart(4)}  ${f(wape(g, "keha"))} ${f(bias(g, "keha"))} | ${f(wape(g, "naive"))} ${f(bias(g, "naive"))} | ${f(wape(g, "snaive"))} ${f(bias(g, "snaive"))} (${g.snaiveFallback})`,
      );
    }
  }
  return lines.join("\n");
}
