/**
 * The plan comparison table: it can't promise more than the gates allow, every
 * paid feature appears (as a row or a limit row), and it only gets better plan
 * by plan. Translation coverage is tests/i18n-coverage.test.ts.
 */
import { describe, expect, it } from "vitest";
import { FEATURE_PLAN, hasFeature, type Feature } from "../app/lib/plan-shared";
import { FEATURES_AS_LIMITS, PLAN_MATRIX, PLAN_POINTS, cellFor, matrixFeatures, PLAN_PITCH } from "../app/lib/plan-matrix";

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

describe("plan wording (2026-10-17 click-through; terminology glossary 2026-10-18)", () => {
  it("the screen is called Season planner on the Plans page, never the old 'Season plan'", () => {
    const words = [
      ...Object.values(PLAN_POINTS).flat(),
      ...PLAN_MATRIX.flatMap((g) => g.rows.map((r) => r.label)),
    ];
    for (const w of words) expect(w, w).not.toMatch(/Season plan(?!ner)/i);
    expect(PLAN_POINTS.growth).toContain("Season planner (1 scenario) and forecast accuracy");
    expect(PLAN_POINTS.pro).toContain("Unlimited Season planner scenarios");
  });
});

describe("the Free pitch says what Free shows (pricing audit 2026-10-17)", () => {
  it("10 products, not 10 orders: the preview lists products (one line each, with its next order)", () => {
    expect(PLAN_PITCH.free).toContain("10 most urgent products");
    expect(PLAN_PITCH.free).not.toMatch(/urgent orders/);
  });
});

describe("the sold-out best seller feature is sold as what it does (pricing audit 2026-10-17)", () => {
  it("no preorder promise and no internal word: without a preorder app it is the back-in-stock how-to", () => {
    const row = PLAN_MATRIX.flatMap((g) => g.rows).find((r) => r.feature === "bridge")!;
    expect(row.label).toBe("Stock gaps");
    expect(row.hint).toBe("Until its stock arrives: how to collect back-in-stock sign-ups on the product page.");
    const texts = [row.label, row.hint ?? "", ...Object.values(PLAN_POINTS).flat()];
    for (const t of texts) expect(t).not.toMatch(/preorder|bridge/i);
    expect(PLAN_POINTS.growth).toContain("Stock-gap actions and dead-stock discounts");
  });
});
