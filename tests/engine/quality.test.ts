/**
 * Forecast quality (R4): spike capping, partial days, σ on de-seasonalised demand, "Plan like…"
 * for new styles, bundles counted on their components, and the Why lines. Pinned dates only.
 */
import { describe, expect, it } from "vitest";
import { computeVariant } from "../../app/lib/engine/index-shared";
import { SPIKE_CAP, applyCap, cappedSince, robustCap, spikeBursts, spikeCap } from "../../app/lib/engine/outliers-shared";
import { PLAN_LIKE_DAYS, ownWeight } from "../../app/lib/engine/new-style-shared";
import { indexSeries, sigmaDaily, windowStats } from "../../app/lib/engine/rate-shared";
import { dailyLevels } from "../../app/lib/engine/season-shared";
import { forwardInputFromMetric, planVariant, spikesWhy } from "../../app/lib/engine/forward-plan-shared";
import { buildSeries as buildFacts } from "../../app/lib/compute-shared";
import { whyLines } from "../../app/lib/order-plan-shared";
import { translate } from "../../app/lib/i18n";
import { addDays } from "../../app/lib/engine/dates-shared";
import { TODAY, ago, buildSeries, variantInput } from "./fixtures";

/** 9, 11, 9, 11 … → median 10, MAD 1, mean 10. */
const steady = (k: number) => (k % 2 ? 9 : 11);

describe("robustCap / spikeCap (outliers-shared)", () => {
  it("cap = median + k × max(1.4826 × MAD, √mean); too few days or k ≤ 0 → none", () => {
    const xs = Array.from({ length: 20 }, (_, i) => steady(i + 1));
    // MAD 1 → 1.4826 < √10 = 3.162: the Poisson floor wins.
    expect(robustCap(xs, 4)).toBeCloseTo(10 + 4 * Math.sqrt(10), 9);
    const wide = Array.from({ length: 20 }, (_, i) => (i % 2 ? 0 : 20));
    // median 10, MAD 10 → 14.826 > √10.
    expect(robustCap(wide, 4)).toBeCloseTo(10 + 4 * 14.826, 9);
    expect(robustCap(xs.slice(0, SPIKE_CAP.minDays - 1), 4)).toBeNull();
    expect(robustCap(xs, 0)).toBeNull();
  });

  it("a slow seller is not capped to nothing: at 0.3 a day the cap is ≈ 2.2 (4 × √0.3)", () => {
    const xs = Array.from({ length: 30 }, (_, i) => (i % 10 < 3 ? 1 : 0));
    expect(robustCap(xs, 4)).toBeCloseTo(4 * Math.sqrt(0.3), 9);
  });

  it("one 300-unit day among 10s is capped; sold-out and partial days never set or take the cap; off → none", () => {
    const series = buildSeries({ days: 90, sold: (k) => (k === 20 ? 300 : k === 30 ? 0 : steady(k)), oos: (k) => k === 30 });
    const index = indexSeries(series, TODAY);
    const r = spikeCap(index, TODAY, { k: 4 });
    expect(r.cap).toBeGreaterThan(20);
    expect(r.cap).toBeLessThan(25);
    expect(r.capped).toEqual([{ day: ago(20), sold: 300, cap: r.cap }]);
    const capped = applyCap(index, r.cap);
    expect(capped.get([...index.entries()].find(([, x]) => x.day === ago(20))![0])!.sold).toBe(r.cap);
    // The real rows are untouched.
    expect(series.find((x) => x.day === ago(20))!.sold).toBe(300);
    expect(spikeCap(index, TODAY, { off: true })).toEqual({ cap: null, capped: [], days: new Set(), recurring: null });
    expect(cappedSince(r.capped, TODAY, 10)).toEqual([]);
    expect(cappedSince(r.capped, TODAY, 30)).toHaveLength(1);
  });
});

