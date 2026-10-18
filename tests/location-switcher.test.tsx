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
  setNoReorder: vi.fn(async () => ({ ok: true, count: 2 })),
  scenarioPlanned: vi.fn(async () => new Map([["gid://shopify/ProductVariant/5", 40]])),
  listPlanningLocations: vi.fn(),
  activeLocations: vi.fn(),
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
  supplierFilterOptions: async () => [],
}));
vi.mock("../app/models/locations.server", () => ({ listPlanningLocations: m.listPlanningLocations, activeLocations: m.activeLocations }));
vi.mock("../app/models/reorder.server", () => ({
  loadReorder: m.loadReorder,
  createOrderFromGroup: m.createOrderFromGroup,
  setNoReorder: m.setNoReorder,
  scenarioPlanned: m.scenarioPlanned,
}));
vi.mock("../app/models/transfers.server", () => ({
  loadTransfers: async () => ({ groups: [], recent: [], hasWarehouse: true, hasStore: true }),
}));

import Products, { loader as productsLoader, type ProductsData } from "../app/routes/app.products";
import { loader as csvLoader } from "../app/routes/app.products.csv";
import { switcherMode } from "../app/components/location-switcher";
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
  m.activeLocations.mockResolvedValue([{ id: WH.id }, { id: STORE.id }, { id: "gid://shopify/Location/3" }]);
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
    expect(d.locationCount).toBe(3);
  });

  it("Products on Growth ignores it (and doesn't read the locations)", async () => {
    m.locations = false;
    const d = (await productsLoader(args("https://app.test/app/products?location=2"))) as ProductsData;
    expect(m.listProducts.mock.calls[0]![4]).toBe("online");
    expect(d.location).toBeNull();
    expect(d.locationsEnabled).toBe(false);
    expect(m.listPlanningLocations).not.toHaveBeenCalled();
    expect(d.locationCount).toBe(3); // the count is read on every plan: it decides whether the switcher shows
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

  it("Create order from a location view: the store's group, shipped to that location; Growth ignores the location", async () => {
    const post = (body: unknown) =>
      reorderAction(args("https://app.test/app/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const body = { intent: "create", groupKey: "vendor:acme", quantities: { "gid://shopify/ProductVariant/1": 12 }, location: "2" };
    await post(body);
    // Merchant audit 2026-10-18: the location is the order's ship-to (the model sets it from the scope), not its note.
    expect(m.createOrderFromGroup.mock.calls[0]![3]).toEqual({ scope: STORE.id });
    m.locations = false;
    await post(body);
    expect(m.createOrderFromGroup.mock.calls[1]![3]).toEqual({ scope: "online" });
  });

  it("Order now's links are resolved on the server: a supplier + date range, a Season plan scenario", async () => {
    await reorderLoader(args("https://app.test/app/reorder?supplier=supplier:s1&from=2026-10-16&to=2026-10-22"));
    expect(m.loadReorder.mock.calls[0]![5]).toEqual({ supplierKey: "supplier:s1", from: "2026-10-16", to: "2026-10-22" });
    await reorderLoader(args("https://app.test/app/reorder?scenario=sc1&group=supplier:s1"));
    expect(m.scenarioPlanned).toHaveBeenCalledWith("acme.myshopify.com", "sc1", "supplier:s1");
    expect([...(m.loadReorder.mock.calls[1]![3] as Map<string, number>)]).toEqual([["gid://shopify/ProductVariant/5", 40]]);
  });

  it("Don't reorder this product (line menu, confirmed): our database only", async () => {
    const post = (body: unknown) =>
      reorderAction(args("https://app.test/app/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(await post({ intent: "noReorder", productId: "gid://shopify/Product/7", value: true })).toEqual({ ok: true, intent: "noReorder", count: 2 });
    expect(m.setNoReorder).toHaveBeenCalledWith("acme.myshopify.com", { productId: "gid://shopify/Product/7" }, true);
    await expect(post({ intent: "noReorder", productId: "x" })).rejects.toBeInstanceOf(Response);
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
  locationCount: 3,
  ...over,
});

describe("switcherMode: one rule", () => {
  it("fewer than 2 locations: nothing; below Pro: teach; Pro: select, or set up when no warehouse / store", () => {
    expect(switcherMode({ enabled: false, planning: 0, locationCount: 1 })).toBe("none");
    expect(switcherMode({ enabled: true, planning: 1, locationCount: 1 })).toBe("none");
    expect(switcherMode({ enabled: true, planning: 0, locationCount: 0 })).toBe("none");
    expect(switcherMode({ enabled: false, planning: 0, locationCount: 2 })).toBe("teach");
    expect(switcherMode({ enabled: true, planning: 0, locationCount: 2 })).toBe("setup");
    expect(switcherMode({ enabled: true, planning: 2, locationCount: 3 })).toBe("select");
  });

  it("a location view stays switchable; callers without a count keep the old behaviour", () => {
    expect(switcherMode({ enabled: true, planning: 1, locationCount: 1, viewing: true })).toBe("select");
    expect(switcherMode({ enabled: false, planning: 0 })).toBe("teach");
    expect(switcherMode({ enabled: true, planning: 0 })).toBe("setup");
    expect(switcherMode({ enabled: true, planning: 2 })).toBe("select");
  });
});

describe("SSR: the switcher", () => {
  it("Pro: the pool and each warehouse / store", () => {
    const html = render("/app/products", "products", Products, products());
    expect(html).toContain("Stock included in purchase orders");
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

  it("R4: a warehouse that counts in supplier orders says its sales are a stock share of online sales (no fulfilment location)", () => {
    const html = render("/app/products?location=1", "products", Products, products({ location: { ...WH, inPool: true } }));
    expect(html).toContain("Shopify doesn&#x27;t report which warehouse shipped an online order, so its sales per day are its share of online sales by the stock it holds.");
    expect(html).not.toContain("Sales per day are this location&#x27;s own sales");
    // Left out of supplier orders: its own sales, as before.
    expect(render("/app/products?location=1", "products", Products, products({ location: { ...WH, inPool: false } }))).toContain("Sales per day are this location&#x27;s own sales");
  });

  it("Pro without warehouses or stores: points to Settings → Locations", () => {
    const html = render("/app/products", "products", Products, products({ locations: [] }));
    expect(html).toContain('href="/app/settings/locations"');
    expect(html).toContain("Set up warehouses and stores");
  });

  it("Growth with several locations: one compact teaching link (Pro tag, what it does), no disabled select", () => {
    const html = render("/app/products", "products", Products, products({ locationsEnabled: false, locations: [] }));
    expect(html).toContain("Plan per location · Pro plan");
    expect(html).toContain("Plan stock per warehouse and per POS store, each with its own sales.");
    expect(html).toContain('href="/app/plans?upgrade=locations"');
    expect(html).toContain('class="keha-switcher keha-switcher--link"');
    expect(html).not.toContain("Stock included in purchase orders</s-option>");
    expect(html).not.toMatch(/<s-select[^>]*disabled/);
  });

  it("one location: nothing on any plan", () => {
    for (const over of [{ locationsEnabled: false, locations: [] }, { locationsEnabled: true, locations: [] }, { locationsEnabled: true }]) {
      const html = render("/app/products", "products", Products, products({ ...over, locationCount: 1 }));
      expect(html).not.toContain("keha-switcher");
      expect(html).not.toContain("upgrade=locations");
      expect(html).not.toContain("Set up warehouses and stores");
    }
  });

  it("Pro: the select sits in the toolbar's filter group", () => {
    const html = render("/app/products", "products", Products, products());
    expect(html).toMatch(/<div class="keha-toolbar__filters"><div class="keha-toolbar__item"><div class="keha-switcher"><s-select/);
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
    expect(html).toContain("What Barcelona needs to order in the next 7 days");
    expect(html).toContain("Barcelona · Store");
  });
});
