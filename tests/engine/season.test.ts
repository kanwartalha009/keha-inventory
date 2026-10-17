/**
 * Seasonality, trend and the plan multiplier (spec §7.3) on pinned fixtures.
 * TODAY = 2026-10-16: LY span starts 2025-10-16; LY base = 2025-09-18 … 2025-10-15;
 * trend = 2026-09-18 … 2026-10-15 vs 2025-09-19 … 2025-10-16; 13 months back = 2025-09-16.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "../../app/lib/engine/dates-shared";
import {
  NO_SEASONAL_DATA,
  SEASON,
  TREND_NOT_APPLIED,
  chooseSeasonSource,
  createSeasonContext,
  isCovered,
  monthsEarlier,
  planMultiplier,
  seasonFacts,
  seasonalIndex,
  shiftYears,
  spanStats,
  trendFactor,
  type Coverage,
  type UnitsSeries,
} from "../../app/lib/engine/season-shared";

const TODAY = "2026-10-16";
const FULL: Coverage = { from: "2025-08-01", to: "2026-10-15" };

/** Units per day from a function; every day in [from, to] gets an entry. */
function series(perDay: (day: string) => number, coverage: Coverage = FULL, from = "2025-08-01", to = "2026-10-15"): UnitsSeries {
  const units = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) units.set(d, perDay(d));
  return { units, coverage };
}

describe("calendar helpers", () => {
  it("shifts years and months, clamping 29 Feb", () => {
    expect(shiftYears("2024-02-29", -1)).toBe("2023-02-28");
    expect(shiftYears("2026-10-16", -1)).toBe("2025-10-16");
    expect(monthsEarlier("2026-10-16", 13)).toBe("2025-09-16");
    expect(monthsEarlier("2026-03-31", 1)).toBe("2026-02-28");
  });

  it("coverage excludes skipped months and days outside [from, to]", () => {
    const c: Coverage = { from: "2025-01-01", to: "2025-12-31", skippedMonths: ["2025-03-01"] };
    expect(isCovered(c, "2025-03-15")).toBe(false);
    expect(isCovered(c, "2025-04-01")).toBe(true);
    expect(isCovered(c, "2024-12-31")).toBe(false);
    expect(isCovered({ from: null, to: null }, "2025-04-01")).toBe(false);
  });
});