describe("one-off or recurring (accuracy audit 2026-10-18)", () => {
  const split = (all: ReturnType<typeof buildSeries>) => ({ series: all.filter((r) => r.day >= ago(90)), history: all.filter((r) => r.day < ago(90)) });

  it("two 300-unit wholesale days on a 2-a-day product with 150 days of history are capped (before: pace 11.8, order 606)", () => {
    const all = buildSeries({ days: 150, sold: (k) => (k === 10 || k === 40 ? 300 : 2) });
    const r = computeVariant(variantInput({ ...split(all), onHand: 20, role: "A" }))!;
    // Before (top 1 % rule: 1 day allowed in 150, 2 above → the cap rose to 300): 11.84 a day, order 606.
    expect(r.inputs.spikes.count).toBe(2);
    expect(r.inputs.spikes.recurring).toBeUndefined();
    expect(r.rate!).toBeCloseTo(2.39, 2);
    expect(r.orderQty).toBe(42);
  });

  it("five 300-unit orders a year: the order no longer swings with how many fall in the last 90 days (before: 602 vs 431)", () => {
    const orderFor = (ks: number[]) => {
      const all = buildSeries({ days: 427, sold: (k) => (ks.includes(k) ? 300 : 2) });
      return computeVariant(variantInput({ ...split(all), onHand: 20, role: "A" }))!;
    };
    const two = orderFor([10, 80, 153, 226, 299, 372]); // two inside the 90 days
    const none = orderFor([50, 123, 196, 269, 342, 415]); // one inside the 90 days
    for (const r of [two, none]) {
      // ≈ 5 × 298 ÷ 365 a day added back, the high days themselves capped in the windows.
      // Each order's units above its own weeks' level (a 2-a-day product: ≈ 292 of 300).
      expect(r.inputs.spikes.recurring!.perDay).toBeGreaterThan((5 * 285) / 365);
      expect(r.inputs.spikes.recurring!.perDay).toBeLessThan((5 * 300) / 365);
      expect(r.inputs.spikes.recurring).toMatchObject({ days: 6, months: 6, inStockDays: 365 });
    }
    expect(two.orderQty).toBe(93);
    expect(none.orderQty).toBe(90);
    // The forward plan's Why carries the yearly average from the stored metric.
    const metric = { status: two.status, rate: two.rate, sigma: two.sigma, orderQty: two.orderQty, inputs: JSON.parse(JSON.stringify({ ...two.inputs, safety: two.safety })) };
    const fwd = planVariant(forwardInputFromMetric(metric, { today: TODAY, pack: null, moq: null, notCounted: 0, days: 91 }));
    expect(fwd.orders[0]!.why!.recurringSpikes).toBeCloseTo(two.inputs.spikes.recurring!.perDay, 9);
  });

  it("promotion days every 50 days are recurring: capped in the windows, their units above the cap added back over the year", () => {
    const series = buildSeries({ days: 300, sold: (k) => (k % 50 === 7 ? 40 : steady(k)) });
    const index = indexSeries(series, TODAY);
    const robust = robustCap(Array.from({ length: 90 }, (_, i) => series[i]!.sold))!;
    const r = spikeCap(index, TODAY);
    expect(r.cap).toBeCloseTo(robust, 9);
    expect(r.capped.map((c) => c.sold)).toEqual([40, 40, 40, 40, 40, 40]);
    // Each promotion's units above its own weeks' level (here the same robust cap as today's).
    expect(r.recurring!.perDay).toBeCloseTo((6 * (40 - robust)) / 300, 1);
    expect(r.recurring).toMatchObject({ days: 6, inStockDays: 300 });
  });

  it("a single wholesale day, or high days in only two months, are one-offs", () => {
    const one = spikeCap(indexSeries(buildSeries({ days: 300, sold: (k) => (k === 20 ? 300 : steady(k)) }), TODAY), TODAY);
    const wholesale = buildSeries({ days: 300, sold: (k) => (k === 20 ? 300 : steady(k)) });
    expect(one.cap).toBeCloseTo(robustCap(wholesale.slice(0, 90).map((x) => x.sold))!, 9);
    expect(one.capped.map((c) => c.sold)).toEqual([300]);
    expect(one.recurring).toBeNull();
    // Four high days, two in each of two months: still one-offs.
    const two = spikeCap(indexSeries(buildSeries({ days: 300, sold: (k) => ([20, 25, 140, 145].includes(k) ? 60 : steady(k)) }), TODAY), TODAY);
    expect(two.capped).toHaveLength(4);
    expect(two.recurring).toBeNull();
  });

  it("a long run of high days (a season, a new level) is neither capped nor recurring: only bursts of ≤ 7 days are spikes", () => {
    // 20 strong days in a row in three different stretches (Black Friday into December): seasons.
    const peak = (k: number) => (k >= 100 && k < 120) || (k >= 200 && k < 220) || (k >= 280 && k < 300);
    const r = spikeCap(indexSeries(buildSeries({ days: 300, sold: (k) => (peak(k) ? 40 : k === 30 ? 60 : steady(k)) }), TODAY), TODAY);
    expect(r.capped.map((c) => c.day)).toEqual([ago(30)]);
    expect(r.recurring).toBeNull();
    const rows = applyCap(indexSeries(buildSeries({ days: 300, sold: (k) => (peak(k) ? 40 : k === 30 ? 60 : steady(k)) }), TODAY), r.cap, r.days);
    expect([...rows.values()].filter((x) => x.sold === 40)).toHaveLength(60);
    expect(spikeBursts([1, 2, 4, 9, 10])).toEqual([[1, 2, 4], [9, 10]]);
  });

  it("last winter's season adds nothing back: a recurring burst counts only what is above its own weeks", () => {
    // Coats: ~30 a day (noisy, with dips) from 200 to 330 days ago, 3 a day now. Against the summer
    // cap the winter's short runs between dips are "recurring spikes"; against their own weeks they
    // are not high, so nothing is added to the pace (without the own-level floor: 5.3 a day).
    const winter = (k: number) => k >= 200 && k <= 330;
    const sold = (k: number) => (winter(k) ? (k % 9 < 3 ? 8 : 30 + (k % 5)) : k % 2 ? 2 : 4);
    const r = spikeCap(indexSeries(buildSeries({ days: 427, sold }), TODAY), TODAY);
    expect(r.cap!).toBeLessThan(15);
    expect(r.recurring).toMatchObject({ months: 5, perDay: 0 });
  });

  it("computeVariant reads the older months (history) for the rule: the promotions keep their units in the pace", () => {
    const sold = (k: number) => (k % 50 === 7 ? 40 : steady(k));
    const all = buildSeries({ days: 300, sold });
    const only90 = computeVariant(variantInput({ series: all.filter((r) => r.day >= ago(90)) }))!;
    const withHistory = computeVariant(variantInput(split(all)))!;
    // 2 promotion days inside the 90 (k = 7, 57): with 90 days only they are one-offs (2 days).
    expect(only90.inputs.spikes.recurring).toBeUndefined();
    // The history shows 6 in 6 months: recurring, the year's average added back.
    expect(withHistory.inputs.spikes.recurring!.days).toBe(6);
    expect(withHistory.rate!).toBeCloseTo(only90.rate! + withHistory.inputs.spikes.recurring!.perDay, 9);
  });
});

