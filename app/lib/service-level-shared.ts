/**
 * The safety level as merchants read it (merchant audit 2026-10-18: the product page showed the raw
 * z, "Safety level 1.65"): the in-stock target — the chance of not running out before the next
 * delivery — Φ(z) as a whole percent (z 1.65 → 95 %, 1.28 → 90 %, 1.04 → 85 %). Pure, client-safe.
 */

/** Standard normal CDF Φ(x) (Abramowitz & Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** z → in-stock target in whole percent (50–99); null when z is unknown. */
export function inStockTargetPct(z: number | null | undefined): number | null {
  if (typeof z !== "number" || !Number.isFinite(z)) return null;
  return Math.min(99, Math.max(50, Math.round(normalCdf(z) * 100)));
}
