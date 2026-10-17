/**
 * Pricing audit 2026-10-17: a new install ran as Pro for up to 6 hours — the admin synced the plan
 * only when Shopify's plan page sent `plan_handle`, and a store with no billing record fails open.
 * Now the first admin load (and any load after the TTL) syncs once, time-boxed and cached per shop,
 * so a new install is on Free at once. Fail-open stays only for real failures (Partner API down,
 * not configured) and for a check that doesn't answer in time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));
vi.mock("../app/services/billing.server", () => ({
  getBillingState: async (shop: string) => rows.get(shop) ?? null,
  saveBillingState: async (shop: string, d: Record<string, unknown>) => {
    rows.set(shop, { ...(rows.get(shop) ?? {}), shop, ...d, updatedAt: new Date() });
  },
}));
vi.mock("../app/services/plans.server", () => ({ getPlanOverride: async () => ({ type: "NONE", value: 0 }) }));
vi.mock("../app/lib/nova.server", () => ({ forwardToIngress: vi.fn(async () => {}) }));

import { LOAD_SYNC_TTL_MS, syncPlanOnLoad } from "../app/services/app-pricing.server";
import { getEntitlements } from "../app/services/entitlements.server";

const admin = {
  graphql: async () =>
    new Response(JSON.stringify({ data: { shop: { id: "gid://shopify/Shop/1" }, currentAppInstallation: { app: { id: "gid://shopify/App/9" } } } })),
};

let calls = 0;
const noPlan = async () => {
  calls++;
  return new Response(JSON.stringify({ data: { activeSubscription: null } }));
};

beforeEach(() => {
  rows.clear();
  calls = 0;
  vi.unstubAllGlobals();
  process.env.SHOPIFY_PARTNER_ORG_ID = "1";
  process.env.SHOPIFY_PARTNER_API_TOKEN = "t";
});

describe("plan sync on app load", () => {
  it("a new install (never synced) is checked on its first load and is on Free at once", async () => {
    vi.stubGlobal("fetch", noPlan);
    expect((await getEntitlements("new.myshopify.com")).plan).toBe("pro"); // before: fail open
    expect(await syncPlanOnLoad(admin, "new.myshopify.com")).toBe("synced");
    expect(calls).toBe(1);
    expect((await getEntitlements("new.myshopify.com")).plan).toBe("free");
    // Cached per shop: the next navigations don't call the Partner API again.
    expect(await syncPlanOnLoad(admin, "new.myshopify.com")).toBe("fresh");
    expect(calls).toBe(1);
  });

  it("a recent sync (the 6-hourly run, the plan page) is trusted; an old one is re-checked", async () => {
    vi.stubGlobal("fetch", noPlan);
    rows.set("recent.myshopify.com", { shop: "recent.myshopify.com", status: "NONE", planCode: null, updatedAt: new Date(Date.now() - 60_000) });
    expect(await syncPlanOnLoad(admin, "recent.myshopify.com")).toBe("fresh");
    rows.set("old.myshopify.com", { shop: "old.myshopify.com", status: "NONE", planCode: null, updatedAt: new Date(Date.now() - LOAD_SYNC_TTL_MS - 60_000) });
    expect(await syncPlanOnLoad(admin, "old.myshopify.com")).toBe("synced");
    expect(calls).toBe(1);
  });

  it("is time-boxed: a slow Partner API never holds the admin (fails open meanwhile, the answer still lands)", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (release = r)));
    const t0 = Date.now();
    expect(await syncPlanOnLoad(admin, "slow.myshopify.com", { timeoutMs: 50 })).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await getEntitlements("slow.myshopify.com")).plan).toBe("pro");
    release(new Response(JSON.stringify({ data: { activeSubscription: null } })));
    await new Promise((r) => setTimeout(r, 20));
    expect((await getEntitlements("slow.myshopify.com")).plan).toBe("free");
  });

  it("real failures keep failing open and are not retried on every navigation", async () => {
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("down", { status: 503 });
    });
    expect(await syncPlanOnLoad(admin, "down.myshopify.com")).toBe("failed");
    expect((await getEntitlements("down.myshopify.com")).plan).toBe("pro");
    expect(await syncPlanOnLoad(admin, "down.myshopify.com")).toBe("fresh");
    expect(calls).toBe(1);
  });

  it("not configured: nothing to check (fail open, as before)", async () => {
    delete process.env.SHOPIFY_PARTNER_API_TOKEN;
    vi.stubGlobal("fetch", noPlan);
    expect(await syncPlanOnLoad(admin, "off.myshopify.com")).toBe("off");
    expect(calls).toBe(0);
  });

  it("the admin layout checks on every load, not only when coming back from the plan page", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/routes/app.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/syncPlanOnLoad\(admin, session\.shop\)/);
  });
});