describe("partial days and σ (rate-shared)", () => {
  it("a day it ran out counts at least at the pace of the full days; σ leaves it out", () => {
    const rows = buildSeries({ days: 28, sold: (k) => (k === 5 ? 2 : 10) });
    rows.find((r) => r.day === ago(5))!.partial = true;
    const index = indexSeries(rows, TODAY);
    const st = windowStats(index, TODAY, 28);
    expect(st.inStockDays).toBe(28);
    expect(st.soldInStock).toBe(27 * 10 + 10); // the partial 2 counts as the full days' 10
    expect(sigmaDaily(index, TODAY, 28)).toBe(0);
    // A partial day that sold MORE than the pace keeps what it sold.
    rows.find((r) => r.day === ago(5))!.sold = 14;
    expect(windowStats(indexSeries(rows, TODAY), TODAY, 28).soldInStock).toBe(27 * 10 + 14);
  });

  it("with seasonal levels σ is measured on de-seasonalised demand: a seasonal ramp is not noise", () => {
    const level = (k: number) => 0.5 + k / 90; // a steady ramp
    const rows = buildSeries({ days: 90, sold: (k) => 10 * level(k) });
    const index = indexSeries(rows, TODAY);
    const levels = new Map(rows.map((r, i) => [r.day, level(i + 1)]));
    expect(sigmaDaily(index, TODAY, 90)!).toBeGreaterThan(2);
    expect(sigmaDaily(index, TODAY, 90, levels)!).toBeCloseTo(0, 9);
  });

  it("dailyLevels: a flat store is level 1 every day; a store twice as busy lately is above 1 there", () => {
    const units = new Map<string, number>();
    for (let k = 1; k <= 200; k++) units.set(ago(k), 100);
    const flat = dailyLevels({ units, coverage: { from: ago(200), to: ago(1) } }, TODAY, 90);
    expect(flat.size).toBeGreaterThan(60);
    for (const v of flat.values()) expect(v).toBeCloseTo(1, 9);
    for (let k = 1; k <= 30; k++) units.set(ago(k), 200);
    const busy = dailyLevels({ units, coverage: { from: ago(200), to: ago(1) } }, TODAY, 90);
    expect(busy.get(ago(60))!).toBeLessThan(1);
    // Mean 1 over the days it has.
    const vals = [...busy.values()];
    expect(vals.reduce((a, b) => a + b, 0) / vals.length).toBeCloseTo(1, 9);
  });
});

