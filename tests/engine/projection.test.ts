/**
 * Day-by-day projection (audit 2026-10-17: H6 status horizon, H3 sales at risk, M2 incoming,
 * negative positions): app/lib/engine/projection-shared.
 */
import { describe, expect, it } from "vitest";
import {
  arrivalsFrom,
  coverDays,
  cumulativeDemand,
  demandProjection,
  flatProjection,
  lostUnits,
} from "../../app/lib/engine/projection-shared";
import { computeVariant, latePurchaseOrders } from "../../app/lib/engine/index-shared";
import { addDays } from "../../app/lib/engine/dates-shared";
import { forwardInputFromMetric, planVariant } from "../../app/lib/engine/forward-plan-shared";
import { whyLines } from "../../app/lib/order-plan-shared";
import { translate } from "../../app/lib/i18n";
import { ago, buildSeries, variantInput } from "./fixtures";

const TODAY = "2026-10-16";

describe("demandProjection", () => {
  it("flat at rate × trend × index without a shape (the old maths)", () => {
    const p = demandProjection({ rate: 2, trend: 1, seasonal: 1.5, horizonDays: 28, days: 10 });
    expect(p.daily).toEqual(new Array(10).fill(3));
    expect(p.tail).toBe(3);
  });

  it("follows the weekly shape, scaled so the order horizon sells what the index says; past the shape: its mean", () => {
    // Index 0.5 for the 14-day horizon; shape 0.25, 0.75, then 2 × 2 weeks.
    const p = demandProjection({ rate: 4, trend: 1, seasonal: 0.5, curve: [0.25, 0.75, 2, 2], horizonDays: 14, days: 40 });
    expect(cumulativeDemand(p, 14)).toBeCloseTo(4 * 0.5 * 14, 9);
    expect(p.daily[0]).toBeCloseTo(1, 9);
    expect(p.daily[20]).toBeCloseTo(8, 9);
    // After 4 weeks: the shape's mean (0.25 + 0.75 + 2 + 2) ÷ 4 = 1.25 → 5/day.
    expect(p.daily[35]).toBeCloseTo(5, 9);
    expect(p.tail).toBeCloseTo(5, 9);
  });
});

describe("coverDays", () => {
  it("flat, nothing incoming → on hand ÷ forecast; 0 at or below 0; Infinity at a zero forecast", () => {
    expect(coverDays(100, flatProjection(2, 10))).toBeCloseTo(50, 12);
    expect(coverDays(0, flatProjection(2))).toBe(0);
    expect(coverDays(-5, flatProjection(2))).toBe(0);
    expect(coverDays(10, flatProjection(0))).toBe(Infinity);
  });

  it("an arrival before the run-out extends the cover; one after it doesn't undo the stock-out", () => {
    const p = flatProjection(2, 60);
    expect(coverDays(20, p, new Map([[5, 30]]))).toBeCloseTo(25, 12);
    expect(coverDays(20, p, new Map([[15, 30]]))).toBeCloseTo(10, 12);
    // A backlog: −10 owed, 30 arrive today → 20 left → 10 days.
    expect(coverDays(-10, p, new Map([[0, 30]]))).toBeCloseTo(10, 12);
  });
});

describe("lostUnits", () => {
  it("out, 10 a day, 300 arriving on day 25: 250 units at risk over 28 days", () => {
    expect(lostUnits(0, flatProjection(10, 28), 28, new Map([[25, 300]]))).toBe(250);
  });
  it("lost demand is not carried; a backlog is filled first", () => {
    expect(lostUnits(5, flatProjection(1, 10), 10)).toBe(5);
    expect(lostUnits(-5, flatProjection(1, 10), 10, new Map([[0, 10]]))).toBe(5);
  });
});

describe("arrivalsFrom", () => {
  it("dated units on their day (overdue → today, capped at incoming), the rest after the lead time", () => {
    const a = arrivalsFrom(TODAY, 50, [{ day: "2026-10-10", units: 20 }, { day: "2026-10-20", units: 20 }], 14);
    expect([...a].sort((x, y) => x[0] - y[0])).toEqual([[0, 20], [4, 20], [14, 10]]);
    expect([...arrivalsFrom(TODAY, 10, [{ day: "2026-10-20", units: 20 }], 14)]).toEqual([[4, 10]]);
    expect([...arrivalsFrom(TODAY, 10, [], null)]).toEqual([[0, 10]]);
  });
});

describe("late purchase orders (accuracy audit 2026-10-18)", () => {
  const base = () => variantInput({ series: buildSeries({ days: 90, sold: (k) => (k % 2 ? 9 : 11) }), onHand: 30, incoming: 200, supplierLeadTimeDays: 30, cycleDays: 14, role: "B" });

  it("an order past its day still lands today, but the plan says it is late and safety holds a week more of demand", () => {
    const onTime = computeVariant({ ...base(), arrivals: [{ day: addDays(TODAY, 5), units: 200 }] })!;
    expect(onTime.inputs.latePo).toBeUndefined();
    const late = computeVariant({ ...base(), arrivals: [{ day: ago(12), units: 200 }] })!;
    // Before: safety 0, order 140, nothing said.
    expect(late.inputs.latePo).toEqual({ days: 12, units: 200, extra: 70 });
    expect(late.safety).toBeCloseTo(70, 9);
    expect(late.orderQty).toBe(210);
    // A day late: one day of demand more.
    expect(computeVariant({ ...base(), arrivals: [{ day: ago(1), units: 200 }] })!.inputs.latePo).toEqual({ days: 1, units: 200, extra: 10 });
    expect(latePurchaseOrders(TODAY, [{ day: ago(3), units: 5 }, { day: ago(9), units: 7 }, { day: TODAY, units: 4 }])).toEqual({ days: 9, units: 12 });
    expect(latePurchaseOrders(TODAY, [])).toBeNull();
  });

  it("Why this quantity says so (from the stored metric), translated", () => {
    const r = computeVariant({ ...base(), arrivals: [{ day: ago(12), units: 200 }] })!;
    const metric = { status: r.status, rate: r.rate, sigma: r.sigma, orderQty: r.orderQty, inputs: JSON.parse(JSON.stringify({ ...r.inputs, safety: r.safety })) };
    const fwd = planVariant(forwardInputFromMetric(metric, { today: TODAY, pack: null, moq: null, notCounted: 0, days: 91 }));
    const why = fwd.orders[0]!.why!;
    expect(why.latePo).toEqual({ days: 12, extra: 70 });
    expect(whyLines(why, (x) => x, "en")).toContain("An open order is 12 days late: counted as arriving now, with 70 more safety while it is late.");
    expect(whyLines({ ...why, latePo: { days: 1, extra: 10 } }, (x) => x, "en")).toContain("An open order is 1 day late: counted as arriving now, with 10 more safety while it is late.");
    expect(whyLines(why, (x) => translate("de", x), "de").join(" ")).toContain("12 Tage zu spät");
  });
});
