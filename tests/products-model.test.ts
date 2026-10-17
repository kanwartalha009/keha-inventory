/**
 * Review fixes for models/products.server.ts (task 1.7):
 *  - SalesDaily holds two views of the same sales (by location, channel "all";
 *    by channel, locationKey "all"); the detail reads one, so 3 units show 3.
 *  - Stock now / incoming / sold-out days use the online stock pool (active
 *    locations that fulfil online orders), the same pool as the status.
 * A small in-memory Prisma fake applies the `where` filters the model sends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
      if ("gte" in c && !((v as Date) >= (c.gte as Date))) return false;
      if ("lt" in c && !((v as Date) < (c.lt as Date))) return false;
      return true;
    }
    return v === cond;
  });
}

const sum = (rows: Row[], field: string) => (rows.length ? rows.reduce((a, r) => a + (r[field] as number), 0) : null);

function groupBy(table: string) {
  return async (args: { by: string[]; where: Row; _sum: Record<string, true> }) => {
    const groups = new Map<string, Row[]>();
    for (const r of db[table]!.filter((r) => matches(r, args.where))) {
      const k = args.by.map((b) => String(r[b] instanceof Date ? (r[b] as Date).toISOString() : r[b])).join("|");
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.values()].map((rows) => ({
      ...Object.fromEntries(args.by.map((b) => [b, rows[0]![b]])),
      _sum: Object.fromEntries(Object.keys(args._sum).map((f) => [f, sum(rows, f)])),
    }));
  };
}

vi.mock("../app/db.server", () => ({
  default: {
    variant: {
      findFirst: async ({ where }: { where: Row }) => db.variant!.find((r) => matches(r, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => db.variant!.filter((r) => matches(r, where)),
      count: async ({ where }: { where: Row }) => db.variant!.filter((r) => matches(r, where)).length,
    },
    shop: { findUnique: async () => ({ timezone: "UTC" }) },
    location: { findMany: async ({ where }: { where: Row }) => db.location!.filter((r) => matches(r, where)) },
    variantMetric: {
      findUnique: async () => db.variantMetric![0] ?? null,
      findMany: async ({ where }: { where: Row }) => db.variantMetric!.filter((r) => matches(r, where)),
    },
    stockNow: {
      groupBy: groupBy("stockNow"),
      aggregate: async ({ where }: { where: Row }) => {
        const rows = db.stockNow!.filter((r) => matches(r, where));
        return { _sum: { onHand: sum(rows, "onHand"), incoming: sum(rows, "incoming") } };
      },
    },
    salesDaily: { groupBy: groupBy("salesDaily") },
    stockDaily: {
      findMany: async ({ where }: { where: Row }) => db.stockDaily!.filter((r) => matches(r, where)),
    },
    purchaseOrder: {
      findMany: async ({ where }: { where: Row }) => db.purchaseOrder!.filter((r) => matches(r, where)),
    },
    // The forward plan (To order, order-by date) reads the suppliers too.
    supplier: { findMany: async () => [] },
  },
}));

import { getVariantDetail, listProducts } from "../app/models/products.server";
import { dailySeries } from "../app/lib/products-shared";

const SHOP = "acme.myshopify.com";
const VID = "gid://shopify/ProductVariant/1";
const WH = "gid://shopify/Location/1"; // active, online → in the pool
const STORE = "gid://shopify/Location/2"; // POS store, not online
const OLD = "gid://shopify/Location/3"; // inactive
const NOW = new Date("2026-10-16T12:00:00Z");
const day = (d: string) => new Date(`${d}T00:00:00Z`);

beforeEach(() => {
  db.variant = [
    { id: VID, shop: SHOP, productTitle: "Shirt", variantTitle: "M", sku: "S-M", vendor: "Acme", image: null, tracked: true, isBundle: false },
  ];
  db.location = [
    { id: WH, shop: SHOP, active: true, online: true },
    { id: STORE, shop: SHOP, active: true, online: false, onlinePool: false }, // left out of supplier orders (the default now counts every active location)
    { id: OLD, shop: SHOP, active: false, online: true },
  ];
  db.variantMetric = [
    { shop: SHOP, variantId: VID, scope: "online", status: "out", rate: 1, daysLeft: 0, neverRunsOut: false, orderQty: 5, orderBy: null, sigma: 1, inputs: {} },
  ];
  db.stockNow = [
    { shop: SHOP, variantId: VID, locationId: WH, onHand: 0, incoming: 6 },
    { shop: SHOP, variantId: VID, locationId: STORE, onHand: 40, incoming: 10 },
    { shop: SHOP, variantId: VID, locationId: OLD, onHand: 7, incoming: 0 },
  ];
  // 3 units sold on 2026-10-15, stored in BOTH views (as facts-shared writes them).
  db.salesDaily = [
    { shop: SHOP, variantId: VID, day: day("2026-10-15"), locationKey: "online", channel: "all", sold: 3 },
    { shop: SHOP, variantId: VID, day: day("2026-10-15"), locationKey: "all", channel: "Online Store", sold: 2 },
    { shop: SHOP, variantId: VID, day: day("2026-10-15"), locationKey: "all", channel: "Shop", sold: 1 },
  ];
  db.stockDaily = [
    { shop: SHOP, variantId: VID, day: day("2026-10-14"), locationId: WH, outOfStock: true },
    { shop: SHOP, variantId: VID, day: day("2026-10-14"), locationId: STORE, outOfStock: false },
  ];
  db.purchaseOrder = [];
});

describe("products model (review fixes)", () => {
  it("detail: 3 units sold in one day show 3, not 6 (one sales view only)", async () => {
    const d = await getVariantDetail(SHOP, VID, true, NOW);
    expect(d!.sales).toEqual([{ day: day("2026-10-15"), sold: 3 }]);
    const series = dailySeries(d!.sales, d!.stock, d!.today);
    expect(series.find((x) => x.day === "2026-10-15")!.sold).toBe(3);
  });

  it("detail: stock now, incoming and sold-out days use the online pool", async () => {
    const d = await getVariantDetail(SHOP, VID, true, NOW);
    expect(d!.row).toMatchObject({ status: "out", onHand: 0, incoming: 6 });
    // The POS store had stock on the 14th, but the online pool was out.
    const series = dailySeries(d!.sales, d!.stock, d!.today);
    expect(series.find((x) => x.day === "2026-10-14")!.out).toBe(true);
  });

  it("table: a row can't read 'Stock now 40 · Out'", async () => {
    const page = await listProducts(SHOP, { status: null, collection: null, vendor: null, q: null }, 1, true);
    expect(page.rows[0]).toMatchObject({ status: "out", onHand: 0, incoming: 6 });
  });

  it("no online locations: stock is unknown (—), never 0", async () => {
    db.location = [{ id: STORE, shop: SHOP, active: true, online: false, onlinePool: false }]; // left out of supplier orders (the default now counts every active location)
    const page = await listProducts(SHOP, { status: null, collection: null, vendor: null, q: null }, 1, true);
    expect(page.rows[0]).toMatchObject({ onHand: null, incoming: null });
  });
  it("Keha orders show as 'on order', beside Shopify's incoming, never added to it (task 2.2)", async () => {
    const line = (qty: number, received?: number) => ({ variantId: VID, qty, unitCost: null, productTitle: "Shirt", variantTitle: "M", sku: "S-M", received });
    db.purchaseOrder = [
      { shop: SHOP, source: "keha", status: "sent", lines: [line(12)], confirmedShipDate: null, expectedDate: day("2026-11-02") },
      { shop: SHOP, source: "keha", status: "confirmed", lines: [line(5, 2)], confirmedShipDate: day("2026-10-28"), expectedDate: day("2026-11-09") },
      { shop: SHOP, source: "keha", status: "draft", lines: [line(100)], confirmedShipDate: null, expectedDate: null },
      { shop: SHOP, source: "shopify", status: "sent", lines: [line(40)], confirmedShipDate: null, expectedDate: null },
    ];
    const page = await listProducts(SHOP, { status: null, collection: null, vendor: null, q: null }, 1, true);
    expect(page.rows[0]!.incoming).toBe(6); // Shopify's pool incoming, unchanged
    expect(page.rows[0]!.onOrder).toBe(15); // 12 sent + (5 − 2) confirmed; drafts and Shopify POs excluded
    expect(page.rows[0]!.onOrderArrival).toBe("2026-10-28");
    const d = await getVariantDetail(SHOP, VID, true, NOW);
    expect(d!.row.onOrder).toBe(15);
  });
});