describe("computeVariant: spikes, Don't cap, levels, Plan like", () => {
  const spiky = buildSeries({ days: 90, sold: (k) => (k === 10 ? 300 : steady(k)) });

  it("a one-off 300-unit day no longer lifts the pace; Don't cap restores the raw figure", () => {
    const capped = computeVariant(variantInput({ series: spiky }))!;
    const raw = computeVariant(variantInput({ series: spiky, noCap: true }))!;
    // 28-day window: raw (27 × 10 + 300 - …) vs capped.
    expect(raw.rate!).toBeGreaterThan(capped.rate! + 4);
    expect(capped.rate!).toBeCloseTo(10.5, 0);
    expect(capped.inputs.spikes).toMatchObject({ count: 1, off: false });
    expect(capped.inputs.spikes!.days[0]).toMatchObject({ day: ago(10), sold: 300 });
    expect(raw.inputs.spikes).toEqual({ cap: null, days: [], count: 0, off: true });
    expect(capped.sigma!).toBeLessThan(raw.sigma! / 5);
    // k = 0 in the settings switches capping off for the store (not "Don't cap": off stays false).
    const storeOff = computeVariant(variantInput({ series: spiky, settings: { spikeCapK: 0 } }))!;
    expect(storeOff.rate).toBeCloseTo(raw.rate!, 12);
    expect(storeOff.inputs.spikes!.off).toBe(false);
  });

  it("levels: σ de-seasonalised then scaled by the seasonal index (sigmaSeasonal)", () => {
    const level = (k: number) => 0.5 + k / 90;
    const series = buildSeries({ days: 90, sold: (k) => Math.round(10 * level(k)) });
    const levels = new Map(series.map((r, i) => [r.day, level(i + 1)]));
    const plain = computeVariant(variantInput({ series }))!;
    const ds = computeVariant(variantInput({ series, levels, seasonal: 1.5 }))!;
    expect(ds.inputs.sigmaSeasonal).toBe(true);
    expect(plain.inputs.sigmaSeasonal).toBe(false);
    expect(ds.sigma!).toBeLessThan(plain.sigma!);
    // Golden-fixture case: a steady seller in a group that filled up during the window (its level
    // ramps from almost nothing). ÷ level would inflate σ; the raw σ stays.
    const flat = buildSeries({ days: 90, sold: (k) => (k % 2 ? 1 : 2) });
    const ramp = new Map(flat.map((r, i) => [r.day, Math.max(0.06, 1.4 - (i + 1) / 40)]));
    const kept = computeVariant(variantInput({ series: flat, levels: ramp, seasonal: 1.2 }))!;
    expect(kept.inputs.sigmaSeasonal).toBe(false);
    expect(kept.sigma).toBeCloseTo(computeVariant(variantInput({ series: flat }))!.sigma!, 12);
  });

  it("levels are bounded to 0.5 … 2: a group that sold almost nothing early in the window", () => {
    const units = new Map<string, number>();
    for (let k = 1; k <= 200; k++) units.set(ago(k), k > 80 ? 1 : 100);
    const lv = dailyLevels({ units, coverage: { from: ago(200), to: ago(1) } }, TODAY, 90);
    expect(Math.min(...lv.values())).toBe(0.5);
    expect(Math.max(...lv.values())).toBeLessThanOrEqual(2);
  });

  it("Plan like: w = own in-stock days ÷ 28 of its own pace, the rest the reference; advice before 14 days", () => {
    expect(PLAN_LIKE_DAYS).toBe(28);
    expect(ownWeight(7)).toBe(0.25);
    expect(ownWeight(40)).toBe(1);
    expect(ownWeight(Number.NaN)).toBe(0);
    // Launched 7 days ago, sells 2 a day; planned like a product selling 6 a day.
    const series = buildSeries({ days: 7, sold: 2 });
    const young = variantInput({ series, productCreatedAt: ago(7) });
    const alone = computeVariant(young)!;
    expect(alone.inputs.enoughData).toBe(false);
    expect(alone.orderQty).toBeNull();
    const like = { rate: 6, kind: "product" as const, name: "Parka", pct: 100, share: 1 };
    const r = computeVariant({ ...young, planLike: like })!;
    expect(r.rate).toBeCloseTo(0.25 * 2 + 0.75 * 6, 12);
    expect(r.sigma).toBeCloseTo(Math.sqrt(5), 12);
    expect(r.inputs.planLike).toMatchObject({ name: "Parka", weight: 0.75, ownDays: 7, ownRate: 2 });
    expect(r.safety).not.toBeNull();
    // 28+ in-stock days: its own pace only (the choice is ignored).
    const grown = computeVariant(variantInput({ series: buildSeries({ days: 90, sold: 2 }), planLike: like }))!;
    expect(grown.rate).toBeCloseTo(2, 12);
    expect(grown.inputs.planLike).toBeNull();
  });

  it("the forward plan's Why reads the capped days and the plan-like reference from the metric", () => {
    const r = computeVariant(variantInput({ series: spiky, supplierLeadTimeDays: 14, onHand: 0 }))!;
    const metric = { status: r.status, rate: r.rate, sigma: r.sigma, orderQty: r.orderQty, inputs: { ...r.inputs, safety: r.safety } };
    const fwd = planVariant(forwardInputFromMetric(metric, { today: TODAY, pack: null, moq: null, notCounted: 0, days: 91 }));
    expect(fwd.orders[0]!.why).toMatchObject({ spikes: { count: 1, day: ago(10), sold: 300 }, planLike: null });
    // Planned like another product: the Why names it with the style's own days.
    const young = computeVariant(variantInput({ series: buildSeries({ days: 7, sold: 2 }), productCreatedAt: ago(7), onHand: 0, planLike: { rate: 6, kind: "product", name: "Parka", pct: 80, share: 1 } }))!;
    const m2 = { status: young.status, rate: young.rate, sigma: young.sigma, orderQty: young.orderQty, inputs: { ...young.inputs, safety: young.safety } };
    const f2 = planVariant(forwardInputFromMetric(m2, { today: TODAY, pack: null, moq: null, notCounted: 0, days: 91 }));
    expect(f2.orders[0]!.why).toMatchObject({ planLike: { kind: "product", name: "Parka", pct: 80, days: 7 } });
    expect(spikesWhy({ count: 3, days: [{ day: "2026-03-14", sold: 300, cap: 22 }, { day: "2026-04-01", sold: 40, cap: 22 }] })).toEqual({ count: 3, day: "2026-03-14", sold: 300, cap: 22 });
    expect(spikesWhy({ days: [] })).toBeNull();
    expect(spikesWhy(null)).toBeNull();
  });
});

