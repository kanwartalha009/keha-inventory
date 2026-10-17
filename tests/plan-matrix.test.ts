/**
 * The plan comparison table: it can't promise more than the gates allow, every
 * paid feature appears (as a row or a limit row), and it only gets better plan
 * by plan. Translation coverage is tests/i18n-coverage.test.ts.
 */
import { describe, expect, it } from "vitest";
import { FEATURE_PLAN, hasFeature, type Feature } from "../app/lib/plan-shared";
import { FEATURES_AS_LIMITS, PLAN_MATRIX, PLAN_POINTS, cellFor, matrixFeatures } from "../app/lib/plan-matrix";

describe("plan matrix", () => {
  it("lists every paid feature", () => {
    const listed = matrixFeatures();
    for (const f of FEATURES_AS_LIMITS) listed.add(f);
    for (const f of Object.keys(FEATURE_PLAN) as Feature[]) expect(listed.has(f), f).toBe(true);
  });

  it("matches the gates cell by cell", () => {
    for (const g of PLAN_MATRIX)
      for (const r of g.rows)
        if (r.feature)
          for (const p of ["free", "growth", "pro"] as const) expect(cellFor(r, p)).toBe(hasFeature(p, r.feature));
  });

  it("only gets better plan by plan", () => {
    const rank = (c: boolean | string) => (c === false ? 0 : 1);
    for (const g of PLAN_MATRIX)
      for (const r of g.rows) {
        expect(rank(cellFor(r, "growth")), r.label).toBeGreaterThanOrEqual(rank(cellFor(r, "free")));
        expect(rank(cellFor(r, "pro")), r.label).toBeGreaterThanOrEqual(rank(cellFor(r, "growth")));
      }
  });
});

describe("plan wording (2026-10-17 click-through)", () => {
  it("the screen is called Season plan on the Plans page, never 'planner'", () => {
    const words = [
      ...Object.values(PLAN_POINTS).flat(),
      ...PLAN_MATRIX.flatMap((g) => g.rows.map((r) => r.label)),
    ];
    for (const w of words) expect(w, w).not.toMatch(/planner/i);
    expect(PLAN_POINTS.growth).toContain("Season plan (1 scenario) and forecast accuracy");
    expect(PLAN_POINTS.pro).toContain("Unlimited Season plan scenarios");
  });
});
