/**
 * Managed pricing (shopify.dev billing/managed-pricing: the app sends a store without a plan to
 * Shopify's hosted plan page). Independent audit 2026-10-23: the reviewer steps say "after install,
 * Shopify's plan page opens", and nothing sent them there. Now the first admin load of a store
 * known to be on Free (no subscription) gets the plan page once — never again, and never when the
 * plan check failed (that would use up the one prompt) or when coming back from the plan page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  plan: "free" as string,
  checked: true,
  configured: true,
  seen: new Set<string>(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ admin: { graphql: vi.fn() }, session: { shop: "acme.myshopify.com" } })) },
}));
vi.mock("../app/services/app-pricing.server", () => ({
  pricingConfigured: () => m.configured,
  syncPlan: vi.fn(async () => ({})),
  syncPlanOnLoad: vi.fn(async () => "fresh"),
}));
vi.mock("../app/services/entitlements.server", () => ({
  forgetEntitlements: () => {},
  getEntitlements: vi.fn(async () => ({ plan: m.plan, features: {}, comped: false, checked: m.checked })),
}));
vi.mock("../app/models/activation.server", () => ({
  firstTime: vi.fn(async (shop: string, kind: string) => {
    const k = `${shop}|${kind}`;
    if (m.seen.has(k)) return false;
    m.seen.add(k);
    return true;
  }),
}));
vi.mock("../app/services/shop-locale.server", () => ({ readShopLocale: async () => "en" }));
vi.mock("../app/services/data-scope.server", () => ({ dataScope: async (shop: string) => ({ shop, sample: false, state: { on: false } }) }));
vi.mock("../app/models/dashboard.server", () => ({ readiness: async () => ({ ready: true }) }));

import { loader } from "../app/routes/app";

const load = async (q = "") => (await loader({ request: new Request(`https://inventory.keha.io/app${q}`), params: {}, context: {} } as never)) as { planPrompt: string | null };
const PLAN_PAGE = "https://admin.shopify.com/store/acme/charges/keha-inventory/pricing_plans";

beforeEach(() => {
  m.plan = "free";
  m.checked = true;
  m.configured = true;
  m.seen.clear();
});

describe("first admin load → Shopify's plan page, once", () => {
  it("a store known to be on Free is sent once; the next loads aren't", async () => {
    expect((await load()).planPrompt).toBe(PLAN_PAGE);
    expect((await load()).planPrompt).toBeNull();
  });
  it("coming back from the plan page (welcome link with plan_handle) is never sent back, and uses up the prompt", async () => {
    expect((await load("?plan_handle=free")).planPrompt).toBeNull();
    expect((await load()).planPrompt).toBeNull();
  });
  it("a paying store, an unchecked plan (Partner API down) or pricing not configured: no prompt, and the one prompt is kept", async () => {
    m.plan = "growth";
    expect((await load()).planPrompt).toBeNull();
    m.plan = "free";
    m.checked = false;
    expect((await load()).planPrompt).toBeNull();
    m.configured = false;
    expect((await load()).planPrompt).toBeNull();
    m.configured = true;
    m.checked = true;
    expect((await load()).planPrompt).toBe(PLAN_PAGE);
  });
});
