/**
 * Safety stock from the forecast's own past error (B4, forecast quality 2026-10-17): the model's
 * P-day error, the rolling backtest's ratio of real to model error, the fill-rate safety factor.
 * Pinned dates only.
 */
import { describe, expect, it } from "vitest";
import {
  FORECAST_ERROR,
  LONG_LEAD,
  longLeadFloor,
  computeVariant,
  errorOriginDays,
  errorRatio,
  fillSafetyFactor,
  inverseLoss,
  normalCdf,
  normalLoss,
  paceVarianceFactor,
  rolePrior,
  structuralSigma,
} from "../../app/lib/engine/index-shared";
import { forwardInputFromMetric, planVariant } from "../../app/lib/engine/forward-plan-shared";
import { whyLines } from "../../app/lib/order-plan-shared";
import { translate } from "../../app/lib/i18n";
import { TODAY, ago, buildSeries, variantInput } from "./fixtures";

describe("the fill-rate safety factor (error-shared)", () => {
  it("normal CDF and loss function match their tables; the inverse loss inverts", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.6449)).toBeCloseTo(0.95, 4);
    expect(normalLoss(0)).toBeCloseTo(0.3989, 4);
    expect(normalLoss(1)).toBeCloseTo(0.0833, 4);
    expect(normalLoss(2)).toBeCloseTo(0.0085, 4);
    for (const k of [-1, 0, 0.5, 1.3, 2.5]) expect(inverseLoss(normalLoss(k))).toBeCloseTo(k, 6);
  });

  it("G(k) = (1 − β) × cycle demand ÷ σ: a longer cycle needs less safety for the same fill; never below 0", () => {
    // β 95 %, 14 days at 10/day, σ 30 → G = 0.05 × 140 ÷ 30 = 0.2333 → k ≈ 0.40.
    const k = fillSafetyFactor(0.95, 140, 30);
    expect(normalLoss(k)).toBeCloseTo((0.05 * 140) / 30, 9);
    expect(fillSafetyFactor(0.95, 600, 30)).toBe(0); // G target above G(0): no safety needed
    expect(fillSafetyFactor(0.95, 70, 30)).toBeGreaterThan(k);
    expect(fillSafetyFactor(0.95, 140, 0)).toBe(0);
    expect(fillSafetyFactor(0.99, 140, 30)).toBeGreaterThan(k);
  });

  it("the model's P-day error: daily noise × √P plus the pace's own error × P (overlapping windows)", () => {
    const vf = paceVarianceFactor([
      { weight: 0.5, inStockDays: 28, used: true },
      { weight: 0.3, inStockDays: 56, used: true },
      { weight: 0.2, inStockDays: 90, used: true },
    ])!;
    // Σᵢⱼ wᵢwⱼ ÷ max(nᵢ, nⱼ): 0.25/28 + 0.09/56 + 0.04/90 + 2 × (0.15/56 + 0.1/90 + 0.06/90).
    expect(vf).toBeCloseTo(0.25 / 28 + 0.09 / 56 + 0.04 / 90 + 2 * (0.15 / 56 + 0.1 / 90 + 0.06 / 90), 12);
    expect(structuralSigma(2, 28, vf)).toBeCloseTo(Math.sqrt(28 * 4 + 28 * 28 * vf * 4), 12);
    // Long lead times: the pace error grows with P, not √P.
    expect(structuralSigma(2, 120, vf) / structuralSigma(2, 28, vf)).toBeGreaterThan(Math.sqrt(120 / 28));
  });

  it("the backtest ratio: RMS of error ÷ model error, worth span ÷ P windows, pooled with the role's ratio (8 windows)", () => {
    const days = errorOriginDays(TODAY, 28);
    expect(days).toHaveLength(FORECAST_ERROR.origins);
    expect(days[0]).toBe(ago(28));
    expect(days[12]).toBe(ago(28 + 84));
    const samples = days.map((day) => ({ day, forecast: 100, actual: 130, model: 10 }));
    const r = errorRatio(samples, 28);
    expect(r.ratio).toBeCloseTo(3, 12);
    expect(r.windows).toBeCloseTo((84 + 28) / 28, 12);
    expect(r.used).toBeCloseTo(Math.sqrt((4 * 9 + 8 * 1) / 12), 12);
    expect(errorRatio(samples, 28, 2).used).toBeCloseTo(Math.sqrt((4 * 9 + 8 * 4) / 12), 12);
    expect(r.bias).toBeCloseTo(0.3, 12);
    expect(errorRatio([], 28)).toMatchObject({ ratio: null, used: 1, samples: 0 });
    // A variant without a backtest (young, planned like another) takes the role's ratio.
    expect(errorRatio([], 28, 1.7).used).toBe(1.7);
  });

  it("the role's pooled ratio is the median of its variants' ratios; too few → null (the store's stands in)", () => {
    expect(rolePrior([1, 2, 3, null, 10, 4])).toBe(3);
    expect(rolePrior([1, 2, 3, 4, 5, 6])).toBe(3.5);
    expect(rolePrior([2, 3, null])).toBeNull();
    expect(rolePrior([2, 3], 2)).toBe(2.5);
  });
});

