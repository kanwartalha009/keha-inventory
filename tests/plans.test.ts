/**
 * Plans (spec §3): handle mapping, fail-open resolution, every §3 feature on
 * the right plan, the per-plan limits, and locked pages.
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_LIST_LIMIT,
  FEATURE_PLAN,
  MONEY_REFRESH,
  SCENARIO_LIMIT,
  canAddScenario,
  effectivePlan,
  hasFeature,
  lockedPageFeature,
  planCodeFromHandle,
  visibleRows,
  type Feature,
  type PlanCode,
} from "../app/lib/plan-shared";

describe("plan resolution", () => {
  it("maps Partner Dashboard handles by word", () => {
    expect(planCodeFromHandle("free")).toBe("free");
    expect(planCodeFromHandle("keha-growth-annual")).toBe("growth");
    expect(planCodeFromHandle("pro")).toBe("pro");
    expect(planCodeFromHandle("vip")).toBeNull();
  });

  it("fails open, comps to Pro, and treats no subscription as Free", () => {
    const base = { pricingConfigured: true, comped: false };
    expect(effectivePlan({ ...base, status: "ACTIVE", planCode: "free" })).toBe("free");
    expect(effectivePlan({ ...base, status: "TRIAL", planCode: "growth" })).toBe("growth");
    expect(effectivePlan({ ...base, status: "NONE", planCode: null })).toBe("free"); // never picked / $0 plan / cancelled
    expect(effectivePlan({ ...base, status: null, planCode: null })).toBe("pro"); // never checked / failed
    expect(effectivePlan({ ...base, status: "NONE", planCode: null, comped: true })).toBe("pro");
    expect(effectivePlan({ pricingConfigured: false, comped: false, status: "NONE", planCode: null })).toBe("pro");
    expect(effectivePlan({ ...base, status: "ACTIVE", planCode: "mystery" })).toBe("pro");
  });
});

describe("spec §3 feature table", () => {
  // The spec table, row by row: the lowest plan with the feature.
  const SPEC: Record<Feature, PlanCode> = {
    dailyRefresh: "growth",
    fullActionList: "growth",
    forecast: "growth",
    reorderPlan: "growth",
    // Kanwar 2026-10-17: the 90-day order calendar (Order plan · Next 90 days).
    orderCalendar: "growth",
    suppliers: "growth",
    poExport: "growth",
    supplierConfirm: "growth",
    bridge: "growth",
    clearance: "growth",
    fixDetails: "growth",
    planner: "growth",
    collectionGoals: "growth",
    accuracy: "growth",
    slack: "growth",
    flowTriggers: "growth",
    csvExport: "growth",
    locations: "pro",
    transfers: "pro",
  };

  it("has exactly the spec's features", () => {
    expect(Object.keys(FEATURE_PLAN).sort()).toEqual(Object.keys(SPEC).sort());
  });

  it("puts each feature on the right plans", () => {
    for (const f of Object.keys(SPEC) as Feature[]) {
      for (const p of ["free", "growth", "pro"] as const) {
        const rank = { free: 0, growth: 1, pro: 2 };
        expect(hasFeature(p, f), `${f} on ${p}`).toBe(rank[p] >= rank[SPEC[f]]);
      }
    }
  });

  it("applies the per-plan limits", () => {
    expect(MONEY_REFRESH).toEqual({ free: "weekly", growth: "daily", pro: "daily" });
    expect(ACTION_LIST_LIMIT).toEqual({ free: 10, growth: null, pro: null });
    expect(SCENARIO_LIMIT).toEqual({ free: 0, growth: 1, pro: null });
    const rows = Array.from({ length: 25 }, (_, i) => i);
    expect(visibleRows("free", rows)).toHaveLength(10);
    expect(visibleRows("growth", rows)).toHaveLength(25);
    expect(canAddScenario("free", 0)).toBe(false);
    expect(canAddScenario("growth", 0)).toBe(true);
    expect(canAddScenario("growth", 1)).toBe(false);
    expect(canAddScenario("pro", 40)).toBe(true);
  });
});

describe("locked pages", () => {
  it("locks a purchase order page on Free; the Order plan tabs teach inside the tab instead", () => {
    // Kanwar 2026-10-17: Free sees Order now as a read-only preview; the other tabs keep the tab bar.
    for (const path of ["/app/reorder", "/app/reorder/", "/app/reorder/calendar", "/app/reorder/orders", "/app/planner"])
      expect(lockedPageFeature(path, "free"), path).toBeNull();
    expect(lockedPageFeature("/app/reorder/po_123", "free")).toBe("reorderPlan");
    expect(lockedPageFeature("/app/planner/new", "none")).toBe("planner");
    expect(lockedPageFeature("/app/reorder", "growth")).toBeNull();
    expect(lockedPageFeature("/app/products", "free")).toBeNull();
    expect(lockedPageFeature("/app", "free")).toBeNull();
  });
});
