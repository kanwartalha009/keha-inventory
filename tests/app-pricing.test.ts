/**
 * Shopify App Pricing (2026-09-28): plan handle → code, Partner API shape →
 * plan state, and the gate never locking a shop out on errors or when unset.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { saved } = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[] }));
vi.mock("../app/services/billing.server", () => ({
  getBillingState: async () => null,
  saveBillingState: async (_s: string, d: Record<string, unknown>) => {
    saved.push(d);
  },
}));
vi.mock("../app/services/plans.server", () => ({ getPlanOverride: async () => ({ type: "NONE", value: 0 }) }));
vi.mock("../app/lib/nova.server", () => ({ forwardToIngress: vi.fn(async () => {}) }));

import { planCodeFromHandle, toPlanState, planChanged } from "../app/lib/pricing-shared";
import { needsPlan, syncPlan } from "../app/services/app-pricing.server";

const admin = {
  graphql: async () =>
    new Response(JSON.stringify({ data: { shop: { id: "gid://shopify/Shop/1" }, currentAppInstallation: { app: { id: "gid://shopify/App/9" } } } })),
};

beforeEach(() => {
  saved.length = 0;
  vi.unstubAllGlobals();
  delete process.env.SHOPIFY_PARTNER_ORG_ID;
  delete process.env.SHOPIFY_PARTNER_API_TOKEN;
});

describe("pricing-shared", () => {
  it("maps Partner Dashboard handles to plan codes", () => {
    expect(planCodeFromHandle("growth")).toBe("growth");
    expect(planCodeFromHandle("Growth-Annual")).toBe("growth");
    expect(planCodeFromHandle("keha_pro_plan")).toBe("pro");
    expect(planCodeFromHandle("free")).toBe("free");
    // No legacy handles in this app: unknown words are kept as-is.
    expect(planCodeFromHandle("basic")).toBe("basic");
    expect(planCodeFromHandle("vip")).toBe("vip");
    expect(planCodeFromHandle("")).toBeNull();
  });
  it("reads a trial subscription", () => {
    const p = toPlanState(
      {
        billingPeriod: "EVERY_30_DAYS",
        trialEndsAt: "2026-10-10T00:00:00Z",
        currentBillingCycle: { endTime: "2026-10-28T00:00:00Z" },
        items: [{ handle: "growth", description: "Growth", price: { amount: "19.99", currency: "USD" } }],
      },
      new Date("2026-09-28T00:00:00Z"),
    );
    expect(p).toMatchObject({ state: "active", planCode: "growth", status: "TRIAL", amountMinor: 1999, currency: "USD" });
    expect(toPlanState(null).state).toBe("none");
    expect(planChanged({ planCode: "growth", status: "TRIAL", currentPeriodEnd: p.currentPeriodEnd }, p)).toBe(false);
    expect(planChanged({ planCode: "growth", status: "ACTIVE" }, p)).toBe(true);
  });
});

describe("plan gate", () => {
  it("is off until the Partner API is configured", async () => {
    expect(await needsPlan(admin, "a.myshopify.com")).toBe(false);
  });
  it("sends a shop with no plan to the plan page", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "1";
    process.env.SHOPIFY_PARTNER_API_TOKEN = "t";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { activeSubscription: null } })));
    expect(await needsPlan(admin, "b.myshopify.com", { force: true })).toBe(true);
    expect(saved[0]).toMatchObject({ status: "NONE", planCode: null });
  });
  it("fails open when the Partner API errors", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "1";
    process.env.SHOPIFY_PARTNER_API_TOKEN = "t";
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(await needsPlan(admin, "c.myshopify.com", { force: true })).toBe(false);
    expect((await syncPlan(admin, "c.myshopify.com")).state).toBe("unknown");
  });
});