describe("computeVariant: safety from the forecast's own error", () => {
  /** 13 weeks of origins over a 300-day history: the P days from each are in the past. */
  const origins = (P: number) => errorOriginDays(TODAY, P).map((day) => ({ day, multiplier: 1 }));
  const steady = buildSeries({ days: 300, sold: (k) => (k % 2 ? 9 : 11) });
  // A product whose sales swing month to month (5 / 15 every 30 days): the pace keeps missing.
  const swinging = buildSeries({ days: 300, sold: (k) => (Math.floor(k / 30) % 2 ? 5 : 15) + (k % 2 ? -1 : 1) });
  const split = (rows: typeof steady) => ({ series: rows.filter((r) => r.day >= ago(90)), history: rows.filter((r) => r.day < ago(90)) });

  it("a steady seller: the backtest finds the model about right (ρ ≈ 1); safety = k × σ_P for the role's fill target", () => {
    const r = computeVariant(variantInput({ ...split(steady), role: "A", onHand: 200, errorOrigins: origins(28) }))!;
    const e = r.inputs.error!;
    expect(e.horizonDays).toBe(28);
    expect(e.samples).toBe(13);
    expect(e.ratio!).toBeLessThan(1.5);
    expect(e.fill).toBeCloseTo(normalCdf(1.65), 9);
    expect(e.k).toBeCloseTo(fillSafetyFactor(e.fill, r.forecastRate! * 14, e.sigma), 9);
    expect(r.safety).toBeCloseTo(e.k * e.sigma, 9);
  });

  it("a product the pace keeps missing gets more safety than the model alone gives it", () => {
    const withBacktest = computeVariant(variantInput({ ...split(swinging), role: "A", onHand: 200, errorOrigins: origins(28) }))!;
    const modelOnly = computeVariant(variantInput({ ...split(swinging), role: "A", onHand: 200 }))!;
    expect(withBacktest.inputs.error!.ratio!).toBeGreaterThan(2);
    expect(modelOnly.inputs.error!.ratio).toBeNull();
    expect(withBacktest.safety!).toBeGreaterThan(modelOnly.safety!);
    // The role's pooled ratio moves every variant of the role the same way.
    const pooled = computeVariant(variantInput({ ...split(swinging), role: "A", onHand: 200, errorPrior: 2 }))!;
    expect(pooled.inputs.error).toMatchObject({ prior: 2, used: 2 });
    expect(pooled.safety!).toBeGreaterThan(modelOnly.safety!);
  });

  it("higher fill targets (Safe) hold more; a measured lead-time spread adds d²σL²; the old model stays selectable", () => {
    const base = variantInput({ ...split(swinging), onHand: 200, errorOrigins: origins(28) });
    const lean = computeVariant({ ...base, settings: { z: { A: 1.04, B: 0.84, C: 0.67 } } })!;
    const safe = computeVariant({ ...base, settings: { z: { A: 2.05, B: 1.65, C: 1.28 } } })!;
    expect(safe.safety!).toBeGreaterThan(lean.safety!);
    const late = computeVariant({ ...base, leadTimeSigmaDays: 5 })!;
    expect(late.inputs.error!.sigma).toBeCloseTo(Math.sqrt(computeVariant(base)!.inputs.error!.sigma ** 2 + (late.forecastRate! * 5) ** 2), 9);
    const old = computeVariant({ ...base, settings: { safetyModel: "sigma" } })!;
    expect(old.inputs.error).toBeNull();
    expect(old.safety).toBeCloseTo(1.28 * old.sigma! * Math.sqrt(28), 9);
  });

  it("Why this quantity says what the safety covers, from the stored inputs", () => {
    const r = computeVariant(variantInput({ ...split(swinging), role: "A", onHand: 20, errorOrigins: origins(28) }))!;
    const input = forwardInputFromMetric({ status: r.status, rate: r.rate, sigma: r.sigma, orderQty: r.orderQty, inputs: { ...r.inputs, safety: r.safety } }, { today: TODAY, pack: null, moq: null, notCounted: 0, days: 1 });
    const why = planVariant(input).orders[0]!.why!;
    expect(why.safetyBasis).toEqual({ days: 28, error: r.inputs.error!.sigma, fill: r.inputs.error!.fill });
    const line = whyLines(why, (x) => x, "en").find((l) => l.startsWith("Safety "))!;
    expect(line).toBe(`Safety ${Math.round(r.safety!)}: the forecast's own error over 28 days (± ${Math.round(r.inputs.error!.sigma)}) for a 95 % fill target.`);
    expect(whyLines(why, (x) => translate("de", x), "de").some((l) => l.includes("Lieferquote"))).toBe(true);
  });
});

