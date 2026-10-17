/** Accuracy maths (spec §7.8): month helpers, snapshot rows, grading. */
import { describe, expect, it } from "vitest";
import {
  ACCURACY_TOP,
  STORE_ROW,
  absPctError,
  daysInMonth,
  forecastUnits,
  INSTOCK_PREFIX,
  NAIVE_PREFIX,
  gradeMonth,
  inStockShareOf,
  scoreFromRows,
  monthEnd,
  monthStart,
  nextMonthStart,
  monthsToGrade,
  previousMonthStart,
  rankingWindow,
  snapshotDue,
  snapshotRows,
} from "../../app/lib/engine/accuracy-shared";

describe("months", () => {
  it("start, end, next, previous, length (leap February, year boundaries)", () => {
    expect(monthStart("2026-10-16")).toBe("2026-10-01");
    expect(nextMonthStart("2026-12-05")).toBe("2027-01-01");
    expect(previousMonthStart("2026-01-01")).toBe("2025-12-01");
    expect(daysInMonth("2028-02-01")).toBe(29);
    expect(daysInMonth("2026-02-10")).toBe(28);
    expect(daysInMonth("2026-10-01")).toBe(31);
    expect(monthEnd("2026-11-01")).toBe("2026-11-30");
  });
});

describe("snapshot", () => {
  it("rate × seasonal × trend × days in month, plus the store total; no rate → no row", () => {
    expect(forecastUnits(2, 1.5, 0.8, 30)).toBeCloseTo(72, 12);
    expect(forecastUnits(null, 1, 1, 30)).toBeNull();
    const rows = snapshotRows(
      [
        { variantId: "a", rate: 2, seasonal: 1.5, trend: 1 },
        { variantId: "b", rate: 1, seasonal: 1, trend: 1 },
        { variantId: "c", rate: null, seasonal: 1, trend: 1 },
      ],
      "2026-11-01",
    );
    expect(rows).toEqual([
      { variantId: "a", predicted: 90 },
      { variantId: "b", predicted: 30 },
      { variantId: STORE_ROW, predicted: 120 },
    ]);
    expect(snapshotRows([{ variantId: "c", rate: null, seasonal: 1, trend: 1 }], "2026-11-01")).toEqual([]);
  });
});