describe("Why this quantity (R4 lines)", () => {
  const why = { day: 0, days: 28, demand: 56, rate: 2, season: 1, growth: 1, safety: 10, onHand: 5, onOrder: 3, need: 58, rounded: 58, pack: null, moq: null, topUp: 0 };
  const t = (x: string) => x;
  it("1 unusual day capped (14 Mar: 300 units); n days with the largest; Based on {product}", () => {
    expect(whyLines({ ...why, spikes: { count: 1, day: "2026-03-14", sold: 300, cap: 22.4 } }, t, "en")).toContain("1 unusual day capped (Mar 14: 300 units, counted as 22)");
    expect(whyLines({ ...why, spikes: { count: 3, day: "2026-03-14", sold: 300, cap: 22 } }, t, "en")).toContain("3 unusual days capped (largest Mar 14: 300 units, counted as 22)");
    expect(whyLines({ ...why, planLike: { kind: "product", name: "Parka", pct: 80, days: 6 } }, t, "en")).toContain("Based on Parka at 80 % until this product has 28 days in stock (now 6).");
    expect(whyLines({ ...why, planLike: { kind: "productType", name: "Jackets", pct: 100, days: 0 } }, t, "en")).toContain(
      "Based on the median Jackets product at 100 % until this product has 28 days in stock (now 0).",
    );
    expect(whyLines({ ...why, spikes: { count: 1, day: "2026-03-14", sold: 300, cap: 22 } }, (x) => translate("de", x), "de").join(" ")).toContain("1 ungewöhnlicher Tag begrenzt");
    // Recurring high days (accuracy audit 2026-10-18): the yearly average added back to the pace.
    expect(whyLines({ ...why, recurringSpikes: 3.92 }, t, "en")).toContain("High days that come back (promotions, repeat orders) count as 3.9 a day over the year.");
    expect(whyLines({ ...why, recurringSpikes: 3.92 }, (x) => translate("de", x), "de").join(" ")).toContain("zählen als 3,9 pro Tag");
  });
});

describe("buildSeries (compute-shared): the day it ran out is partial", () => {
  it("out with sales after an in-stock day → partial; out with sales after an out day (backorders) → full day", () => {
    const d = (k: number) => addDays(TODAY, -k);
    const stock = [3, 2, 1].map((k) => ({ variantId: "v", day: d(k), endUnits: k === 3 ? 5 : 0, reported: 1, outReported: k === 3 ? 0 : 1 }));
    const sales = [3, 2, 1].map((k) => ({ variantId: "v", day: d(k), sold: 4, gross: 0 }));
    const rows = buildFacts(sales, stock).get("v")!;
    expect(rows.map((r) => [r.day, r.outOfStock, r.partial === true])).toEqual([
      [d(3), false, false],
      [d(2), false, true],
      [d(1), false, false],
    ]);
  });
});
