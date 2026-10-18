/**
 * Level-shift detection (B5, forecast quality 2026-10-17): a sustained change in the sales level
 * (viral, died) moves the pace to the level since the change; a promotion, noise or a seasonal
 * ramp the season source explains does not. Pinned dates only.
 */
import { describe, expect, it } from "vitest";
import { LEVEL_SHIFT, computeVariant, indexSeries, levelShift } from "../../app/lib/engine/index-shared";
import { forwardInputFromMetric, planVariant } from "../../app/lib/engine/forward-plan-shared";
import { whyLines } from "../../app/lib/order-plan-shared";
import { translate } from "../../app/lib/i18n";
import { ENGINE_DEFAULTS } from "../../app/lib/engine/types-shared";
import { TODAY, ago, buildSeries, variantInput } from "./fixtures";

/** 9, 11, 9, 11 … around a level. */
const around = (level: number, k: number) => level + (k % 2 ? -0.1 * level : 0.1 * level);
const flatLevels = (days: number) => new Map(Array.from({ length: days }, (_, i) => [ago(i + 1), 1]));

describe("levelShift (level-shift-shared)", () => {
  it("went viral: 30 days at 3× the level before → the pace is the new level, from the first day at it", () => {
    // k = days ago: the last 30 days (k 1 … 30) sell 30, the 60 before 10.
    const series = buildSeries({ days: 90, sold: (k) => around(k <= 30 ? 30 : 10, k) });
    const s = levelShift(indexSeries(series, TODAY), TODAY, ENGINE_DEFAULTS.rateWindows, flatLevels(90))!;
    expect(s.day).toBe(ago(30));
    expect(s.ratio).toBeCloseTo(3, 1);
    expect(s.rate).toBeCloseTo(30, 0);
    expect(s.afterDays).toBe(30);
    expect(Math.abs(s.z)).toBeGreaterThanOrEqual(LEVEL_SHIFT.z);
  });

  it("died: the level fell below a third and stayed there for five weeks", () => {
    const series = buildSeries({ days: 90, sold: (k) => around(k <= 35 ? 2 : 12, k) });
    const s = levelShift(indexSeries(series, TODAY), TODAY, ENGINE_DEFAULTS.rateWindows, flatLevels(90))!;
    expect(s.ratio).toBeLessThan(1 / 3);
    expect(s.rate).toBeCloseTo(2, 0);
  });

  it("not a shift: a two-week promotion, a +50 % step, or a step too recent to be sustained", () => {
    const L = flatLevels(90);
    const promo = buildSeries({ days: 90, sold: (k) => around(k > 20 && k <= 34 ? 40 : 10, k) });
    expect(levelShift(indexSeries(promo, TODAY), TODAY, ENGINE_DEFAULTS.rateWindows, L)).toBeNull();
    const half = buildSeries({ days: 90, sold: (k) => around(k <= 40 ? 15 : 10, k) });
    expect(levelShift(indexSeries(half, TODAY), TODAY, ENGINE_DEFAULTS.rateWindows, L)).toBeNull();
    const recent = buildSeries({ days: 90, sold: (k) => around(k <= 20 ? 40 : 10, k) });
    expect(levelShift(indexSeries(recent, TODAY), TODAY, ENGINE_DEFAULTS.rateWindows, L)).toBeNull();
  });

  it("a seasonal ramp the season source explains is not a shift (de-seasonalised by its daily level)", () => {
    const series = buildSeries({ days: 90, sold: (k) => around(k <= 30 ? 30 : 10, k) });
    const ramp = new Map(Array.from({ length: 90 }, (_, i) => [ago(i + 1), i + 1 <= 30 ? 2 : 2 / 3]));
    expect(levelShift(indexSeries(series, TODAY), TODAY, ENGINE_DEFAULTS.rateWindows, ramp)).toBeNull();
  });
});