describe("seasonal index", () => {
  it("is LY units/day over the horizon ÷ LY units/day over the 28-day base", () => {
    // Base (Sep 18 – Oct 15 2025) sells 10/day; from 16 Oct 2025 it sells 25/day.
    const s = series((d) => (d >= "2025-10-16" && d <= "2025-12-31" ? 25 : 10));
    const r = seasonalIndex(s, TODAY, 28);
    expect(r.applied).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.value).toBeCloseTo(2.5, 12);
    expect(r.span).toMatchObject({ from: "2025-10-16", to: "2025-11-12", days: 28, coveredDays: 28 });
    expect(r.base).toMatchObject({ from: "2025-09-18", to: "2025-10-15", days: 28, unitsPerDay: 10 });
  });

  it("refuses fewer than 13 months of history", () => {
    // History starts 2025-09-17, one day after the 13-month cut-off (2025-09-16).
    const short = series(() => 10, { from: "2025-09-17", to: "2026-10-15" });
    const r = seasonalIndex(short, TODAY, 28);
    expect(r).toMatchObject({ applied: false, value: 1, reason: "short_history" });
    // Exactly 13 months: allowed.
    const ok = series(() => 10, { from: "2025-09-16", to: "2026-10-15" });
    expect(seasonalIndex(ok, TODAY, 28).applied).toBe(true);
    expect(seasonalIndex(series(() => 10, { from: null, to: null }), TODAY, 28).reason).toBe("short_history");
  });

  it("refuses spans with < 80 % covered days (a skipped month)", () => {
    // The horizon Oct 16 – Nov 12 2025: skip November → 16 of 28 days covered (57 %).
    const r = seasonalIndex(series(() => 10, { ...FULL, skippedMonths: ["2025-11"] }), TODAY, 28);
    expect(r).toMatchObject({ applied: false, value: 1, reason: "low_coverage" });
  });

  it("accepts exactly 80 % coverage and refuses just below", () => {
    // Horizon of 10 days (Oct 16 – 25, 2025); coverage ends Oct 23 → 8 of 10 days = 80 %.
    const at = seasonalIndex(series(() => 10, { from: "2025-08-01", to: "2025-10-23" }), TODAY, 10);
    expect(at.span.coverage).toBeCloseTo(0.8, 12);
    expect(at.applied).toBe(true);
    const below = seasonalIndex(series(() => 10, { from: "2025-08-01", to: "2025-10-22" }), TODAY, 10);
    expect(below.span.coverage).toBeCloseTo(0.7, 12);
    expect(below.reason).toBe("low_coverage");
  });

  it("missing days are not zeros: an uncovered day counts in neither the units nor the days", () => {
    // Horizon Oct 16 – Nov 12 2025 sells 20/day, but coverage ends Nov 8: 24 of 28 days covered.
    const s = series((d) => (d >= "2025-10-16" ? 20 : 10), { from: "2025-08-01", to: "2025-11-08" });
    const r = seasonalIndex(s, TODAY, 28);
    expect(r.span.coveredDays).toBe(24);
    expect(r.value).toBeCloseTo(2, 12); // as zeros it would be 24 × 20 ÷ 28 ÷ 10 = 1.71
    // A covered day with no entry is a real 0.
    const st = spanStats({ units: new Map([["2025-10-01", 30]]), coverage: { from: "2025-10-01", to: "2025-10-02" } }, "2025-10-01", "2025-10-04");
    expect(st).toMatchObject({ days: 4, coveredDays: 2, units: 30, unitsPerDay: 15, coverage: 0.5 });
  });

  it("clamps both ends (0.2 … 5.0) and keeps the raw value", () => {
    const high = seasonalIndex(series((d) => (d >= "2025-10-16" ? 100 : 10)), TODAY, 28);
    expect(high.raw).toBeCloseTo(10, 12);
    expect(high.value).toBe(5);
    const low = seasonalIndex(series((d) => (d >= "2025-10-16" ? 1 : 10)), TODAY, 28);
    expect(low.raw).toBeCloseTo(0.1, 12);
    expect(low.value).toBe(0.2);
  });

  it("1.0 when the base sold nothing", () => {
    expect(seasonalIndex(series((d) => (d >= "2025-10-16" ? 5 : 0)), TODAY, 28).reason).toBe("no_base_sales");
  });

  it("caps the horizon at 365 days", () => {
    expect(seasonalIndex(series(() => 10), TODAY, 900).horizonDays).toBe(SEASON.maxHorizonDays);
  });
});

describe("trend", () => {
  it("last 28 days ÷ the same 28 days 364 days earlier (growth assumption on)", () => {
    const s = series((d) => (d >= "2026-09-18" ? 15 : 10));
    const r = trendFactor(s, TODAY, "store");
    expect(r.current).toMatchObject({ from: "2026-09-18", to: "2026-10-15" });
    expect(r.lastYear).toMatchObject({ from: "2025-09-19", to: "2025-10-16" });
    expect(r.value).toBeCloseTo(1.5, 12);
    expect(r.applied).toBe(true);
    expect(r.measured).toBeCloseTo(1.5, 12);
  });

  it("C4: growth assumption off (the default) → measured, shown, but not applied", () => {
    // Audit 2026-10-17: rate × season × trend forecast +85 % too high (today's pace already
    // contains the growth). Off: the multiplier is 1; the measured value stays for the product page.
    const s = series((d) => (d >= "2026-09-18" ? 15 : 10));
    for (const r of [trendFactor(s, TODAY), trendFactor(s, TODAY, "off")]) {
      expect(r).toMatchObject({ value: 1, applied: false, reason: "off", mode: "off" });
      expect(r.measured).toBeCloseTo(1.5, 12);
    }
    const ctx = createSeasonContext({ today: TODAY, store: s, collections: new Map(), units12m: new Map() });
    const v = ctx.forVariant([], 28);
    expect(v.trend).toBe(1);
    expect(seasonFacts(v)).toMatchObject({ trendApplied: false, trendReason: "off", trendMode: "off", trendNote: TREND_NOT_APPLIED });
    expect(seasonFacts(v).trendMeasured).toBeCloseTo(1.5, 12);
    const on = createSeasonContext({ today: TODAY, store: s, collections: new Map(), units12m: new Map(), trendMode: "store" }).forVariant([], 28);
    expect(on.trend).toBeCloseTo(1.5, 12);
    expect(seasonFacts(on).trendNote).toBeNull();
  });

  it("clamps to 0.5 … 2.0", () => {
    expect(trendFactor(series((d) => (d >= "2026-09-18" ? 50 : 10)), TODAY, "store").value).toBe(2);
    expect(trendFactor(series((d) => (d >= "2026-09-18" ? 1 : 10)), TODAY, "store").value).toBe(0.5);
  });

  it("1.0 without last year's data", () => {
    const r = trendFactor(series(() => 10, { from: "2026-01-01", to: "2026-10-15" }), TODAY);
    expect(r).toMatchObject({ value: 1, applied: false, reason: "low_coverage" });
    expect(trendFactor(series((d) => (d >= "2026-01-01" ? 10 : 0)), TODAY).reason).toBe("no_last_year_sales");
  });
});

