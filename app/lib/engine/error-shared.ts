/**
 * Safety stock from the forecast's own past error (forecast quality 2026-10-17, owner-approved B4).
 * Pure.
 *
 * Before: safety = z × σ_daily × √P (P = lead time + order cycle). That assumes the forecast is
 * exactly right on average and each day's sales are independent noise around it. It isn't: the
 * pace is itself estimated from a few weeks, last year's season doesn't repeat exactly, products
 * change level. On a real store the simulated fill landed at 88–91 % against 95 / 90 / 85 %
 * targets (docs/ACCURACY.md).
 *
 * Now, per variant:
 *  1. The model's error over P days (`structuralSigma`): √(P·σ² + P²·Var(pace)) — the daily noise
 *     plus the error of the pace estimate itself (it multiplies all P days, so it grows with P, not
 *     √P). Var(pace) = σ² × Σᵢⱼ wᵢwⱼ ÷ max(nᵢ, nⱼ) over the rate windows used (the windows overlap:
 *     the 28 days are inside the 56 and the 90), σ²/n for a pace from older in-stock days.
 *     σ is at least the Poisson √(daily forecast).
 *  2. The forecast's REAL error (`errorRatio`): a rolling backtest at compute time — up to 13
 *     weekly origins in the last 13 weeks whose P days are all in the past; at each origin the
 *     engine's own pace as of that day (spike cap, windows, level shift, older in-stock days) ×
 *     the seasonal index as of that day, against what sold in the P days (sold-out days left out
 *     on both sides). Each error is divided by the model's error at that origin; ρ² = the mean
 *     of their squares (bias included: a forecast that keeps running low needs more safety).
 *  3. Pooled with the ABC role's ratio (`rolePrior`: the median ratio of up to 200 of the role's
 *     variants, highest revenue first — the store's when a role has fewer than 5; 1 without any):
 *     the origins overlap, so a variant's own backtest is worth n = span ÷ P independent windows
 *     (span = first to last origin + P), at most the count, and the role's counts as 8:
 *     ρ²_used = (n·ρ² + 8·ρ_role²) ÷ (n + 8). On the real store's service simulation the variant's
 *     own ratio alone (13 overlapping weeks) put stock where the error had been, not where it would
 *     be: about one point of fill less for the same stock than the role's ratio (docs/ACCURACY.md).
 *  4. σ_P = ρ_used × structural σ; with a measured supplier lead-time spread, + d²·σ_L² inside the
 *     square root.
 *  5. The safety factor k for the role's FILL target β (the safety level's service level: Balanced
 *     95 / 90 / 85 % by ABC): the expected shortage per order cycle σ_P·G(k) (G = the standard
 *     normal loss function) equals (1 − β) × the demand of one cycle — the textbook fill-rate rule
 *     for a periodic review. k ≥ 0. safety = k × σ_P.
 *  6. Long lead times (accuracy audit 2026-10-18, `longLeadFloor`): for A items k is at least
 *     1.3 × the role's z (owner decision 2026-10-18: 1.5 reached 94.3 % but nearly doubled a long-lead
 *     supplier's order of the week on the simulator; 1.3 gives about 92.9 % for 39 % / 23 % more A stock), ramped in from a 42-day to a 90-day lead time. At a lead time of 75 days
 *     and a 60-day cycle the fill-rate rule gave k ≈ 0–0.5 (the cycle's own stock "covers" the
 *     target on paper), and on the real store's service simulation with late deliveries and supplier
 *     minimums A items reached 90.5 % (lead 90) / 92.7 % (lead 135) against 95 %: their real error at
 *     those horizons runs larger than the backtest measures (fast sellers grow; the forecast lags).
 *     With the floor 94.3 % / 94.3 %, for 58 % / 40 % more A stock (docs/ACCURACY.md). B and C
 *     already overshoot their targets there (minimums, slow sellers): no floor.
 */
import { addDays, dayIndex, type DayKey } from "./dates-shared";

export const FORECAST_ERROR = Object.freeze({
  /** Weekly backtest origins (the last 13 weeks). */
  origins: 13,
  stepDays: 7,
  /** Weight of the prior ratio (the ABC role's pooled ratio, else 1) in independent windows. */
  priorWindows: 8,
  /** Variants per ABC role whose backtests make the role's pooled ratio (highest revenue first). */
  roleSample: 200,
  /** Fewer variants than this with a backtest in a role: the store's pooled ratio stands in. */
  roleMin: 5,
  /** An origin counts when at least this share of its P days was in stock. */
  minInStockShare: 0.6,
  /** Safety factor bounds. */
  maxK: 4,
});

/** k ≥ LONG_LEAD.multiple × z for A items, ramped in from `fromDays` to `fullDays` of lead time. */
export const LONG_LEAD = Object.freeze({ fromDays: 42, fullDays: 90, multiple: 1.3 });

/** The long-lead floor on the safety factor (see the module header, 6); 0 when none applies. */
export function longLeadFloor(role: string, leadDays: number, z: number): number {
  if (role !== "A" || !(leadDays > LONG_LEAD.fromDays) || !(z > 0)) return 0;
  const ramp = Math.min(1, (leadDays - LONG_LEAD.fromDays) / (LONG_LEAD.fullDays - LONG_LEAD.fromDays));
  return LONG_LEAD.multiple * z * ramp;
}

