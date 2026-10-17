/**
 * Sales per day while in stock and σ (spec §7.2, §7.4), plus day math.
 */
import { describe, expect, it } from "vitest";
import { addDays, dayIndex, daysBetween, toDayKey } from "../../app/lib/engine/dates-shared";
import {
  earliestDataDay,
  indexSeries,
  lastSaleDay,
  salesRate,
  sigmaDaily,
  soldOutDay,
} from "../../app/lib/engine/rate-shared";
import type { DailyRow } from "../../app/lib/engine/types-shared";
import { TODAY, ago, buildSeries } from "./fixtures";

const rateOf = (rows: DailyRow[]) => salesRate(indexSeries(rows, TODAY), TODAY);

describe("dates", () => {
  it("adds days across month, year and leap day", () => {
    expect(addDays("2026-10-16", 16)).toBe("2026-11-01");
    expect(addDays("2026-12-25", 20)).toBe("2027-01-14");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
  });
  it("rejects malformed and impossible days; normalises ISO datetimes", () => {
    expect(() => dayIndex("2026-2-1")).toThrow();
    expect(() => dayIndex("2026-02-30")).toThrow();
    expect(toDayKey("2026-03-04T23:59:00Z")).toBe("2026-03-04");
    expect(() => toDayKey("yesterday")).toThrow();
  });
});

describe("salesRate", () => {
  it("constant sales give that rate in every window", () => {
    const r = rateOf(buildSeries({ days: 90, sold: 2 }));
    expect(r.rate).toBe(2);
    expect(r.windows.map((w) => w.rate)).toEqual([2, 2, 2]);
    expect(r.inStockDays).toBe(90);
    expect(r.enoughData).toBe(true);
  });

  it("a stock-out window does not lower the rate", () => {
    const base = rateOf(buildSeries({ days: 90, sold: 2 }));
    // Days 1–20 sold out: no sales at all.
    const withOut = rateOf(
      buildSeries({
        days: 90,
        sold: (k) => (k <= 20 ? 0 : 2),
        oos: (k) => k <= 20,
      }),
    );
    expect(withOut.rate).toBeCloseTo(base.rate!, 12);
    expect(withOut.outOfStockDays).toBe(20);
    expect(withOut.inStockDays).toBe(70);
  });

  it("H1: an out-of-stock day that still sold (backorders) is an in-stock day", () => {
    // Audit 2026-10-17: a continue-selling store ended 30 of the last 90 days at ≤ 0 units and
    // still sold 2 a day on them. Old rule: 30 sold-out days, their sales thrown away.
    const r = rateOf(buildSeries({ days: 90, sold: 2, endStock: (k) => (k <= 30 ? -5 : 10), oos: (k) => k <= 30 }));
    expect(r.outOfStockDays).toBe(0);
    expect(r.inStockDays).toBe(90);
    expect(r.rate).toBe(2);
    // A big backorder day is real demand and counts.
    const spike = rateOf(buildSeries({ days: 90, sold: (k) => (k === 5 ? 50 : 2), oos: (k) => k === 5 }));
    expect(spike.windows[0]!.soldInStock).toBe(27 * 2 + 50);
  });

  it("H1: only out of stock AND nothing sold is a sold-out day", () => {
    expect(soldOutDay({ outOfStock: true, sold: 0 })).toBe(true);
    expect(soldOutDay({ outOfStock: true, sold: -1 })).toBe(true);
    expect(soldOutDay({ outOfStock: true, sold: 1 })).toBe(false);
    expect(soldOutDay({ outOfStock: false, sold: 0 })).toBe(false);
    // A top seller that is "out" most days but keeps selling still gets a forecast (≥ 14 in-stock days).
    const r = rateOf(buildSeries({ days: 90, sold: 3, oos: (k) => k % 10 !== 0 }));
    expect(r.enoughData).toBe(true);
    expect(r.rate).toBe(3);
  });

  it("missing days are not zeros", () => {
    const full = rateOf(buildSeries({ days: 90, sold: 3 }));
    const deleted = rateOf(buildSeries({ days: 90, sold: 3, missing: (k) => k >= 10 && k <= 30 }));
    const zeroed = rateOf(buildSeries({ days: 90, sold: (k) => (k >= 10 && k <= 30 ? 0 : 3) }));
    expect(deleted.rate).toBe(full.rate);
    expect(deleted.dataDays).toBe(69);
    expect(zeroed.rate!).toBeLessThan(full.rate!);
  });

  it("weights 0.5/0.3/0.2 across windows with different rates", () => {
    const r = rateOf(buildSeries({ days: 90, sold: (k) => (k <= 28 ? 4 : k <= 56 ? 2 : 1) }));
    const r28 = 4;
    const r56 = (28 * 4 + 28 * 2) / 56;
    const r90 = (28 * 4 + 28 * 2 + 34 * 1) / 90;
    expect(r.windows.map((w) => w.rate)).toEqual([r28, r56, r90]);
    expect(r.rate).toBeCloseTo(0.5 * r28 + 0.3 * r56 + 0.2 * r90, 12);
  });

  it("drops a window with < 7 in-stock days and renormalises the weights", () => {
    // Last 28 days: no data at all. Days 29–56 sell 4, days 57–90 sell 1.
    const r = rateOf(
      buildSeries({ days: 90, sold: (k) => (k <= 56 ? 4 : 1), missing: (k) => k <= 28 }),
    );
    const r56 = 4;
    const r90 = (28 * 4 + 34 * 1) / 62;
    expect(r.windows[0]!.used).toBe(false);
    expect(r.rate).toBeCloseTo((0.3 * r56 + 0.2 * r90) / 0.5, 12);
  });

  it("6 in-stock days in a window drops it; 7 keeps it", () => {
    const six = rateOf(
      buildSeries({ days: 90, sold: (k) => (k <= 28 ? 10 : 1), missing: (k) => k > 6 && k <= 28 }),
    );
    const seven = rateOf(
      buildSeries({ days: 90, sold: (k) => (k <= 28 ? 10 : 1), missing: (k) => k > 7 && k <= 28 }),
    );
    expect(six.windows[0]).toMatchObject({ inStockDays: 6, used: false });
    expect(seven.windows[0]).toMatchObject({ inStockDays: 7, used: true, rate: 10 });
  });

  it("returns null when every window is dropped", () => {
    const r = rateOf(buildSeries({ days: 5, sold: 2 }));
    expect(r.rate).toBeNull();
    expect(r.enoughData).toBe(false);
  });

  it("13 in-stock days is not enough data, 14 is (rate still returned)", () => {
    const r13 = rateOf(buildSeries({ days: 13, sold: 2 }));
    const r14 = rateOf(buildSeries({ days: 14, sold: 2 }));
    expect(r13).toMatchObject({ inStockDays: 13, enoughData: false, rate: 2 });
    expect(r14).toMatchObject({ inStockDays: 14, enoughData: true });
  });

  it("clamps a negative window rate (returns > sales) at 0", () => {
    const r = rateOf(buildSeries({ days: 90, sold: -1 }));
    expect(r.rate).toBe(0);
  });

  it("ignores rows dated today or later, and rows older than 90 days", () => {
    const rows = [
      ...buildSeries({ days: 90, sold: 2 }),
      { day: TODAY, sold: 500, endStock: 0, outOfStock: false },
      { day: addDays(TODAY, 3), sold: 500, endStock: 0, outOfStock: false },
      { day: ago(91), sold: 500, endStock: 0, outOfStock: false },
    ];
    expect(rateOf(rows).rate).toBe(2);
  });

  it("throws on a duplicate day", () => {
    const rows = buildSeries({ days: 3, sold: 1 });
    expect(() => indexSeries([...rows, rows[0]!], TODAY)).toThrow(/duplicate/);
  });
});