describe("computeVariant with a level shift", () => {
  const viral = buildSeries({ days: 90, sold: (k) => around(k <= 30 ? 30 : 10, k) });

  it("uses the new level as the pace and records the shift; σ over the days since it", () => {
    const base = computeVariant(variantInput({ series: viral }))!;
    const r = computeVariant(variantInput({ series: viral, levels: flatLevels(90) }))!;
    // Without levels nothing is detected (a ramp can't be told from a shift): the blended pace.
    expect(base.inputs.levelShift).toBeNull();
    expect(base.rate!).toBeLessThan(25);
    expect(r.inputs.levelShift).toMatchObject({ day: ago(30), afterDays: 30 });
    expect(r.rate!).toBeCloseTo(30, 0);
    expect(r.sigma!).toBeLessThan(base.sigma!);
    // Off: settings levelShiftZ 0.
    expect(computeVariant(variantInput({ series: viral, levels: flatLevels(90), settings: { levelShiftZ: 0 } }))!.inputs.levelShift).toBeNull();
  });

  it("the Why says so: 'Sales stepped up on {date}; using the recent level.' (and dropped), translated", () => {
    const r = computeVariant(variantInput({ series: viral, levels: flatLevels(90), onHand: 5 }))!;
    const input = forwardInputFromMetric({ status: r.status, rate: r.rate, sigma: r.sigma, orderQty: r.orderQty, inputs: { ...r.inputs, safety: r.safety } }, { today: TODAY, pack: null, moq: null, notCounted: 0, days: 7 });
    const why = planVariant(input).orders[0]!.why!;
    expect(why.levelShift).toEqual({ day: ago(30), ratio: r.inputs.levelShift!.ratio });
    const lines = whyLines(why, (x) => x, "en");
    expect(lines).toContain(`Sales stepped up on ${new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${ago(30)}T12:00:00Z`))}; using the recent level.`);
    expect(whyLines({ ...why, levelShift: { day: ago(30), ratio: 0.2 } }, (x) => translate("de", x), "de").some((l) => l.startsWith("Die Verkäufe sind am"))).toBe(true);
  });
});

describe("no seasonal index yet: drops are tested on the raw sales (accuracy audit 2026-10-18)", () => {
  // 10 a day, then 1 a day for the last 34 days; 300 days of history, under 13 months (no index).
  const all = buildSeries({ days: 300, sold: (k) => (k <= 34 ? 1 : k % 2 ? 9 : 11) });
  const split = { series: all.filter((r) => r.day >= ago(90)), history: all.filter((r) => r.day < ago(90)), onHand: 20, role: "B" as const };

  it("a product falling from 10 to 1 a day is planned at 1 a day (before: 3.18 a day, order 64)", () => {
    const before = computeVariant(variantInput(split))!; // no seasonKnown: as before
    expect(before.rate!).toBeCloseTo(3.18, 2);
    expect(before.orderQty).toBe(64);
    expect(before.inputs.levelShift).toBeNull();
    const now = computeVariant(variantInput({ ...split, seasonKnown: false }))!;
    expect(now.rate!).toBeCloseTo(1, 9);
    expect(now.orderQty).toBe(12);
    expect(now.inputs.levelShift).toMatchObject({ day: ago(34), before: 10, after: 1, afterDays: 34 });
    // With a seasonal index but no levels (the old rule): nothing.
    expect(computeVariant(variantInput({ ...split, seasonKnown: true }))!.inputs.levelShift).toBeNull();
  });

  it("a step UP is not taken from raw sales (a season or Black Friday can't be told from a new level)", () => {
    const up = buildSeries({ days: 300, sold: (k) => (k <= 34 ? 30 : k % 2 ? 9 : 11) });
    const r = computeVariant(variantInput({ series: up.filter((x) => x.day >= ago(90)), history: up.filter((x) => x.day < ago(90)), seasonKnown: false }))!;
    expect(r.inputs.levelShift).toBeNull();
  });
});