describe("store vs collection", () => {
  it("uses a collection only from 2,000 units in 12 months (threshold and just below)", () => {
    expect(chooseSeasonSource(["c1"], new Map([["c1", 2000]]))).toEqual({ level: "collection", collectionId: "c1" });
    expect(chooseSeasonSource(["c1"], new Map([["c1", 1999]]))).toEqual({ level: "store", collectionId: null });
    expect(chooseSeasonSource([], new Map())).toEqual({ level: "store", collectionId: null });
  });

  it("picks the most specific qualifying collection", () => {
    const units = new Map([["all", 90000], ["coats", 2500], ["tiny", 100]]);
    expect(chooseSeasonSource(["all", "coats", "tiny"], units).collectionId).toBe("coats");
  });

  it("context: collection index when it qualifies, store index otherwise, store fallback when the collection can't compute", () => {
    const store = series((d) => (d >= "2025-10-16" && d <= "2025-12-31" ? 20 : 10)); // store index 2
    const coats = series((d) => (d >= "2025-10-16" && d <= "2025-12-31" ? 40 : 10)); // coats index 4
    const dead = series(() => 0); // qualifies by units12m (overridden) but base sold nothing
    const ctx = createSeasonContext({
      today: TODAY,
      store,
      collections: new Map([["coats", coats], ["dead", dead]]),
      units12m: new Map([["coats", 3000], ["dead", 2500], ["small", 10]]),
    });
    const c = ctx.forVariant(["coats"], 28);
    expect(c).toMatchObject({ level: "collection", collectionId: "coats" });
    expect(c.seasonal).toBeCloseTo(4, 12);
    expect(ctx.forVariant(["small"], 28).level).toBe("store");
    expect(ctx.forVariant(["small"], 28).seasonal).toBeCloseTo(2, 12);
    const fb = ctx.forVariant(["dead"], 28);
    expect(fb.level).toBe("store");
    expect(fb.seasonal).toBeCloseTo(2, 12);
  });

  it("facts label the fallback 'No seasonal data yet'", () => {
    const ctx = createSeasonContext({ today: TODAY, store: series(() => 10, { from: null, to: null }), collections: new Map(), units12m: new Map() });
    const f = seasonFacts(ctx.forVariant([], 28));
    expect(f).toMatchObject({ level: "store", seasonalApplied: false, seasonalReason: "short_history", label: NO_SEASONAL_DATA });
  });
});

describe("plan multiplier", () => {
  it("keep pace, grow X %, revenue target", () => {
    expect(planMultiplier({ type: "keep_pace" })).toBe(1);
    expect(planMultiplier({ type: "growth", pct: 20 })).toBeCloseTo(1.2, 12);
    expect(planMultiplier({ type: "growth", pct: -150 })).toBe(0);
    expect(planMultiplier({ type: "revenue", target: 150000, baselineRevenue: 100000 })).toBeCloseTo(1.5, 12);
    expect(planMultiplier({ type: "revenue", target: 150000, baselineRevenue: 0 })).toBeNull();
    expect(planMultiplier({ type: "revenue", target: 150000, baselineRevenue: null })).toBeNull();
  });
});
