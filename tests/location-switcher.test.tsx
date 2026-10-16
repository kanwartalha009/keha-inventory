/**
 * The location switcher (Phase 3, Pro `locations`): Products, its CSV and Reorder honour
 * `?location=` on Pro for a warehouse / store of this shop and ignore it otherwise (Growth,
 * unknown ids); a Reorder order created from a location view carries the location; SSR of
 * the switcher (Pro, Pro without locations, Growth locked) and of both location views.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

const m = vi.hoisted(() => ({
  locations: true,
  listProducts: vi.fn(),
  allProducts: vi.fn(),
  loadReorder: vi.fn(),
  createOrderFromGroup: vi.fn(),
  listPlanningLocations: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: "acme.myshopify.com" }, admin: { graphql: vi.fn() } })) },
}));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({
  getEntitlements: async () => ({
    plan: m.locations ? "pro" : "growth",
    features: { forecast: true, csvExport: true, reorderPlan: true, locations: m.locations, transfers: m.locations },
    comped: false,
    checked: true,
  }),
  upgradeResponse: (feature: string) => Response.json({ ok: false, upgrade: { feature } }, { status: 403 }),
}));
vi.mock("../app/models/products.server", () => ({
  listProducts: m.listProducts,
  allProducts: m.allProducts,
  productFilterOptions: async () => ({ vendors: [], collections: [] }),
}));
vi.mock("../app/models/locations.server", () => ({ listPlanningLocations: m.listPlanningLocations }));
vi.mock("../app/models/reorder.server", () => ({ loadReorder: m.loadReorder, createOrderFromGroup: m.createOrderFromGroup }));
vi.mock("../app/models/transfers.server", () => ({
  loadTransfers: async () => ({ groups: [], recent: [], hasWarehouse: true, hasStore: true }),
}));

import Products, { loader as productsLoader, type ProductsData } from "../app/routes/app.products";
import { loader as csvLoader } from "../app/routes/app.products.csv";
import Reorder, { action as reorderAction, loader as reorderLoader, type ReorderPageData } from "../app/routes/app.reorder";
import { pageInfo } from "../app/lib/products-shared";
import type { PlanningLocation } from "../app/lib/locations-shared";

const WH: PlanningLocation = { id: "gid://shopify/Location/1", name: "Main", role: "warehouse" };
const STORE: PlanningLocation = { id: "gid://shopify/Location/2", name: "Barcelona", role: "store" };

const args = (url: string, init?: RequestInit) => ({ request: new Request(url, init), params: {}, context: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.locations = true;
  m.listPlanningLocations.mockResolvedValue([WH, STORE]);
  m.listProducts.mockResolvedValue({ rows: [], total: 0, info: pageInfo(0, 1) });
  m.allProducts.mockResolvedValue([]);
  m.loadReorder.mockResolvedValue({ groups: [], openOrders: [], currency: "EUR", missingSelected: 0 });
  m.createOrderFromGroup.mockResolvedValue({ ok: true, id: "po1", number: "PO-0001" });
});

describe("server: ?location", () => {
  it("Products on Pro reads the store's scope", async () => {
    const d = (await productsLoader(args("https://app.test/app/products?location=2"))) as ProductsData;
    expect(m.listProducts.mock.calls[0]![4]).toBe(STORE.id);
    expect(d.location).toEqual(STORE);
    expect(d.locations).toEqual([WH, STORE]);
  });

  it("Products on Growth ignores it (and doesn't read the locations)", async () => {
    m.locations = false;
    const d = (await productsLoader(args("https://app.test/app/products?location=2"))) as ProductsData;
    expect(m.listProducts.mock.calls[0]![4]).toBe("online");
    expect(d.location).toBeNull();
    expect(d.locationsEnabled).toBe(false);
    expect(m.listPlanningLocations).not.toHaveBeenCalled();
  });

  it("an id that isn't one of the shop's warehouses / stores is the online pool", async () => {
    await productsLoader(args("https://app.test/app/products?location=99"));
    expect(m.listProducts.mock.calls[0]![4]).toBe("online");
  });

  it("the CSV follows the same location view on Pro only", async () => {
    await csvLoader(args("https://app.test/app/products/csv?location=2&lang=en"));
    expect(m.allProducts.mock.calls[0]![3]).toBe(STORE.id);
    m.locations = false;
    await csvLoader(args("https://app.test/app/products/csv?location=2&lang=en"));
    expect(m.allProducts.mock.calls[1]![3]).toBe("online");
  });

  it("Reorder on Pro reads the store's scope; on Growth the pool", async () => {
    const d = (await reorderLoader(args("https://app.test/app/reorder?location=2"))) as ReorderPageData;
    expect(m.loadReorder.mock.calls[0]![2]).toBe(STORE.id);
    expect(d.location).toEqual(STORE);
    m.locations = false;
    const g = (await reorderLoader(args("https://app.test/app/reorder?location=2"))) as ReorderPageData;
    expect(m.loadReorder.mock.calls[1]![2]).toBe("online");
    expect(g.location).toBeNull();
  });

  it("Create order from a location view: the store's group, its name in the note; Growth ignores the location", async () => {
    const post = (body: unknown) =>
      reorderAction(args("https://app.test/app/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const body = { intent: "create", groupKey: "vendor:acme", quantities: { "gid://shopify/ProductVariant/1": 12 }, location: "2" };
    await post(body);
    expect(m.createOrderFromGroup.mock.calls[0]![3]).toEqual({ scope: STORE.id, note: "Barcelona" });
    m.locations = false;
    await post(body);
    expect(m.createOrderFromGroup.mock.calls[1]![3]).toEqual({ scope: "online", note: null });
  });
});

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const products = (over: Partial<ProductsData> = {}): ProductsData => ({
  rows: [],
  total: 0,
  info: pageInfo(0, 1),
  filters: { status: null, collection: null, vendor: null, q: null },
  options: { vendors: [], collections: [] },
  forecast: true,
  csv: true,
  locationsEnabled: true,
  locations: [WH, STORE],
  location: null,
  ...over,
});

describe("SSR: the switcher", () => {
  it("Pro: the pool and each warehouse / store", () => {
    const html = render("/app/products", "products", Products, products());
    expect(html).toContain("Online stock pool");
    expect(html).toContain("Main · Warehouse");
    expect(html).toContain("Barcelona · Store");
    expect(html).not.toContain("upgrade=locations");
  });

  it("Pro, store view: says whose stock and sales the table shows; empty state until the nightly run", () => {
    const html = render("/app/products?location=2", "products", Products, products({ location: STORE }));
    expect(html).toContain("Stock at Barcelona only.");
    expect(html).toContain("Sales per day are this location&#x27;s own sales");
    expect(html).toContain("No numbers for this location yet.");
  });

  it("Pro without warehouses or stores: points to Settings → Locations", () => {
    const html = render("/app/products", "products", Products, products({ locations: [] }));
    expect(html).toContain('href="/app/settings/locations"');
    expect(html).toContain("Set up warehouses and stores");
  });

  it("Growth: shown disabled with the Pro tag, what it does, and the plans link", () => {
    const html = render("/app/products", "products", Products, products({ locationsEnabled: false, locations: [] }));
    expect(html).toContain("Online stock pool");
    expect(html).toContain("Pro plan");
    expect(html).toContain("Plan stock per warehouse and per POS store, each with its own sales.");
    expect(html).toContain('href="/app/plans?upgrade=locations"');
    expect(html).toMatch(/<s-select[^>]*disabled/);
  });

  it("Reorder store view: the store's needs, with the switcher", () => {
    const d: ReorderPageData = {
      enabled: true,
      groups: [],
      openOrders: [],
      currency: "EUR",
      missingSelected: 0,
      locationsEnabled: true,
      locations: [WH, STORE],
      location: STORE,
      transfers: { enabled: true, groups: [], recent: [], hasWarehouse: true, hasStore: true },
    };
    const html = render("/app/reorder?location=2", "reorder", Reorder, d);
    expect(html).toContain("What Barcelona needs, from each supplier");
    expect(html).toContain("Barcelona · Store");
  });
});