describe("long lead times: a safety floor for A items (accuracy audit 2026-10-18)", () => {
  it("longLeadFloor: 1.5 × z for A, ramped in from 42 to 90 days of lead time; none for B / C or short leads", () => {
    expect(LONG_LEAD).toEqual({ fromDays: 42, fullDays: 90, multiple: 1.5 });
    expect(longLeadFloor("A", 14, 1.65)).toBe(0);
    expect(longLeadFloor("A", 42, 1.65)).toBe(0);
    expect(longLeadFloor("A", 66, 1.65)).toBeCloseTo(1.5 * 1.65 * 0.5, 12);
    expect(longLeadFloor("A", 90, 1.65)).toBeCloseTo(2.475, 12);
    expect(longLeadFloor("A", 135, 1.65)).toBeCloseTo(2.475, 12);
    expect(longLeadFloor("B", 135, 1.28)).toBe(0);
    expect(longLeadFloor("C", 135, 1.04)).toBe(0);
  });

  it("lead 75 + cycle 60 on 1,350 units of demand: the fill-rate rule alone gave k 0 and no safety; an A item now keeps k 1.70", () => {
    const at = (role: "A" | "B") => computeVariant(variantInput({ series: buildSeries({ days: 90, sold: (k) => (k % 2 ? 8 : 12) }), role, supplierLeadTimeDays: 75, cycleDays: 60, onHand: 0 }))!;
    const a = at("A");
    expect(a.forecastRate! * 135).toBeCloseTo(1350, 6);
    expect(a.inputs.error!.k).toBeCloseTo(1.5 * 1.65 * (33 / 48), 9);
    expect(a.inputs.error!.floor).toBe(true);
    expect(a.safety!).toBeCloseTo(a.inputs.error!.k * a.inputs.error!.sigma, 9);
    expect(a.safety!).toBeGreaterThan(100);
    // B: the fill-rate rule's k (0 here), no floor.
    const b = at("B");
    expect(b.inputs.error!.k).toBe(0);
    expect(b.inputs.error!.floor).toBeUndefined();
    // Short lead times are untouched.
    const short = computeVariant(variantInput({ series: buildSeries({ days: 90, sold: (k) => (k % 2 ? 8 : 12) }), role: "A", supplierLeadTimeDays: 14, cycleDays: 14, onHand: 0 }))!;
    expect(short.inputs.error!.floor).toBeUndefined();
  });
});
