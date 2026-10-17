/**
 * Location views on an in-memory Prisma (Phase 3, Pro): Products and Reorder read one
 * location's VariantMetric scope and its StockNow only; the Products location view lists
 * the variants with a metric there; a Keha order created from a location view records the
 * location's name in its note.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { listProducts } from "../app/models/products.server";
import { createOrderFromGroup, loadReorder } from "../app/models/reorder.server";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const WH = "gid://shopify/Location/1";
const STORE = "gid://shopify/Location/2";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const NO_FILTERS = { status: null, collection: null, vendor: null, q: null };

const variant = (n: number) => ({
  id: V(n),
  shop: S,
  productId: `P${n}`,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `S-${n}`,
  vendor: "Acme",
  image: null,
  tracked: true,
  isBundle: false,
  supplierId: null,
  caseQty: null,
  cost: 2,
  costCurrency: null,
});

const metric = (n: number, scope: string, over: Record<string, unknown> = {}) => ({
  shop: S,
  variantId: V(n),
  scope,
  status: "healthy",
  rate: 1,
  sigma: 0.5,
  daysLeft: 30,
  neverRunsOut: false,
  orderQty: null,
  orderBy: null,
  inputs: {},
  ...over,
});

beforeEach(() => {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "en", settings: {}, uninstalledAt: null }];
  fake.tables.location = [
    { id: WH, shop: S, name: "Main", active: true, online: true, role: "warehouse", onlinePool: null },
    { id: STORE, shop: S, name: "Barcelona", active: true, online: false, role: "store", onlinePool: false }, // left out of supplier orders (the default now counts every active location)
  ];
  fake.tables.variant = [variant(1), variant(2)];
  fake.tables.variantMetric = [
    metric(1, "online", { status: "healthy", orderQty: null }),
    metric(2, "online", { status: "healthy" }),
    // Only variant 1 is carried at the store, and it is running low there.
    metric(1, STORE, { status: "running_low", rate: 3, daysLeft: 2, orderQty: 12, orderBy: new Date("2026-10-18T00:00:00Z") }),
  ];
  fake.tables.stockNow = [
    { shop: S, variantId: V(1), locationId: WH, onHand: 200, incoming: 0 },
    { shop: S, variantId: V(2), locationId: WH, onHand: 50, incoming: 0 },
    { shop: S, variantId: V(1), locationId: STORE, onHand: 6, incoming: 2 },
  ];
  fake.tables.purchaseOrder = [];
  fake.tables.supplier = [];
});

describe("Products location view", () => {
  it("the pool view lists every variant with pool stock", async () => {
    const page = await listProducts(S, NO_FILTERS, 1, true);
    expect(page.rows.map((r) => [r.id, r.onHand, r.status])).toEqual([
      [V(1), 200, "healthy"],
      [V(2), 50, "healthy"],
    ]);
  });

  it("a store view lists only what the store carries, with the store's status and stock", async () => {
    const page = await listProducts(S, NO_FILTERS, 1, true, STORE);
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ id: V(1), status: "running_low", onHand: 6, incoming: 2, rate: 3, daysLeft: 2, orderQty: 12, orderBy: "2026-10-18" });
  });

  it("the status filter applies to the store's scope", async () => {
    expect((await listProducts(S, { ...NO_FILTERS, status: "running_low" }, 1, true, STORE)).total).toBe(1);
    expect((await listProducts(S, { ...NO_FILTERS, status: "running_low" }, 1, true)).total).toBe(0);
  });
});

describe("Reorder location view", () => {
  it("lines come from the store's metrics and stock, grouped by vendor / supplier as usual", async () => {
    const pool = await loadReorder(S);
    expect(pool.groups).toEqual([]); // nothing to order for the pool
    const store = await loadReorder(S, [], STORE);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0]!.lines[0]).toMatchObject({ variantId: V(1), onHand: 6, incoming: 2, suggested: 12, orderBy: "2026-10-18" });
  });

  it("an order created from a location view records the location in its note", async () => {
    const store = await loadReorder(S, [], STORE);
    const g = store.groups[0]!;
    const r = await createOrderFromGroup(S, g.key, { [V(1)]: 12 }, { scope: STORE, note: "Barcelona" });
    expect(r.ok).toBe(true);
    expect(fake.tables.purchaseOrder[0]).toMatchObject({ note: "Barcelona", status: "draft", source: "keha" });
    // An order from the online pool view has no location note.
    fake.tables.purchaseOrder[0]!.createdAt = new Date("2026-10-16T09:00:00Z");
    expect((await createOrderFromGroup(S, g.key, { [V(1)]: 12 })).ok).toBe(true);
    expect(fake.tables.purchaseOrder[1]).toMatchObject({ note: null });
  });
});