describe("sigmaDaily", () => {
  it("is the population std dev of sold on in-stock days", () => {
    // Alternating 1, 3 → mean 2, population σ 1 (sample σ would be > 1).
    const idx = indexSeries(buildSeries({ days: 90, sold: (k) => (k % 2 ? 1 : 3) }), TODAY);
    expect(sigmaDaily(idx, TODAY, 90)).toBeCloseTo(1, 12);
  });
  it("ignores out-of-stock days and missing days", () => {
    const idx = indexSeries(
      buildSeries({
        days: 90,
        sold: (k) => (k === 2 || k === 4 ? 0 : k % 2 ? 1 : 3),
        oos: (k) => k === 2 || k === 4,
        missing: (k) => k === 1 || k === 3,
      }),
      TODAY,
    );
    // Removing two 1s (missing) and two sold-out days (would have been 3s) keeps the mix balanced.
    expect(sigmaDaily(idx, TODAY, 90)).toBeCloseTo(1, 12);
  });
  it("leaves out negative (return-heavy) days: a return is not negative demand", () => {
    const idx = indexSeries(buildSeries({ days: 90, sold: (k) => (k === 7 || k === 8 ? -40 : k % 2 ? 1 : 3) }), TODAY);
    expect(sigmaDaily(idx, TODAY, 90)).toBeCloseTo(1, 12);
  });
  it("is 0 for constant sales and null with no in-stock day", () => {
    expect(sigmaDaily(indexSeries(buildSeries({ days: 30, sold: 4 }), TODAY), TODAY, 90)).toBe(0);
    const allOut = indexSeries(buildSeries({ days: 30, sold: 0, oos: true }), TODAY);
    expect(sigmaDaily(allOut, TODAY, 90)).toBeNull();
  });
});

describe("lastSaleDay / earliestDataDay", () => {
  it("finds the latest sale and the earliest row", () => {
    const idx = indexSeries(buildSeries({ days: 40, sold: (k) => (k === 12 || k === 30 ? 1 : 0) }), TODAY);
    expect(lastSaleDay(idx)).toBe(ago(12));
    expect(earliestDataDay(idx)).toBe(ago(40));
    expect(lastSaleDay(indexSeries([], TODAY))).toBeNull();
  });
});
