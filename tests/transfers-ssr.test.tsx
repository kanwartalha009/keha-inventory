/**
 * SSR (Phase 3): the Transfers section on Reorder — a plan card per origin → destination
 * with editable quantities and "Create transfer in Shopify" (confirm, draft wording), the
 * transfers created with Keha linking into the Shopify admin, the empty and "set up your
 * locations" states, and the Growth lock (what it does, Pro tag, plans link).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));

import Reorder, { type ReorderPageData } from "../app/routes/app.reorder";
import { buildTransferPlan, type PlanMetric } from "../app/lib/transfers-shared";
import type { TransfersView } from "../app/components/transfers-section";

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const inputs = { leadTimeDays: 10, cycleDays: 10, z: 1.65, seasonal: 1, trend: 1 };

function plan() {
  return buildTransferPlan({
    warehouses: [{ id: "gid://shopify/Location/1", name: "Main", inPool: false }],
    stores: [{ id: "gid://shopify/Location/2", name: "Barcelona" }],
    variants: new Map([[V(1), { id: V(1), productTitle: "Linen shirt", variantTitle: "S", sku: "LS-S", image: null }]]),
    metrics: new Map<string, Map<string, PlanMetric & { daysLeft: number | null }>>([
      ["gid://shopify/Location/1", new Map([[V(1), { status: "healthy", rate: 0, sigma: 0, daysLeft: null, inputs }]])],
      ["gid://shopify/Location/2", new Map([[V(1), { status: "out", rate: 1, sigma: 0, daysLeft: 0, inputs }]])],
    ]),
    stock: new Map([
      ["gid://shopify/Location/1", new Map([[V(1), { onHand: 50, available: 50, incoming: 0 }]])],
      ["gid://shopify/Location/2", new Map([[V(1), { onHand: 0, available: 0, incoming: 0 }]])],
    ]),
  });
}

function page(transfers: TransfersView, locationsEnabled = true): ReorderPageData {
  return {
    enabled: true,
    groups: [],
    openOrders: [],
    currency: "EUR",
    missingSelected: 0,
    locationsEnabled,
    locations: [],
    location: null,
    transfers,
  };
}

function render(d: ReorderPageData) {
  const Stub = createRoutesStub([{ id: "reorder", path: "/app/reorder", Component: Reorder, loader: () => d }]);
  return renderToString(<Stub initialEntries={["/app/reorder"]} hydrationData={{ loaderData: { reorder: d } }} />);
}

describe("Transfers section", () => {
  it("Pro: one card per route with the store's need, the warehouse's spare and an editable quantity", () => {
    const html = render(
      page({
        enabled: true,
        groups: plan(),
        recent: [{ id: "t1", shopifyTransferId: "gid://shopify/InventoryTransfer/77", originName: "Main", destinationName: "Barcelona", units: 12, createdAt: "2026-10-15T10:00:00Z" }],
        hasWarehouse: true,
        hasStore: true,
      }),
    );
    expect(html).toContain("Transfers: warehouse → stores · Main → Barcelona");
    expect(html).toContain("Linen shirt");
    expect(html).toContain("Stock at Barcelona");
    expect(html).toContain("Spare at Main");
    expect(html).toContain("The store needs 20.");
    expect(html).toMatch(/<s-number-field[^>]*value="20"/);
    expect(html).toContain("Units: 20");
    expect(html).toContain("Create transfer in Shopify");
    // The confirm dialog says it is a draft and nothing moves yet.
    expect(html).toContain("Create a transfer from Main to Barcelona?");
    expect(html).toContain("Keha creates it as a draft in Shopify: nothing moves until you mark it as ready to ship there.");
    // Transfers created with Keha link into the admin.
    expect(html).toContain("Transfers created with Keha");
    expect(html).toContain('href="shopify://admin/transfers/77"');
    expect(html).toContain('target="_top"');
  });

  it("Pro, nothing to move", () => {
    const html = render(page({ enabled: true, groups: [], recent: [], hasWarehouse: true, hasStore: true }));
    expect(html).toContain("Nothing to move right now");
    expect(html).not.toContain("Create transfer in Shopify");
  });

  it("Pro without a warehouse and a store: points to Settings → Locations", () => {
    const html = render(page({ enabled: true, groups: [], recent: [], hasWarehouse: true, hasStore: false }));
    expect(html).toContain("Mark at least one warehouse and one store in Settings → Locations to get a transfer plan.");
    expect(html).toContain('href="/app/settings/locations"');
  });

  it("Growth: shown locked with what it does and the plans link", () => {
    const html = render(page({ enabled: false, groups: [], recent: [], hasWarehouse: false, hasStore: false }, false));
    expect(html).toContain("Transfers: warehouse → stores");
    expect(html).toContain("Pro plan");
    expect(html).toContain("Plan which stock to move from your warehouse to your stores, and create the transfer in Shopify.");
    expect(html).toContain('href="/app/plans?upgrade=transfers"');
    expect(html).not.toContain("Create transfer in Shopify");
  });
});
