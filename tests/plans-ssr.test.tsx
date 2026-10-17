/**
 * SSR: the Plans page renders Free / Growth / Pro with the spec prices, a
 * visible billing-period switch, and the comparison table.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/services/plans.server", () => ({ getPlans: vi.fn(), getPlanOverride: vi.fn() }));
vi.mock("../app/services/billing.server", () => ({ getBillingState: vi.fn() }));
vi.mock("../app/services/app-pricing.server", () => ({ syncPlan: vi.fn(), pricingConfigured: () => false }));
vi.mock("../app/services/entitlements.server", () => ({ forgetEntitlements: vi.fn(), getEntitlements: vi.fn() }));
vi.mock("../app/lib/admin-url.server", () => ({ planSelectionUrl: () => "https://admin.shopify.com/x" }));

import PlansPage from "../app/routes/app.plans";

const plans = [
  { code: "free", name: "Free", amountMonthly: 0, amountAnnual: 0, currency: "USD", trialDays: 0 },
  { code: "growth", name: "Growth", amountMonthly: 4900, amountAnnual: 49000, currency: "USD", trialDays: 14 },
  { code: "pro", name: "Pro", amountMonthly: 9900, amountAnnual: 99000, currency: "USD", trialDays: 14 },
];

function render(data: Record<string, unknown>) {
  const Stub = createRoutesStub([{ id: "plans", path: "/app/plans", Component: PlansPage, loader: () => data }]);
  return renderToString(<Stub initialEntries={["/app/plans"]} hydrationData={{ loaderData: { plans: data } }} />);
}

describe("Plans page", () => {
  it("renders the three plans, prices, the switch and the comparison", () => {
    const html = render({
      plans,
      plan: "free",
      billing: { status: "NONE", planCode: null },
      comped: false,
      checked: true,
      manageUrl: "https://admin.shopify.com/x",
    });
    for (const name of ["Free", "Growth", "Pro"]) expect(html).toContain(name);
    expect(html).toContain("keha-seg"); // visible Monthly / Annual switch
    expect(html).toContain("$49.00");
    expect(html).toContain("$99.00");
    expect(html).toContain("14-day free trial");
    expect(html).toContain("Recommended");
    expect(html).not.toContain("Most popular");
    expect(html).toContain("No revenue tiers or SKU limits.");
    expect(html).toContain("Start free with your 10 most urgent orders.");
    // The order plan leads the comparison.
    expect(html.indexOf("What to order, how much and by when")).toBeLessThan(html.indexOf("How often the numbers refresh"));
    expect(html).toContain("Full order plan by supplier, with purchase orders");
    expect(html).not.toContain("Reorder plan");
    expect(html).toContain("Compare plans");
    expect(html).toContain("Planning per location and per POS store");
    expect(html).toContain("Choose plan");
  });

  it("doesn't present an unchecked plan as the merchant's plan: says, in merchant words, that everything is on (fail open)", () => {
    const html = render({ plans, plan: "pro", billing: null, comped: false, checked: false, manageUrl: "x" });
    expect(html).toContain("All features on");
    expect(html).toContain("Shopify hasn&#x27;t confirmed a plan for your store yet, so every feature is on.");
    expect(html).not.toContain("Plan not checked yet");
    expect(html).not.toContain("Current plan");
  });

  it("a checked plan names it, with no 'not confirmed' note", () => {
    const html = render({ plans, plan: "growth", billing: { status: "ACTIVE", planCode: "growth" }, comped: false, checked: true, manageUrl: "x" });
    expect(html).toContain("Current plan");
    expect(html).toContain("Change plan");
    expect(html).not.toContain("All features on");
  });

  it("layout: one row per plan (points beside the price, room for one line each), cards with the shared head", () => {
    const html = render({ plans, plan: "free", billing: { status: "NONE", planCode: null }, comped: false, checked: true, manageUrl: "x" });
    expect(html.split('<div class="keha-plan">').length - 1).toBe(3);
    expect(html.split('<div class="keha-point">').length - 1).toBeGreaterThanOrEqual(8);
    expect(html).not.toContain("keha-grid--3");
    expect(html).toMatch(/keha-form-card__head[^"]*"><s-stack gap="small-500"><s-heading>Your plan<\/s-heading>/);
    expect(html).toMatch(/keha-form-card__head keha-form-card__head--pad"><s-stack gap="small-500"><s-heading>Compare plans<\/s-heading>/);
  });
});
