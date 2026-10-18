/**
 * Small season groups blended with the store's index (accuracy audit 2026-10-18): a small store
 * selling swimwear and coats has a flat store index (the two cancel out); neither group reaches
 * 2,000 units a year, so both used to get the store's flat index — swimwear wasn't off season in
 * winter. Now each keeps most of its own shape (groupWeight). Pinned dates only.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "../../app/lib/engine/dates-shared";
import { SEASON, blendGroupIds, blendIndex, buildSeasonGroups, chooseBlendSource, createSeasonContext, groupWeight, seasonFacts, type UnitsSeries } from "../../app/lib/engine/season-shared";
import { planVariant } from "../../app/lib/engine/forward-plan-shared";

const TODAY = "2026-01-15";
const FROM = "2024-12-01";
const TO = addDays(TODAY, -1);
// Swimwear sells May–October, coats November–April: the store's total is flat all year.
const summer = (d: string) => d.slice(5, 7) >= "05" && d.slice(5, 7) <= "10";
const winter = (d: string) => !summer(d);
const SWIM = (d: string) => (summer(d) ? 3 : 0.4);
const COAT = (d: string) => (winter(d) ? 3 : 0.4);

function series(perDay: (d: string) => number): UnitsSeries {
  const units = new Map<string, number>();
  for (let d = FROM; d <= TO; d = addDays(d, 1)) units.set(d, perDay(d));
  return { units, coverage: { from: FROM, to: TO } };
}
const units12 = (f: (d: string) => number) => {
  let s = 0;
  for (let d = addDays(TODAY, -365); d <= TO; d = addDays(d, 1)) s += f(d);
  return s;
};

function smallStore() {
  // 2 swimwear products, 2 coat products and 2 basics (1 variant each): no group is a catch-all.
  const variants = [
    { id: "s1", productId: "S1", collections: [], productType: "Swimwear", counted: true },
    { id: "s2", productId: "S2", collections: [], productType: "Swimwear", counted: true },
    { id: "c1", productId: "C1", collections: [], productType: "Coats", counted: true },
    { id: "c2", productId: "C2", collections: [], productType: "Coats", counted: true },
    { id: "b1", productId: "B1", collections: [], productType: null, counted: true },
    { id: "b2", productId: "B2", collections: [], productType: null, counted: true },
  ];
  const u = new Map([["s1", units12(SWIM) / 2], ["s2", units12(SWIM) / 2], ["c1", units12(COAT) / 2], ["c2", units12(COAT) / 2], ["b1", 0], ["b2", 0]]);
  const { groups } = buildSeasonGroups(variants, u);
  const groupSeries = new Map([["type:Swimwear", series(SWIM)], ["type:Coats", series(COAT)]]);
  const store = series((d) => SWIM(d) + COAT(d));
  return { variants, groups, groupSeries, store };
}

describe("groupWeight / blendIndex", () => {
  it("1 from 2,000 units (the group's own index, as before); a shrinkage weight below; 0 under 50", () => {
    expect(groupWeight(SEASON.collectionMinUnits12m)).toBe(1);
    expect(groupWeight(5000)).toBe(1);
    expect(groupWeight(1999)).toBeCloseTo(0.99999, 3);
    expect(groupWeight(1000)).toBeCloseTo((1000 * 2100) / (2000 * 1100), 12);
    expect(groupWeight(600)).toBeCloseTo(0.9, 3);
    expect(groupWeight(200)).toBeCloseTo(0.7, 3);
    expect(groupWeight(50)).toBeCloseTo(0.35, 3);
    expect(groupWeight(49)).toBe(0);
    expect(blendIndex(0.25, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(blendIndex(4, 1, 1)).toBeCloseTo(4, 12);
  });
});

describe("small store: swimwear and coats keep their own seasons", () => {
  it("before: neither group reaches 2,000 units, the store's index is flat; now each blends its own shape in", () => {
    const { groups, groupSeries, store } = smallStore();
    expect(groups.get("type:Swimwear")).toMatchObject({ qualifies: false, catchAll: false });
    expect(groups.get("type:Swimwear")!.units12m).toBeLessThan(700);
    const ctx = createSeasonContext({ today: TODAY, store, groupSeries, groups });
    const storeOnly = ctx.forVariant([], 105);
    // The store's index for the next lead time + cycle: about flat (swimwear and coats cancel).
    expect(storeOnly.seasonal).toBe(1);
    const swim = ctx.forVariant(["type:Swimwear"], 105);
    expect(swim).toMatchObject({ level: "productType", productType: "Swimwear" });
    expect(swim.groupWeight!).toBeCloseTo(groupWeight(groups.get("type:Swimwear")!.units12m), 3);
    // The index for the next 105 days is about 1 (its recent pace is off season too); the shape
    // over the year is what tells summer from winter: blended, its summer weeks stay far above.
    expect(swim.seasonal).toBeCloseTo(blendIndex(swim.seasonalResult.value, storeOnly.seasonal, swim.groupWeight!), 9);
    const curve = ctx.curveFor(swim, 50)!;
    const storeCurve = ctx.curveFor(storeOnly, 50)!;
    expect(Math.max(...storeCurve.map((x) => x ?? 1))).toBeLessThan(1.05);
    expect(Math.max(...curve.map((x) => x ?? 0))).toBeGreaterThan(4);
    expect(seasonFacts(swim)).toMatchObject({ level: "productType", groupWeight: swim.groupWeight });
    // The groups to load series for.
    expect(blendGroupIds([{ productType: "Swimwear" }, { productType: "Coats" }, { productType: null }], groups)).toEqual(["type:Coats", "type:Swimwear"]);
    expect(chooseBlendSource(["type:Swimwear"], groups)).toMatchObject({ groupId: "type:Swimwear" });
  });

  it("swimwear is off season in winter (next season's order), coats are not; with the store's flat index neither was", () => {
    const { groups, groupSeries, store } = smallStore();
    const ctx = createSeasonContext({ today: TODAY, store, groupSeries, groups });
    const plan = (groupIds: string[]) => {
      const s = ctx.forVariant(groupIds, 105);
      return planVariant({
        today: TODAY, status: "healthy", rate: 1, seasonal: s.seasonal, trend: 1, plan: 1, curve: ctx.curveFor(s, 50),
        safety: 2, leadTimeDays: 60, cycleDays: 45, onHand: 3, incoming: 0, arrivals: [], need: 20, pack: null, moq: null, days: 200,
      });
    };
    expect(plan(["type:Swimwear"]).nextSeason).toBe(true);
    expect(plan(["type:Coats"]).nextSeason ?? false).toBe(false);
    // Before (the store's flat shape): swimwear was ordered now.
    expect(plan([]).nextSeason ?? false).toBe(false);
  });
});