/** The standard normal density and distribution function. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Φ(z), |error| < 1.5e-7 (Abramowitz–Stegun 7.1.26 on erf). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** G(k) = φ(k) − k·(1 − Φ(k)): expected units short per unit of σ with safety k·σ. */
export function normalLoss(k: number): number {
  return normalPdf(k) - k * (1 - normalCdf(k));
}

/** The k with G(k) = g (bisection; G falls from +∞ to 0). */
export function inverseLoss(g: number): number {
  if (!(g > 0)) return FORECAST_ERROR.maxK;
  let lo = -6;
  let hi: number = FORECAST_ERROR.maxK;
  if (normalLoss(hi) >= g) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalLoss(mid) > g) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The safety factor for a fill target β: G(k) = (1 − β) × cycle demand ÷ σ_P, at least 0, at most
 * FORECAST_ERROR.maxK. 0 when there is no error (σ_P = 0) or no cycle demand.
 */
export function fillSafetyFactor(beta: number, cycleDemand: number, sigmaP: number): number {
  if (!(sigmaP > 0) || !(cycleDemand >= 0) || !(beta > 0 && beta < 1)) return 0;
  const g = ((1 - beta) * cycleDemand) / sigmaP;
  return Math.min(FORECAST_ERROR.maxK, Math.max(0, inverseLoss(g)));
}

/** Var(pace) ÷ σ² for the windows used (weights renormalised, overlapping windows). */
export function paceVarianceFactor(windows: readonly { weight: number; inStockDays: number; used: boolean }[]): number | null {
  const ws = windows.filter((w) => w.used && w.inStockDays > 0 && w.weight > 0);
  const W = ws.reduce((a, w) => a + w.weight, 0);
  if (!(W > 0)) return null;
  let v = 0;
  for (const a of ws) for (const b of ws) v += ((a.weight / W) * (b.weight / W)) / Math.max(a.inStockDays, b.inStockDays);
  return v;
}

/** √(P·σ² + P²·f·σ²): the model's error of a P-day forecast (σ = daily σ, f = paceVarianceFactor). */
export function structuralSigma(sigmaDaily: number, P: number, varFactor: number): number {
  const s2 = Math.max(0, sigmaDaily) ** 2;
  return Math.sqrt(Math.max(0, P) * s2 + P * P * Math.max(0, varFactor) * s2);
}

/** The backtest origins for a P-day horizon: today − P − 7k, k = 0 … 12 (newest first). */
export function errorOriginDays(today: DayKey, P: number): DayKey[] {
  const out: DayKey[] = [];
  const p = Math.max(1, Math.round(P));
  for (let k = 0; k < FORECAST_ERROR.origins; k++) out.push(addDays(today, -p - FORECAST_ERROR.stepDays * k));
  return out;
}

export interface ErrorSample {
  day: DayKey;
  /** The forecast for the in-stock days of the window and what they sold. */
  forecast: number;
  actual: number;
  /** The model's error at that origin, for the same days. */
  model: number;
}

export interface ErrorRatio {
  /** √(mean (error ÷ model error)²); null without samples. */
  ratio: number | null;
  /** Shrunk toward 1 (see the module header). */
  used: number;
  /** Independent windows the samples are worth. */
  windows: number;
  samples: number;
  /** Σ(actual − forecast) ÷ Σ forecast over the samples (> 0: the forecast ran low); null without. */
  bias: number | null;
}

/** The role's pooled ratio: the median of the variants' backtest ratios (null below `min` of them). */
export function rolePrior(ratios: readonly (number | null)[], min: number = FORECAST_ERROR.roleMin): number | null {
  const xs = ratios.filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r > 0).sort((a, b) => a - b);
  if (xs.length < Math.max(1, min)) return null;
  const n = xs.length;
  return n % 2 ? xs[(n - 1) / 2]! : (xs[n / 2 - 1]! + xs[n / 2]!) / 2;
}

export function errorRatio(samples: readonly ErrorSample[], P: number, prior = 1): ErrorRatio {
  const ok = samples.filter((s) => s.model > 0 && Number.isFinite(s.forecast) && Number.isFinite(s.actual));
  if (!ok.length) return { ratio: null, used: prior, windows: 0, samples: 0, bias: null };
  const r2 = ok.reduce((a, s) => a + ((s.actual - s.forecast) / s.model) ** 2, 0) / ok.length;
  const days = ok.map((s) => dayIndex(s.day));
  const span = Math.max(...days) - Math.min(...days) + Math.max(1, P);
  const windows = Math.min(ok.length, span / Math.max(1, P));
  const n0 = FORECAST_ERROR.priorWindows;
  const used = Math.sqrt((windows * r2 + n0 * prior * prior) / (windows + n0));
  const f = ok.reduce((a, s) => a + s.forecast, 0);
  const bias = f > 0 ? ok.reduce((a, s) => a + (s.actual - s.forecast), 0) / f : null;
  return { ratio: Math.sqrt(r2), used, windows, samples: ok.length, bias };
}
