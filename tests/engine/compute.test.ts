/**
 * computeVariant (spec §7.2–§7.5): one variant × scope end to end, with pinned dates.
 */
import { describe, expect, it } from "vitest";
import { computeVariant } from "../../app/lib/engine/index-shared";
import { TODAY, ago, buildSeries, variantInput } from "./fixtures";

/** Alternating 1, 3 → rate 2 in every window, population σ 1. */
const alternating = buildSeries({ days: 90, sold: (k) => (k % 2 ? 1 : 3), price: 25 });

describe("computeVariant", () => {
  it("M3: stores the day the current out-of-stock spell began (outSince), from sales history", () => {
    // Out (ended at ≤ 0) the last 6 days, in stock before.
    const series = buildSeries({ days: 90, sold: (k) => (k <= 6 ? 0 : 2), oos: (k) => k <= 6, endStock: (k) => (k <= 6 ? 0 : 10) });
    expect(computeVariant(variantInput({ series, onHand: -3 }))!.inputs.outSince).toBe(ago(6));
    // Yesterday in stock: not out (it ran out today or isn't out): no date.
    expect(computeVariant(variantInput({ series: alternating, onHand: 0 }))!.inputs.outSince).toBeNull();
    // A day without data ends the search at the earliest known day of the spell.
    const gap = buildSeries({ days: 90, sold: 0, oos: (k) => k <= 10, missing: (k) => k === 4 });
    expect(computeVariant(variantInput({ series: gap, onHand: 0 }))!.inputs.outSince).toBe(ago(3));
  });

  it("returns null for bundles", () => {
    expect(computeVariant(variantInput({ isBundle: true }))).toBeNull();
  });

  it("computes rate, σ, safety, days left, order qty and order-by", () => {
    const r = computeVariant(
      variantInput({
        series: alternating,
        role: "A",
        onHand: 40,
        incoming: 10,
        supplierLeadTimeDays: 16,
        caseQty: 6,
      }),
    )!;
    expect(r.rate).toBeCloseTo(2, 12);
    expect(r.sigma).toBeCloseTo(1, 12);
    // H4: safety covers lead time + order cycle (periodic review): 1.65 × σ 1 × √(16 + 14).
    // The old √lead (16) gave 6.6 — too little for a store that orders every 14 days.
    expect(r.safety).toBeCloseTo(1.65 * Math.sqrt(30), 12); // 9.04
    expect(r.safetyDays).toBeCloseTo((1.65 * Math.sqrt(30)) / 2, 12); // ÷ the daily forecast
    expect(r.daysLeft).toBeCloseTo(20, 12);
    // M2: the 10 on order (undated → land after the 16-day lead time) arrive before the run-out
    // on day 20 → cover 16 + (8 + 10) ÷ 2 = 25 ≥ 16 + 4.52 → not running low.
    expect(r.coverDays).toBeCloseTo(25, 12);
    expect(r.status).toBe("healthy");
    // ceil(2 × 30 + 9.04 − 50) = 20 → case of 6 → 24.
    expect(r.orderQty).toBe(24);
    // floor(25 − 16 − 4.52) = 4.
    expect(r.orderBy).toBe(ago(-4));
    expect(r.inputs).toMatchObject({
      leadTimeDays: 16,
      leadTimeSource: "supplier",
      cycleDays: 14,
      z: 1.65,
      inStockDays: 90,
      enoughData: true,
      price: 25,
      priceSource: "series",
    });
    expect(r.inputs.windows.map((w) => w.used)).toEqual([true, true, true]);
  });

  it("raises the order to the minimum order in whole cases", () => {
    const r = computeVariant(
      variantInput({ series: alternating, role: "A", onHand: 40, incoming: 10, supplierLeadTimeDays: 16, caseQty: 6, minOrder: 20 }),
    )!;
    expect(r.orderQty).toBe(24);
  });

  it("M2: running low unless an order lands before the run-out (dated arrivals)", () => {
    // 40 on hand at 2/day → runs out on day 20; lead 16 + safety 4.52.
    const base = variantInput({ series: alternating, role: "A", onHand: 40, supplierLeadTimeDays: 16 });
    expect(computeVariant(base)!.status).toBe("running_low");
    // 30 arriving on day 10 (before the run-out): cover 35 → not running low.
    const early = computeVariant({ ...base, incoming: 30, arrivals: [{ day: ago(-10), units: 30 }] })!;
    expect(early.coverDays).toBeCloseTo(35, 12);
    expect(early.status).toBe("healthy");
    // The same 30 arriving on day 25 (after the run-out): still running low.
    const late = computeVariant({ ...base, incoming: 30, arrivals: [{ day: ago(-25), units: 30 }] })!;
    expect(late.coverDays).toBeCloseTo(20, 12);
    expect(late.status).toBe("running_low");
  });

  it("H6: days left follow the seasonal shape — a January low is not 'Too much', pre-peak overstock is", () => {
    // 2/day now; the index for the next 28 days is 0.4 (January), then the year returns to normal.
    const jan = [0.4, 0.4, 0.4, 0.4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const v = variantInput({ onHand: 300, supplierLeadTimeDays: 14, seasonal: 0.4, seasonCurve: jan });
    // Old maths: 300 ÷ (2 × 0.4) = 375 days → Too much. Day by day: 4 weeks at 0.8, then 2/day.
    const r = computeVariant(v)!;
    expect(r.daysLeft).toBeCloseTo(28 + (300 - 28 * 0.8) / 2, 9); // 166.8
    expect(r.status).toBe("healthy");
    // Before a peak (index 3 for the next 4 weeks, then 0.5): 600 units look like 100 days (old
    // maths: 600 ÷ (2 × 3)) but the peak sells 168 and the rest lasts far beyond 180 days.
    const peak = [3, 3, 3, 3, ...new Array(24).fill(0.5)];
    const pre = computeVariant(variantInput({ onHand: 600, supplierLeadTimeDays: 14, seasonal: 3, seasonCurve: peak }))!;
    expect(pre.daysLeft!).toBeGreaterThan(180);
    expect(pre.status).toBe("too_much");
    // No shape: flat at the index (the old maths, exactly).
    expect(computeVariant(variantInput({ onHand: 100, seasonal: 2 }))!.daysLeft).toBe(25);
  });

  it("negative on hand (oversold): Out, 0 days left, the order covers the backlog, no NaN", () => {
    const r = computeVariant(variantInput({ series: alternating, onHand: -12, incoming: 0, supplierLeadTimeDays: 14 }))!;
    expect(r.status).toBe("out");
    expect(r.daysLeft).toBe(0);
    expect(r.coverDays).toBe(0);
    // A negative available is evidence of backorders (data audit #1): the 12 are owed.
    expect(r.inputs.sellsWhenOut).toBe(true);
    const flat = computeVariant(variantInput({ series: alternating, onHand: 0, incoming: 0, supplierLeadTimeDays: 14, sellsWhenOut: true }))!;
    // 12 more than with 0 on hand (both owing what they sell while out).
    expect(r.inputs.orderNeed! - flat.inputs.orderNeed!).toBeCloseTo(12, 12);
    expect(r.orderQty! - flat.orderQty!).toBe(12);
    for (const x of [r.daysLeft, r.coverDays, r.safety, r.safetyDays, r.orderQty, r.inputs.orderNeed]) expect(Number.isNaN(x)).toBe(false);
  });

  it("running_low when days left < lead time + safety days", () => {
    const r = computeVariant(
      variantInput({ series: alternating, role: "A", onHand: 38, supplierLeadTimeDays: 16 }),
    )!;
    expect(r.daysLeft).toBeCloseTo(19, 12);
    expect(r.status).toBe("running_low");
  });

  it("uses the shop default lead time and settings overrides", () => {
    const r = computeVariant(variantInput({ settings: { leadTimeDays: 30 } }))!;
    expect(r.inputs).toMatchObject({ leadTimeDays: 30, leadTimeSource: "default" });
  });

  it("a stock-out window does not change the result's rate", () => {
    const base = computeVariant(variantInput())!;
    const withOut = computeVariant(
      variantInput({ series: buildSeries({ days: 90, sold: (k) => (k <= 15 ? 0 : 2), oos: (k) => k <= 15 }) }),
    )!;
    expect(withOut.rate).toBe(base.rate);
    expect(withOut.outOfStockDays).toBe(15);
  });

  it("not_enough_data: rate returned, no order advice, no days left", () => {
    const r = computeVariant(variantInput({ series: buildSeries({ days: 10, sold: 2 }) }))!;
    expect(r.status).toBe("not_enough_data");
    expect(r.rate).toBe(2);
    expect(r.orderQty).toBeNull();
    expect(r.orderBy).toBeNull();
    expect(r.daysLeft).toBeNull();
    expect(r.safety).toBeNull();
  });

  it("out wins over dead; days left 0; order advice still given with enough data", () => {
    const noSales = buildSeries({ days: 120, sold: 0 });
    const r = computeVariant(variantInput({ series: noSales, onHand: 0 }))!;
    expect(r.status).toBe("out");
    expect(r.daysLeft).toBe(0);
    // rate 0 → demand 0, safety 0 → nothing to order.
    expect(r.orderQty).toBeNull();
  });

  it("dead needs the product to be ≥ 90 days old", () => {
    const noSales = buildSeries({ days: 120, sold: 0 });
    const old = computeVariant(variantInput({ series: noSales, onHand: 30, productCreatedAt: ago(120) }))!;
    const young = computeVariant(variantInput({ series: noSales, onHand: 30, productCreatedAt: ago(60) }))!;
    const unknown = computeVariant(variantInput({ series: noSales, onHand: 30, productCreatedAt: null }))!;
    expect(old.status).toBe("dead");
    // Rate 0 → days left Infinity → too much.
    expect(young.status).toBe("too_much");
    expect(young.daysLeft).toBe(Infinity);
    expect(young.orderBy).toBeNull();
    expect(unknown.status).toBe("too_much");
  });

  it("dead: last sale exactly 90 days ago is not dead; 91 days ago is", () => {
    const at90 = buildSeries({ days: 120, sold: (k) => (k === 90 ? 1 : 0) });
    const at91 = buildSeries({ days: 120, sold: (k) => (k === 91 ? 1 : 0) });
    expect(computeVariant(variantInput({ series: at90, onHand: 5 }))!.inputs.noSaleDays).toBe(89);
    expect(computeVariant(variantInput({ series: at90, onHand: 5 }))!.status).not.toBe("dead");
    expect(computeVariant(variantInput({ series: at91, onHand: 5 }))!.status).toBe("dead");
  });

  it("M3: Dead counts in-stock days only — a product sold out for weeks is not 'not selling'", () => {
    // No sale for 120 days, but sold out (0 units, nothing sold) for the last 40 of them.
    const series = buildSeries({ days: 120, sold: (k) => (k === 120 ? 1 : 0), oos: (k) => k <= 40 });
    const r = computeVariant(variantInput({ series, onHand: 30 }))!;
    expect(r.inputs.noSaleCalendarDays).toBe(119);
    expect(r.inputs.noSaleDays).toBe(79);
    expect(r.status).not.toBe("dead");
    // The same 120 days all in stock: dead.
    expect(computeVariant(variantInput({ series: buildSeries({ days: 120, sold: (k) => (k === 120 ? 1 : 0) }), onHand: 30 }))!.status).toBe("dead");
  });

  it("M3: off season — it sold in the coming weeks last year → not Dead, not Too much", () => {
    const noSales = buildSeries({ days: 120, sold: 0 });
    const dead = computeVariant(variantInput({ series: noSales, onHand: 30, soldLastYearAhead: 0 }))!;
    expect(dead.status).toBe("dead");
    const off = computeVariant(variantInput({ series: noSales, onHand: 30, soldLastYearAhead: 45 }))!;
    expect(off.status).toBe("healthy");
    expect(off.inputs).toMatchObject({ offSeason: true, soldLastYearAhead: 45 });
    // Unknown last year (null): the old rule.
    expect(computeVariant(variantInput({ series: noSales, onHand: 30, soldLastYearAhead: null }))!.status).toBe("dead");
    // A slow seller with a year of stock that sold in these weeks last year: not Too much either.
    expect(computeVariant(variantInput({ onHand: 1000, soldLastYearAhead: 10 }))!.status).toBe("healthy");
    expect(computeVariant(variantInput({ onHand: 1000 }))!.status).toBe("too_much");
  });

  it("'Don't reorder' variants keep stock and status but get no order quantity or order-by date", () => {
    const r = computeVariant(variantInput({ series: alternating, onHand: 10, supplierLeadTimeDays: 14, noReorder: true }))!;
    expect(r.status).toBe("running_low");
    expect(r.daysLeft).toBeCloseTo(5, 12);
    expect(r).toMatchObject({ orderQty: null, orderBy: null });
    expect(r.inputs).toMatchObject({ orderNeed: null, noReorder: true });
  });

  it("dead is not claimed when the data covers less than 90 days, unless a last sale is known", () => {
    const short = buildSeries({ days: 60, sold: 0 });
    expect(computeVariant(variantInput({ series: short, onHand: 30 }))!.status).toBe("too_much");
    const known = computeVariant(variantInput({ series: short, onHand: 30, lastSaleDay: ago(200) }))!;
    expect(known.status).toBe("dead");
    expect(known.inputs.lastSaleDay).toBe(ago(200));
  });

  it("never sold: dataSinceDay starts the no-sale period beyond the series (deadDays > 90)", () => {
    const noSales = buildSeries({ days: 90, sold: 0 });
    const settings = { deadDays: 180 };
    // Only the 90-day series: 90 no-sale days < 180 → not dead.
    const short = computeVariant(variantInput({ series: noSales, onHand: 30, settings }))!;
    expect(short.inputs.noSaleDays).toBe(90);
    expect(short.status).not.toBe("dead");
    // Stock data since 200 days ago and no sale ever → 200 no-sale days → dead.
    const long = computeVariant(variantInput({ series: noSales, onHand: 30, settings, dataSinceDay: ago(200) }))!;
    expect(long.inputs.noSaleDays).toBe(200);
    expect(long.inputs.dataSinceDay).toBe(ago(200));
    expect(long.status).toBe("dead");
    // A later dataSinceDay than the series never shortens it.
    expect(computeVariant(variantInput({ series: noSales, onHand: 30, settings, dataSinceDay: ago(10) }))!.inputs.noSaleDays).toBe(90);
    // A known sale wins over dataSinceDay.
    const sold = computeVariant(variantInput({ series: noSales, onHand: 30, settings, dataSinceDay: ago(400), lastSaleDay: ago(100) }))!;
    expect(sold.inputs.noSaleDays).toBe(99);
    expect(sold.inputs.dataSinceDay).toBeNull();
  });

  it("too_much only when trend is not rising", () => {
    const flat = computeVariant(variantInput({ onHand: 1000 }))!;
    const rising = computeVariant(variantInput({ onHand: 1000, trend: 1.2 }))!;
    expect(flat.daysLeft).toBe(500);
    expect(flat.status).toBe("too_much");
    expect(rising.daysLeft).toBeCloseTo(1000 / 2.4, 9);
    expect(rising.status).toBe("healthy");
  });

  it("seasonal and trend scale days left; plan scales only the order", () => {
    const base = computeVariant(variantInput({ onHand: 100 }))!;
    const seasonal = computeVariant(variantInput({ onHand: 100, seasonal: 2 }))!;
    // Sells when out of stock: the order covers everything sold over lead time + cycle.
    const plan = computeVariant(variantInput({ onHand: 10, plan: 2, sellsWhenOut: true }))!;
    const planBase = computeVariant(variantInput({ onHand: 10, sellsWhenOut: true }))!;
    expect(base.daysLeft).toBe(50);
    expect(seasonal.daysLeft).toBe(25);
    expect(plan.daysLeft).toBe(planBase.daysLeft);
    // σ 0 → safety 0. demand(28) = 56 vs 112.
    expect(planBase.orderQty).toBe(46);
    expect(plan.orderQty).toBe(102);
    // Doesn't sell when out (default): the sales missed before the order lands (14 days: 28 − 10,
    // ×2 with the plan) are lost, not ordered back.
    expect(computeVariant(variantInput({ onHand: 10 }))!.orderQty).toBe(46 - 18);
    expect(computeVariant(variantInput({ onHand: 10, plan: 2 }))!.orderQty).toBe(102 - 46);
  });

  it("price: input wins, else sold-weighted series price; cost: input wins, else latest row", () => {
    const series = buildSeries({
      days: 90,
      sold: (k) => (k <= 45 ? 3 : 1),
      price: (k) => (k <= 45 ? 10 : 20),
      cost: (k) => (k === 1 ? 6 : 4),
    });
    const derived = computeVariant(variantInput({ series }))!;
    expect(derived.price).toBeCloseTo((135 * 10 + 45 * 20) / 180, 12);
    expect(derived.cost).toBe(6);
    expect(derived.inputs).toMatchObject({ priceSource: "series", costSource: "series" });
    const given = computeVariant(variantInput({ series, price: 30, cost: 12 }))!;
    expect(given).toMatchObject({ price: 30, cost: 12 });
    const none = computeVariant(variantInput())!;
    expect(none).toMatchObject({ price: null, cost: null });
    expect(none.inputs).toMatchObject({ priceSource: null, costSource: null });
  });
});
