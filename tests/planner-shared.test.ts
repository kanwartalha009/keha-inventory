/**
 * Planner maths (task 2.5, spec §4 J6, §5.4, §7.3, §7.4) on pinned fixtures. TODAY = 2026-10-16
 * (a Friday). Black Friday 2026 = 27 Nov; default period Thu 26 Nov – Mon 30 Nov.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "../app/lib/engine/dates-shared";
import { safetyStock } from "../app/lib/engine/order-shared";
import type { Coverage, UnitsSeries } from "../app/lib/engine/season-shared";
import {
  RESULT_VERSION,
  blackFriday,
  cashBars,
  cashByWeek,
  computeScenario,
  createPlannerSeason,
  effectiveStart,
  eventPeriod,
  firstScorecardDate,
  goalErrorText,
  goalRows,
  goalsTotal,
  hasSeasonHistory,
  isoWeek,
  lastYearSpan,
  mergeDayRanges,
  newScenarioForm,
  periodSeasonalIndex,
  readGoalPct,
  readScenarioForm,
  readScenarioResult,
  reorderLink,
  scenarioErrorText,
  scenarioToForm,
  scorecardRows,
  seasonWindows,
  unitValueOf,
  validateGoal,
  validateScenario,
  weekStart,
  type PlannerInput,
  type PlannerVariant,
  type ScenarioForm,
} from "../app/lib/planner-shared";

const TODAY = "2026-10-16";
const SHORT: Coverage = { from: "2026-06-01", to: "2026-10-15" }; // < 13 months: no seasonality
const FULL: Coverage = { from: "2025-08-01", to: "2026-10-15" };
const t = (s: string) => s;

function series(perDay: (day: string) => number, coverage: Coverage, from = coverage.from!, to = coverage.to!): UnitsSeries {
  const units = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) units.set(d, perDay(d));
  return { units, coverage };
}

const flat = series(() => 10, SHORT);

const V = (n: number, over: Partial<PlannerVariant> = {}): PlannerVariant => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productId: `gid://shopify/Product/${n}`,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
  image: null,
  vendor: "Acme",
  supplierId: null,
  collections: [],
  caseQty: null,
  cost: 4,
  costCurrency: "EUR",
  price: 20,
  rate: 2,
  sigma: 1,
  z: 1.65,
  enoughData: true,
  onHand: 50,
  incoming: 10,
  ...over,
});

function input(over: Partial<PlannerInput> = {}, seasonSeries: UnitsSeries = flat, coverage: Coverage = SHORT): PlannerInput {
  const start = over.start ?? "2026-11-26";
  const end = over.end ?? "2026-11-30";
  const today = over.today ?? TODAY;
  return {
    today,
    start,
    end,
    targetType: "growth",
    targetValue: 20,
    currency: "EUR",
    defaultLeadTimeDays: 14,
    variants: [V(1)],
    suppliers: [],
    season: createPlannerSeason({ today, start, end, store: seasonSeries, collections: new Map(), units12m: new Map() }),
    coverage,
    lastYear: { from: "2025-11-26", to: "2025-11-30", units: null, revenue: null, coverage: 0 },
    computedAt: "2026-10-16T08:00:00.000Z",
    ...over,
  };
}

describe("calendar", () => {
  it("Black Friday is the Friday after the 4th Thursday of November", () => {
    expect(blackFriday(2024)).toBe("2024-11-29");
    expect(blackFriday(2025)).toBe("2025-11-28");
    expect(blackFriday(2026)).toBe("2026-11-27");
    expect(blackFriday(2027)).toBe("2027-11-26");
    expect(blackFriday(2028)).toBe("2028-11-24");
    expect(blackFriday(2029)).toBe("2029-11-23");
  });

  it("default periods: Black Friday Thu–Mon, Christmas 1–24 Dec, the next one that hasn't ended", () => {
    expect(eventPeriod("black_friday", TODAY)).toEqual({ start: "2026-11-26", end: "2026-11-30" });
    expect(eventPeriod("black_friday", "2026-11-30")).toEqual({ start: "2026-11-26", end: "2026-11-30" }); // Cyber Monday: current
    expect(eventPeriod("black_friday", "2026-12-01")).toEqual({ start: "2027-11-25", end: "2027-11-29" });
    expect(eventPeriod("christmas", TODAY)).toEqual({ start: "2026-12-01", end: "2026-12-24" });
    expect(eventPeriod("christmas", "2026-12-10")).toEqual({ start: "2026-12-01", end: "2026-12-24" });
    expect(eventPeriod("christmas", "2026-12-25")).toEqual({ start: "2027-12-01", end: "2027-12-24" });
    expect(eventPeriod("custom", TODAY)).toBeNull();
  });

  it("ISO weeks start on Monday; the ISO year follows the week's Thursday", () => {
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday → Monday before
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
    expect(isoWeek("2026-11-09")).toBe("2026-W46");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2025-12-29")).toBe("2026-W01");
  });

  it("last year's span is the most recent year the dates are fully in the past", () => {
    expect(lastYearSpan(TODAY, "2026-11-26", "2026-11-30")).toEqual({ from: "2025-11-26", to: "2025-11-30", yearsBack: 1 });
    expect(lastYearSpan(TODAY, "2027-11-25", "2027-11-29")).toEqual({ from: "2025-11-25", to: "2025-11-29", yearsBack: 2 });
    expect(lastYearSpan(TODAY, "2026-10-16", "2026-10-20")).toEqual({ from: "2025-10-16", to: "2025-10-20", yearsBack: 1 });
  });

  it("a period under way is planned from today; history needs 13 months", () => {
    expect(effectiveStart("2026-10-01", TODAY)).toBe(TODAY);
    expect(effectiveStart("2026-11-26", TODAY)).toBe("2026-11-26");
    expect(hasSeasonHistory(FULL, TODAY)).toBe(true);
    expect(hasSeasonHistory(SHORT, TODAY)).toBe(false);
    expect(hasSeasonHistory({ from: null, to: null }, TODAY)).toBe(false);
  });
});

describe("scenario form", () => {
  const form = (over: Partial<ScenarioForm> = {}): ScenarioForm => ({ ...newScenarioForm(TODAY), ...over });

  it("defaults to Black Friday, grow 20%", () => {
    expect(newScenarioForm(TODAY)).toEqual({ name: "Black Friday", event: "black_friday", start: "2026-11-26", end: "2026-11-30", targetType: "growth", targetValue: "20" });
  });

  it("accepts growth, revenue (comma decimals) and keep pace", () => {
    expect(validateScenario(form(), TODAY)).toEqual({
      ok: true,
      input: { name: "Black Friday", event: "black_friday", start: "2026-11-26", end: "2026-11-30", targetType: "growth", targetValue: 20 },
    });
    const r = validateScenario(form({ targetType: "revenue", targetValue: "150000,50" }), TODAY);
    expect(r.ok && r.input.targetValue).toBe(150000.5);
    const k = validateScenario(form({ targetType: "keep_pace", targetValue: "abc" }), TODAY);
    expect(k.ok && k.input.targetValue).toBe(0);
    // A current period (started, not ended) is fine.
    expect(validateScenario(form({ start: "2026-10-01", end: "2026-10-31" }), TODAY).ok).toBe(true);
  });

  it("refuses bad names, dates, ended / long / far periods and out-of-range targets", () => {
    const errs = (f: Partial<ScenarioForm>) => {
      const r = validateScenario(form(f), TODAY);
      return r.ok ? {} : r.errors;
    };
    expect(errs({ name: "  " })).toEqual({ name: "name" });
    expect(errs({ name: "x".repeat(81) })).toEqual({ name: "nameLong" });
    expect(errs({ start: "2026-02-30" })).toEqual({ start: "date" });
    expect(errs({ start: "2026-12-01", end: "2026-11-30" })).toEqual({ end: "endBeforeStart" });
    expect(errs({ start: "2026-09-01", end: "2026-10-15" })).toEqual({ end: "ended" });
    expect(errs({ start: "2026-11-01", end: "2027-11-01" })).toEqual({ end: "tooLong" });
    expect(errs({ start: "2028-11-01", end: "2028-11-05" })).toEqual({ start: "tooFar" });
    expect(errs({ targetValue: "-95" })).toEqual({ targetValue: "growth" });
    expect(errs({ targetValue: "1e3" })).toEqual({ targetValue: "growth" });
    expect(errs({ targetType: "revenue", targetValue: "0" })).toEqual({ targetValue: "revenue" });
    for (const c of ["name", "nameLong", "date", "endBeforeStart", "ended", "tooLong", "tooFar", "growth", "revenue"] as const)
      expect(scenarioErrorText(c, t)).toBeTruthy();
  });

  it("reads untrusted JSON and round-trips a stored scenario", () => {
    expect(readScenarioForm({ name: 5, event: "nope", start: " 2026-11-26 ", targetType: "x", targetValue: 12 })).toEqual({
      name: "5",
      event: "custom",
      start: "2026-11-26",
      end: "",
      targetType: "keep_pace",
      targetValue: "12",
    });
    expect(scenarioToForm({ name: "BF", event: "black_friday", start: "2026-11-26", end: "2026-11-30", targetType: "keep_pace", targetValue: 0 }).targetValue).toBe("");
    expect(scenarioToForm({ name: "BF", event: "x", start: "2026-11-26", end: "2026-11-30", targetType: "revenue", targetValue: 5000 })).toMatchObject({
      event: "custom",
      targetValue: "5000",
    });
  });
});

describe("seasonal index for a period", () => {
  // Base 1 unit/day; the Black Friday week last year sold 3/day; 21–25 Nov 2025 sold 12/day.
  const seasonal = series((d) => (d >= "2025-11-26" && d <= "2025-11-30" ? 3 : d >= "2025-11-21" && d <= "2025-11-25" ? 12 : 1), FULL);

  it("= last year's units/day over the same dates ÷ the engine's base window, clamped", () => {
    const r = periodSeasonalIndex(seasonal, TODAY, "2026-11-26", "2026-11-30");
    expect(r).toMatchObject({ applied: true, reason: "ok", raw: 3, value: 3, yearsBack: 1 });
    expect([r.base.from, r.base.to]).toEqual(["2025-09-18", "2025-10-15"]);
    const hi = periodSeasonalIndex(seasonal, TODAY, "2026-11-21", "2026-11-25");
    expect(hi).toMatchObject({ raw: 12, value: 5 }); // clamped to 5.0
  });

  it("a period more than a year away compares with two years back", () => {
    expect(periodSeasonalIndex(seasonal, TODAY, "2027-11-26", "2027-11-30")).toMatchObject({ yearsBack: 2, applied: true, raw: 3 });
  });

  it("refuses short history (1.0, 'No seasonal data yet')", () => {
    expect(periodSeasonalIndex(flat, TODAY, "2026-11-26", "2026-11-30")).toMatchObject({ applied: false, reason: "short_history", value: 1 });
  });

  it("collection level when the collection sold ≥ 2,000 units in 12 months; else the store", () => {
    const coll = series((d) => (d >= "2025-11-26" && d <= "2025-11-30" ? 4 : 1), FULL);
    const s = createPlannerSeason({
      today: TODAY,
      start: "2026-11-26",
      end: "2026-11-30",
      store: seasonal,
      collections: new Map([["C1", coll]]),
      units12m: new Map([["C1", 2500], ["C2", 100]]),
    });
    expect(s.forVariant(["C1"])).toMatchObject({ level: "collection", collectionId: "C1" });
    expect(s.forVariant(["C1"]).period.value).toBe(4);
    expect(s.forVariant(["C2"])).toMatchObject({ level: "store" });
    expect(s.gapDays).toBe(41);
    expect(s.forVariant([]).gap?.horizonDays).toBe(41);
  });
});

describe("computeScenario", () => {
  it("projects stock to the period start, rounds like Reorder, and dates the order", () => {
    // gap 41 days × 2/day = 82 > 60 in stock → 0 at the start. demand = 2 × 5 × 1.2 = 12.
    const r = computeScenario(input({ variants: [V(1), V(2, { onHand: 200 })] }));
    expect(r.status).toBe("ok");
    expect(r.version).toBe(RESULT_VERSION);
    expect(r.plan).toMatchObject({ type: "growth", value: 20, multiplier: 1.2, baselineUnits: 20 });
    expect(r.period).toEqual({ start: "2026-11-26", end: "2026-11-30", effectiveStart: "2026-11-26", days: 5, daysUntilStart: 41 });
    expect(r.order.lines).toBe(1); // V2: 200 − 82 = 118 ≥ 12 + safety → nothing to order
    const l = r.groups[0]!.lines[0]!;
    const safety = safetyStock(1.65, 1, 14);
    expect(l).toMatchObject({ variantId: V(1).id, demand: 12, stockAtStart: 0, gapDemand: 82, qty: Math.ceil(12 + safety), leadTimeDays: 14, leadTimeSource: "default" });
    // Order by = start − lead time − safety days (floored): 26 Nov − 14 − 3.09 → 8 Nov.
    expect(l.orderBy).toBe("2026-11-08");
    expect(l.late).toBe(false);
    expect(r.groups[0]).toMatchObject({ kind: "vendor", name: "Acme", orderBy: "2026-11-08", late: false });
    // Collection totals: none; the store total counts both variants.
    expect(r.totals).toMatchObject({ units: 24, revenue: 480, variants: 2, noData: 0 });
  });

  it("applies the case pack and the per-variant minimum, with the supplier's lead time; flags late lines", () => {
    const supplier = { id: "s1", name: "Far Away Ltd", leadTimeDays: 60, minOrder: 30, minOrderTotal: null, casePack: 6, vendorMatch: ["Acme"], currency: null };
    const r = computeScenario(input({ variants: [V(1)], suppliers: [supplier] }));
    const l = r.groups[0]!.lines[0]!;
    expect(l).toMatchObject({ qty: 30, pack: 6, moq: 30, leadTimeDays: 60, leadTimeSource: "supplier" });
    expect(l.orderBy).toBe("2026-09-20"); // 26 Nov − 60 − 6.39 safety days (σ 1, z 1.65, √60)
    expect(l.late).toBe(true);
    expect(r.groups[0]).toMatchObject({ kind: "supplier", name: "Far Away Ltd", late: true });
    expect(r.order).toEqual({ lines: 1, units: 30, late: 1 });
    // Late lines count in the current week.
    expect(r.cash.weeks).toEqual([{ weekStart: "2026-10-12", week: "2026-W42", amount: 120, lines: 1, retail: 0, missing: 0, late: true }]);
  });

  it("values at cost, falls back to the retail price (labelled), and '—' without either", () => {
    const r = computeScenario(
      input({
        variants: [V(1), V(2, { cost: null }), V(3, { cost: null, price: null }), V(4, { cost: 3, costCurrency: "USD" })],
      }),
    );
    const byId = new Map(r.groups.flatMap((g) => g.lines).map((l) => [l.variantId, l]));
    expect(byId.get(V(1).id)).toMatchObject({ valueBasis: "cost", unitValue: 4 });
    expect(byId.get(V(2).id)).toMatchObject({ valueBasis: "retail", unitValue: 20 });
    expect(byId.get(V(3).id)).toMatchObject({ valueBasis: null, unitValue: null, lineValue: null });
    expect(byId.get(V(4).id)).toMatchObject({ valueBasis: "retail", unitValue: 20 }); // cost in USD: not converted
    expect(r.cash.retail).toBe(2);
    expect(r.cash.missing).toBe(1);
    const q = byId.get(V(1).id)!.qty;
    expect(r.cash.total).toBe(q * 4 + q * 20 + q * 20);
    expect(r.totals.missingPrice).toBe(1);
    expect(unitValueOf({ cost: 0, costCurrency: null, price: 9 }, "EUR")).toEqual({ value: 9, basis: "retail" });
  });

  it("revenue target: plan = target ÷ baseline revenue", () => {
    // Baseline: 2/day × 5 days × €20 = €200 → target €500 → × 2.5.
    const r = computeScenario(input({ targetType: "revenue", targetValue: 500 }));
    expect(r.plan).toMatchObject({ multiplier: 2.5, baselineRevenue: 200 });
    expect(r.totals.revenue).toBe(500);
    const keep = computeScenario(input({ targetType: "keep_pace", targetValue: 0 }));
    expect(keep.plan.multiplier).toBe(1);
    // No price anywhere: a revenue target can't be planned.
    const none = computeScenario(input({ targetType: "revenue", targetValue: 500, variants: [V(1, { price: null })] }));
    expect(none.status).toBe("no_baseline");
    expect(none.groups).toEqual([]);
    expect(none.totals.units).toBeNull();
  });

  it("a variant in several collections counts in each; the store total counts it once", () => {
    const r = computeScenario(
      input({
        targetType: "keep_pace",
        targetValue: 0,
        variants: [V(1, { collections: ["A", "B", "A"] }), V(2, { collections: ["B"], price: null })],
      }),
    );
    const c = new Map(r.collections.map((x) => [x.collectionId, x]));
    expect(c.get("A")).toMatchObject({ units: 10, revenue: 200, variants: 1, missingPrice: 0 });
    expect(c.get("B")).toMatchObject({ units: 20, revenue: 200, variants: 2, missingPrice: 1 });
    expect(r.totals).toMatchObject({ units: 20, revenue: 200, variants: 2, missingPrice: 1 });
  });

  it("no advice without enough data, a rate or σ; no data at all → status no_data", () => {
    const r = computeScenario(input({ variants: [V(1, { enoughData: false }), V(2, { rate: null }), V(3, { sigma: null })] }));
    expect(r.status).toBe("no_data");
    expect(r.totals).toMatchObject({ units: null, revenue: null, noData: 3 });
    expect(r.cash).toEqual({ weeks: [], total: null, retail: 0, missing: 0 });
  });

  it("uses seasonality and trend when there are 13 months of history; a current period starts today", () => {
    const s = series((d) => (d >= "2025-10-16" && d <= "2025-10-31" ? 2 : 1), FULL);
    const r = computeScenario(
      input({ start: "2026-10-01", end: "2026-10-20", targetType: "keep_pace", targetValue: 0, variants: [V(1, { onHand: 0, incoming: 0 })] }, s, FULL),
    );
    expect(r.period).toMatchObject({ effectiveStart: TODAY, days: 5, daysUntilStart: 0 });
    expect(r.season).toMatchObject({ applied: true, value: 2, yearsBack: 1, spanFrom: "2025-10-16", spanTo: "2025-10-20" });
    expect(r.history).toEqual({ enough: true, from: "2025-08-01" });
    // Trend: last 28 days (1/day) ÷ the same 28 days 364 days earlier (incl. 16 Oct 2025 at 2/day) = 28/29.
    expect(r.season).toMatchObject({ trendApplied: true });
    expect(r.season.trend).toBeCloseTo(28 / 29, 6);
    expect(r.totals.units).toBeCloseTo(2 * 2 * (28 / 29) * 5, 1); // rate × seasonal × trend × 5 days
    expect(r.groups[0]!.lines[0]!.late).toBe(true); // starts today: any lead time is too late
  });

  it("reads a stored result only in the current version", () => {
    const r = computeScenario(input());
    expect(readScenarioResult(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(readScenarioResult({ ...r, version: 0 })).toBeNull();
    expect(readScenarioResult(null)).toBeNull();
    expect(readScenarioResult({ version: RESULT_VERSION })).toBeNull();
  });
});

describe("cash per week", () => {
  it("buckets by the ISO week of the order-by date, fills gaps with real zeros, counts retail and missing", () => {
    const weeks = cashByWeek(
      [
        { orderBy: "2026-11-02", late: false, lineValue: 100, valueBasis: "cost" },
        { orderBy: "2026-11-05", late: false, lineValue: 50, valueBasis: "retail" },
        { orderBy: "2026-11-20", late: false, lineValue: null, valueBasis: null },
        { orderBy: "2026-10-01", late: true, lineValue: 10, valueBasis: "cost" },
      ],
      TODAY,
    );
    expect(weeks.map((w) => [w.weekStart, w.amount, w.lines, w.retail, w.missing, w.late])).toEqual([
      ["2026-10-12", 10, 1, 0, 0, true],
      ["2026-10-19", 0, 0, 0, 0, false],
      ["2026-10-26", 0, 0, 0, 0, false],
      ["2026-11-02", 150, 2, 1, 0, false],
      ["2026-11-09", 0, 0, 0, 0, false],
      ["2026-11-16", 0, 1, 0, 1, false],
    ]);
    expect(cashByWeek([], TODAY)).toEqual([]);
  });

  it("bar geometry: the tallest bar fills the plot, zero weeks have no height", () => {
    const bars = cashBars(
      [
        { weekStart: "2026-11-02", week: "2026-W45", amount: 100, lines: 1, retail: 0, missing: 0, late: false },
        { weekStart: "2026-11-09", week: "2026-W46", amount: 0, lines: 0, retail: 0, missing: 0, late: false },
        { weekStart: "2026-11-16", week: "2026-W47", amount: 50, lines: 1, retail: 0, missing: 0, late: false },
      ],
      300,
      124,
    );
    expect(bars.map((b) => Math.round(b.height))).toEqual([96, 0, 48]);
    expect(bars[0]!.y + bars[0]!.height).toBe(100);
    expect(cashBars([], 300, 124)).toEqual([]);
  });

  it("links the order lines into the Reorder plan", () => {
    expect(reorderLink(["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/12", "gid://shopify/ProductVariant/11"])).toBe("/app/reorder?variants=11,12");
    expect(reorderLink([])).toBe("/app/reorder");
  });
});

describe("data windows", () => {
  it("merges overlapping and touching ranges", () => {
    expect(
      mergeDayRanges([
        { from: "2026-01-10", to: "2026-01-20" },
        { from: "2026-01-01", to: "2026-01-09" },
        { from: "2026-01-15", to: "2026-01-25" },
        { from: "2026-03-01", to: "2026-02-01" },
      ]),
    ).toEqual([{ from: "2026-01-01", to: "2026-01-25" }]);
  });

  it("reads the base, trend, gap and period windows, never past yesterday", () => {
    const w = seasonWindows(TODAY, "2026-11-26", "2026-11-30");
    expect(w).toEqual([
      // trend last year (19 Sep 2025 …) + base (18 Sep – 15 Oct 2025) + gap span (16 Oct – 25 Nov 2025) + period (26–30 Nov 2025)
      { from: "2025-09-18", to: "2025-11-30" },
      { from: "2026-09-18", to: "2026-10-15" },
    ]);
    expect(w.every((r) => r.to <= "2026-10-15")).toBe(true);
  });
});

describe("collection goals", () => {
  it("validates the collection, the share and the limit", () => {
    const ctx = { collectionIds: new Set(["C1"]), existing: [] as string[] };
    expect(validateGoal({ collectionId: "C1", goalPct: "25,5" }, ctx)).toEqual({ ok: true, collectionId: "C1", goalPct: 25.5 });
    expect(validateGoal({ collectionId: "C9", goalPct: 10 }, ctx)).toEqual({ ok: false, error: "collection" });
    expect(validateGoal({ collectionId: "C1", goalPct: 101 }, ctx)).toEqual({ ok: false, error: "pct" });
    expect(validateGoal({ collectionId: "C1", goalPct: "-1" }, ctx)).toEqual({ ok: false, error: "pct" });
    const full = { collectionIds: new Set(["C1", "X"]), existing: Array.from({ length: 50 }, (_, i) => `G${i}`) };
    expect(validateGoal({ collectionId: "C1", goalPct: 5 }, full)).toEqual({ ok: false, error: "limit" });
    expect(validateGoal({ collectionId: "G3", goalPct: 5 }, { ...full, collectionIds: new Set(["G3"]) }).ok).toBe(true); // editing is fine
    expect(readGoalPct(0)).toBe(0);
    expect(readGoalPct("100")).toBe(100);
    expect(readGoalPct("abc")).toBeNull();
    for (const c of ["collection", "pct", "limit"] as const) expect(goalErrorText(c, t)).toBeTruthy();
  });

  it("actual share of store revenue, gap in points, overlap allowed, products holding it back", () => {
    const rows = goalRows({
      goals: [
        { collectionId: "A", goalPct: 40 },
        { collectionId: "B", goalPct: 80 },
      ],
      titles: new Map([["A", "Shirts"]]),
      variants: [
        { id: "v1", productId: "p1", productTitle: "Tee", collections: ["A", "B"] },
        { id: "v2", productId: "p1", productTitle: "Tee", collections: ["A", "B"] },
        { id: "v3", productId: "p2", productTitle: "Polo", collections: ["A"] },
        { id: "v4", productId: "p3", productTitle: "Cap", collections: ["B"] },
        { id: "v5", productId: "p4", productTitle: "Sock", collections: ["A"] },
        { id: "v6", productId: "p5", productTitle: "Belt", collections: ["A"] },
      ],
      revenue: new Map([
        ["v1", 100],
        ["v2", 100],
        ["v3", 50],
        ["v4", 300],
        ["v5", 10],
      ]),
      storeRevenue: 1000,
      status: new Map([
        ["v1", "out"],
        ["v3", "running_low"],
        ["v5", "running_low"],
        ["v6", "healthy"],
      ]),
      atRisk: new Map([["p2", 500]]),
    });
    expect(rows[0]).toMatchObject({ collectionId: "A", title: "Shirts", goalPct: 40, actualShare: 0.26, revenue: 260, gapPts: 14 });
    // p2 has €500 at risk; p1 has a variant out; p4 running low; p5 healthy → not listed.
    expect(rows[0]!.holdingBack.map((p) => [p.productId, p.atRisk, p.out, p.low])).toEqual([
      ["p2", 500, 0, 1],
      ["p1", null, 1, 0],
      ["p4", null, 0, 1],
    ]);
    expect(rows[1]).toMatchObject({ collectionId: "B", title: null, actualShare: 0.5, gapPts: 30 });
    expect(goalsTotal([{ goalPct: 40 }, { goalPct: 80 }])).toBe(120);
  });

  it("unknown store revenue → '—' share and gap", () => {
    const [r] = goalRows({
      goals: [{ collectionId: "A", goalPct: 10 }],
      titles: new Map(),
      variants: [],
      revenue: new Map(),
      storeRevenue: null,
      status: new Map(),
      atRisk: new Map(),
    });
    expect(r).toMatchObject({ actualShare: null, gapPts: null, revenue: null, holdingBack: [] });
  });
});

describe("accuracy scorecard", () => {
  it("top 20 by the month's revenue, with the % error ('—' when nothing sold)", () => {
    const snapshot = [
      { variantId: "__store__", predicted: 999, actual: 900 },
      ...Array.from({ length: 25 }, (_, i) => ({ variantId: `v${i}`, predicted: 10, actual: i === 0 ? 0 : 8 })),
    ];
    const revenue = new Map(snapshot.map((s, i) => [s.variantId, i * 10]));
    const rows = scorecardRows(snapshot, revenue, new Map([["v24", { productTitle: "Tee", variantTitle: "M" }]]));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({ variantId: "v24", productTitle: "Tee", variantTitle: "M", predicted: 10, actual: 8, errorPct: 25 });
    expect(rows.some((r) => r.variantId === "__store__")).toBe(false);
    const zero = scorecardRows([{ variantId: "a", predicted: 5, actual: 0 }], new Map([["a", 1]]), new Map());
    expect(zero[0]).toMatchObject({ errorPct: null, productTitle: null });
  });

  it("first scorecard: the 1st after the first snapshotted month", () => {
    expect(firstScorecardDate(TODAY, null)).toBe("2026-12-01");
    expect(firstScorecardDate(TODAY, "2026-10-01")).toBe("2026-11-01");
  });
});