describe("grading", () => {
  const snapshot = [
    { variantId: "a", predicted: 90 },
    { variantId: "b", predicted: 30 },
    { variantId: "z", predicted: 10 },
    { variantId: STORE_ROW, predicted: 130 },
  ];

  it("M7: store WAPE over the same variants; top-20 WAPE (Σ|F − A| ÷ ΣA) and bias over variants with revenue", () => {
    const g = gradeMonth({
      snapshot,
      actualUnits: new Map([["a", 100], ["b", 20], ["other", 999]]),
      revenue: new Map([["a", 1000], ["b", 300], ["z", 0]]),
      coverage: 1,
    });
    expect(g.actual.get("z")).toBe(0); // covered month, no sale = 0
    expect(g.actual.get(STORE_ROW)).toBe(120); // "other" was not snapshotted
    expect(g.storeErrorPct).toBeCloseTo((10 / 120) * 100, 10);
    // a: |90 − 100| + b: |30 − 20| = 20 over 120 sold → 16.7 % (the old mean of % errors said 30 %).
    expect(g.top20ErrorPct).toBeCloseTo((20 / 120) * 100, 10);
    expect(g.score!.top20.engine.biasPct).toBeCloseTo(0, 10);
    expect(g.score!.store.engine.biasPct).toBeCloseTo((10 / 120) * 100, 10);
    expect(g.graded).toBe(2);
  });

  it("M7: a top seller that sold nothing is graded (WAPE never drops a zero actual)", () => {
    const g = gradeMonth({ snapshot, actualUnits: new Map([["a", 100], ["b", 0]]), revenue: new Map([["a", 1000], ["b", 300]]), coverage: 1 });
    // |90 − 100| + |30 − 0| = 40 over 100 → 40 %; the old rule left b out.
    expect(g.top20ErrorPct).toBeCloseTo(40, 10);
    expect(g.graded).toBe(2);
  });

  it("M7: stock-out days are excluded from the forecast side; the naive baseline sits beside the engine", () => {
    const snap = [
      ...snapshot,
      { variantId: `${NAIVE_PREFIX}a`, predicted: 120 },
      { variantId: `${NAIVE_PREFIX}b`, predicted: 30 },
    ];
    // b was in stock half the month: its 30 forecast is graded as 15 against the 20 it sold.
    const g = gradeMonth({
      snapshot: snap,
      actualUnits: new Map([["a", 100], ["b", 20]]),
      revenue: new Map([["a", 1000], ["b", 300]]),
      coverage: 1,
      inStockShare: new Map([["b", 0.5]]),
    });
    expect(g.top20ErrorPct).toBeCloseTo(((10 + 5) / 120) * 100, 10);
    expect(g.score!.top20.naive.wapePct).toBeCloseTo(((20 + 5) / 120) * 100, 10);
    expect(g.score!.top20.naive.biasPct).toBeCloseTo(((20 - 5) / 120) * 100, 10);
    expect(g.actual.get(`${NAIVE_PREFIX}a`)).toBe(100);
    expect(g.shares).toEqual(new Map([["b", 0.5]]));
    // Re-read from the stored rows (the scorecard): the same figures.
    const rows = [
      ...snap.map((r) => ({ ...r, actual: g.actual.get(r.variantId) ?? null })),
      { variantId: `${INSTOCK_PREFIX}b`, predicted: 0.5, actual: null },
    ];
    expect(scoreFromRows(rows, new Map([["a", 1000], ["b", 300]]))).toEqual(g.score);
  });

  it("in-stock share: sold-out days (out AND nothing sold) leave the month; backorder days stay", () => {
    expect(inStockShareOf([{ outOfStock: true, sold: 0 }, { outOfStock: true, sold: 3 }, { outOfStock: false, sold: 0 }, { outOfStock: false, sold: 1 }])).toBe(0.75);
    expect(inStockShareOf([])).toBeNull();
  });

  it("the snapshot keeps the naive baseline (last-28-day rate × days) per variant", () => {
    const rows = snapshotRows([{ variantId: "a", rate: 2, seasonal: 1.5, trend: 1, naiveRate: 3 }], "2026-11-01");
    expect(rows).toEqual([
      { variantId: "a", predicted: 90 },
      { variantId: STORE_ROW, predicted: 90 },
      { variantId: `${NAIVE_PREFIX}a`, predicted: 90 },
    ]);
  });

  it("only the top 20 by revenue", () => {
    const many = Array.from({ length: 25 }, (_x, i) => ({ variantId: `v${i}`, predicted: i < 20 ? 10 : 1000 }));
    const g = gradeMonth({
      snapshot: many,
      actualUnits: new Map(many.map((r) => [r.variantId, 10])),
      revenue: new Map(many.map((r, i) => [r.variantId, 100 - i])),
      coverage: 1,
    });
    expect(g.graded).toBe(ACCURACY_TOP);
    expect(g.top20ErrorPct).toBe(0);
    expect(g.storeErrorPct).toBeNull(); // no store row in this snapshot
  });

  it("null when coverage < 80 % or nothing to grade", () => {
    expect(gradeMonth({ snapshot, actualUnits: new Map([["a", 1]]), revenue: new Map(), coverage: 0.79 })).toEqual({
      actual: new Map(),
      storeErrorPct: null,
      top20ErrorPct: null,
      graded: 0,
      score: null,
      shares: new Map(),
    });
    expect(gradeMonth({ snapshot, actualUnits: new Map([["a", 1]]), revenue: new Map(), coverage: 0.8 }).storeErrorPct).not.toBeNull();
    const zero = gradeMonth({ snapshot, actualUnits: new Map(), revenue: new Map([["a", 5]]), coverage: 1 });
    expect(zero.storeErrorPct).toBeNull();
    expect(zero.top20ErrorPct).toBeNull();
    expect(absPctError(5, 0)).toBeNull();
  });
});

describe("review fixes: one ranking rule, no skipped months", () => {
  it("rankingWindow = the whole month before the graded month (year boundary)", () => {
    expect(rankingWindow("2026-10-01")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(rankingWindow("2027-01-01")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("snapshotDue on days 1–3 only", () => {
    expect(["2026-11-01", "2026-11-02", "2026-11-03"].map(snapshotDue)).toEqual([true, true, true]);
    expect(snapshotDue("2026-11-04")).toBe(false);
  });

  it("monthsToGrade: every ungraded past month with complete data, oldest first; the rest wait", () => {
    const r = monthsToGrade(["2026-10-01", "2026-08-01", "2026-09-01", "2026-11-01"], ["2026-08-01"], "2026-11-20", "2026-10-31");
    expect(r).toEqual({ due: ["2026-09-01", "2026-10-01"], waiting: [] });
    expect(monthsToGrade(["2026-09-01", "2026-10-01"], [], "2026-11-01", "2026-10-30")).toEqual({ due: ["2026-09-01"], waiting: ["2026-10-01"] });
    expect(monthsToGrade(["2026-10-01"], [], "2026-11-01", null)).toEqual({ due: [], waiting: ["2026-10-01"] });
  });
});
