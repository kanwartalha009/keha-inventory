/**
 * Purchase orders on an in-memory Prisma (task 2.2): PO numbers under a race,
 * status changes (sent stamps dates and the on-hand baseline), the supplier
 * page (link rules, ship date, rate limit), the Shopify purchase-order sync
 * (upsert, stale removal, ACCESS_DENIED never throws) and auto-receive.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] });
  // Defaults and the two unique indexes the code relies on.
  const po = (db.client as Record<string, Record<string, (...a: never[]) => unknown>>).purchaseOrder!;
  const create = po.create!.bind(po) as (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  let n = 0;
  (po as Record<string, unknown>).create = async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const rows = (db.tables.purchaseOrder ??= []);
    if (rows.some((r) => r.shop === data.shop && r.number === data.number) || rows.some((r) => r.confirmToken === data.confirmToken)) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    }
    const row = await create({ data: { id: `po${++n}`, createdAt: new Date("2026-10-16T09:00:00Z"), ...data } });
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
  };
  return { default: db.client, __fake: db };
});
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn(async () => { throw new Error("offline"); }) } }));

import * as dbModule from "../app/db.server";
import { insertWithNumber, transitionOrder, kehaOnOrder } from "../app/models/reorder.server";
import { allowConfirmRequest, confirmShipDate, lookupConfirm } from "../app/services/supplier-confirm.server";
import { autoReceiveOrders, syncShopifyPurchaseOrders } from "../app/services/sync/po.server";
import { loader as confirmLoader } from "../app/routes/supplier.confirm.$token";
import { deleteSupplier } from "../app/models/suppliers.server";
import { documentFor } from "../app/services/po-document.server";
import { getOrder } from "../app/models/reorder.server";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const V1 = "gid://shopify/ProductVariant/1";
const WH = "gid://shopify/Location/1";
const NOW = new Date("2026-10-16T10:00:00Z");
const line = (variantId: string, qty: number) => ({ variantId, qty, unitCost: 2, productTitle: "Shirt", variantTitle: "M", sku: "S-M" });

beforeEach(() => {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "UTC", locale: "es", settings: { leadTimeDays: 10 }, uninstalledAt: null }];
  fake.tables.location = [{ id: WH, shop: S, active: true, online: true }];
  fake.tables.stockNow = [{ shop: S, variantId: V1, locationId: WH, onHand: 4, incoming: 0, available: 4, committed: 0 }];
  fake.tables.supplier = [{ id: "s1", shop: S, name: "Acme", email: null, leadTimeDays: 21, hidePrices: true }];
});

describe("PO numbers", () => {
  it("numbers per shop and retries when another order took the number first", async () => {
    const a = await insertWithNumber(S, { status: "draft", source: "keha", lines: [] });
    expect(a.number).toBe("PO-0001");
    // Simulate a concurrent insert: the next findMany sees the old list, the create collides.
    const po = (fake.client as Record<string, Record<string, unknown>>).purchaseOrder!;
    const findMany = po.findMany as (args: unknown) => Promise<unknown[]>;
    let first = true;
    po.findMany = async (args: unknown) => {
      if (first) {
        first = false;
        const list = await findMany(args);
        fake.tables.purchaseOrder!.push({ id: "other", shop: S, number: "PO-0002", confirmToken: "zz" });
        return list;
      }
      return findMany(args);
    };
    const b = await insertWithNumber(S, { status: "draft", source: "keha", lines: [] });
    po.findMany = findMany;
    expect(b.number).toBe("PO-0003");
    // Another shop starts at 1.
    expect((await insertWithNumber("other.myshopify.com", { status: "draft", source: "keha", lines: [] })).number).toBe("PO-0001");
  });
});

describe("status changes", () => {
  it("sending stamps the expected arrival, the 60-day link and the on-hand baseline; receiving fills received", async () => {
    const { id } = await insertWithNumber(S, { status: "draft", source: "keha", supplierId: "s1", lines: [line(V1, 12)] });
    expect(await transitionOrder(S, id, "received", NOW)).toEqual({ ok: false, error: "notAllowed" });
    expect(await transitionOrder(S, id, "sent", NOW)).toEqual({ ok: true });
    const row = fake.tables.purchaseOrder!.find((r) => r.id === id)!;
    expect(row.status).toBe("sent");
    expect((row.expectedDate as Date).toISOString().slice(0, 10)).toBe("2026-11-06"); // supplier lead time 21
    expect((row.confirmExpiresAt as Date).toISOString()).toBe("2026-12-15T10:00:00.000Z");
    expect((row.lines as { baseOnHand?: number }[])[0]!.baseOnHand).toBe(4);
    expect((await kehaOnOrder(S, ["sent", "confirmed"])).get(V1)).toEqual({ qty: 12, arrival: "2026-11-06" });
    expect(await transitionOrder(S, id, "received", NOW)).toEqual({ ok: true });
    expect((fake.tables.purchaseOrder!.find((r) => r.id === id)!.lines as { received?: number }[])[0]!.received).toBe(12);
    expect(await transitionOrder("other.myshopify.com", id, "cancelled", NOW)).toEqual({ ok: false, error: "notFound" });
  });
});

describe("supplier page", () => {
  const token = "a".repeat(43);
  const seed = (over: Record<string, unknown> = {}) =>
    fake.tables.purchaseOrder!.push({
      id: "po9",
      shop: S,
      number: "PO-0009",
      status: "sent",
      source: "keha",
      supplierId: "s1",
      supplierName: "Acme",
      lines: [line(V1, 12)],
      confirmToken: token,
      confirmExpiresAt: new Date("2026-12-15T10:00:00Z"),
      confirmedShipDate: null,
      expectedDate: new Date("2026-11-06T00:00:00Z"),
      currency: "EUR",
      createdAt: NOW,
      ...over,
    });

  it("opens a sent order in the store language, without prices when hidden, and records the ship date", async () => {
    fake.tables.purchaseOrder = [];
    seed();
    const found = await lookupConfirm(token, NOW);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.locale).toBe("es");
      expect(found.view.hidePrices).toBe(true);
      expect(found.view.minDate).toBe("2026-10-16");
    }
    expect(await confirmShipDate(token, "2026-10-01", NOW)).toEqual({ ok: false, error: "date" });
    expect(await confirmShipDate(token, "2026-11-01", NOW)).toEqual({ ok: true, date: "2026-11-01" });
    const row = fake.tables.purchaseOrder![0]!;
    expect(row.status).toBe("confirmed");
    expect((row.confirmedShipDate as Date).toISOString().slice(0, 10)).toBe("2026-11-01");
  });

  it("refuses drafts, cancelled, expired, Shopify and unknown tokens the same way", async () => {
    for (const over of [{ status: "draft" }, { status: "cancelled" }, { status: "received" }, { source: "shopify" }, { confirmExpiresAt: new Date("2026-10-16T09:59:00Z") }]) {
      fake.tables.purchaseOrder = [];
      seed(over);
      expect(await lookupConfirm(token, NOW)).toEqual({ ok: false });
      expect(await confirmShipDate(token, "2026-11-01", NOW)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await lookupConfirm("b".repeat(43), NOW)).toEqual({ ok: false });
    expect(await lookupConfirm("short", NOW)).toEqual({ ok: false });
  });

  // Review fix 2026-10-17: the page's loader data is serialized into public HTML.
  const loadPage = async (t: string) => {
    const request = new Request(`https://x/supplier/confirm/${t}`, { headers: { "x-forwarded-for": "198.51.100.7" } });
    const r = (await confirmLoader({ request, params: { token: t }, context: {} } as never)) as unknown as { data: unknown };
    return JSON.stringify(r.data);
  };

  it("sends the browser no prices, stock or variant ids when prices are hidden", async () => {
    fake.tables.purchaseOrder = [];
    seed({ lines: [{ ...line(V1, 12), unitCost: 7.25, baseOnHand: 4, received: 3 }], confirmExpiresAt: new Date(Date.now() + 86_400_000) });
    const json = await loadPage(token);
    expect(json).toContain('"state":"open"');
    expect(json).toContain("Shirt");
    expect(json).toContain('"qty":12');
    for (const leak of ["unitCost", "7.25", "totalCost", "EUR", "baseOnHand", "received", "variantId", "gid://shopify"]) expect(json).not.toContain(leak);
  });

  it("with prices shown: unit costs and the total, still no stock or variant ids", async () => {
    fake.tables.purchaseOrder = [];
    fake.tables.supplier![0]!.hidePrices = false;
    seed({ lines: [{ ...line(V1, 12), unitCost: 7.25, baseOnHand: 4 }], confirmExpiresAt: new Date(Date.now() + 86_400_000) });
    const json = await loadPage(token);
    expect(json).toContain('"unitCost":7.25');
    expect(json).toContain('"totalCost":87');
    for (const leak of ["baseOnHand", "variantId", "gid://shopify"]) expect(json).not.toContain(leak);
  });

  it("deleting the supplier keeps its order's prices hidden (page, PDF / email input)", async () => {
    fake.tables.purchaseOrder = [];
    fake.tables.supplier![0]!.hidePrices = true;
    seed({ lines: [{ ...line(V1, 12), unitCost: 7.25 }] });
    expect(await deleteSupplier(S, "s1")).toBe(true);
    const found = await lookupConfirm(token, NOW);
    expect(found.ok && found.view.hidePrices).toBe(true);
    const order = await getOrder(S, "po9");
    const doc = await documentFor(S, order!, NOW);
    expect(doc.hidePrices).toBe(true);
    expect(JSON.stringify(doc.lines)).not.toContain("unitCost");
    // An order that never had a supplier (vendor group) still shows its prices.
    fake.tables.purchaseOrder = [];
    seed({ supplierId: null });
    const vendorOrder = await lookupConfirm(token, NOW);
    expect(vendorOrder.ok && vendorOrder.view.hidePrices).toBe(false);
  });

  it("rate-limits per token: 20 requests in 10 minutes", () => {
    const t = "r".repeat(43);
    const at = Date.parse("2026-10-16T10:00:00Z");
    for (let i = 0; i < 20; i++) {
      const req = new Request("https://x/supplier/confirm/t", { headers: { "x-forwarded-for": `10.0.0.${i}` } });
      expect(allowConfirmRequest(req, t, at + i)).toBe(true);
    }
    const req = new Request("https://x/supplier/confirm/t", { headers: { "x-forwarded-for": "10.0.1.1" } });
    expect(allowConfirmRequest(req, t, at + 30)).toBe(false);
    expect(allowConfirmRequest(req, t, at + 10 * 60 * 1000 + 1)).toBe(true);
  });
});

/** Fake Admin client answering the purchase-order query from `pages`. */
function admin(pages: unknown[][], opts: { deny?: boolean } = {}) {
  let call = 0;
  return {
    graphql: async (_q: string, o?: { variables?: Record<string, unknown> }) => {
      if (opts.deny) return Response.json({ errors: [{ message: "Access denied for inventoryPurchaseOrders field.", extensions: { code: "ACCESS_DENIED" } }] });
      const nodes = pages[call] ?? [];
      const hasNext = call < pages.length - 1;
      call++;
      void o;
      return Response.json({ data: { inventoryPurchaseOrders: { nodes, pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `c${call}` : null } } } });
    },
  };
}
const spo = (n: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/InventoryPurchaseOrder/${n}`,
  name: `#PO${n}`,
  status: "ORDERED",
  currency: "EUR",
  archivedAt: null,
  orderedAt: "2026-10-01T09:00:00Z",
  dateCreated: "2026-10-01T09:00:00Z",
  origin: { supplierName: "Zeta" },
  lineItems: {
    nodes: [{ id: "l1", title: "Shirt", variantTitle: "M", supplierSku: null, totalQuantity: 10, unitCost: { amount: "2", currencyCode: "EUR" }, inventoryItem: { id: "i1", sku: "S-M", variants: { nodes: [{ id: V1 }] } } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  transfers: { nodes: [] },
  ...over,
});

describe("Shopify purchase orders", () => {
  it("upserts across pages, marks them From Shopify, and removes orders gone from Shopify", async () => {
    fake.tables.purchaseOrder = [{ id: "old", shop: S, source: "shopify", shopifyPoId: "gid://shopify/InventoryPurchaseOrder/99", number: "#PO99", status: "sent", lines: [] }];
    const r = await syncShopifyPurchaseOrders(admin([[spo(1)], [spo(2, { name: "PO-0001" })]]) as never, S, { now: () => NOW.getTime() });
    expect(r).toEqual({ status: "done", upserted: 2, removed: 1 });
    const rows = fake.tables.purchaseOrder!;
    expect(rows.map((x) => [x.number, x.source, x.status, x.supplierName])).toEqual([
      ["#PO1", "shopify", "sent", "Zeta"],
      ["PO-0001", "shopify", "sent", "Zeta"],
    ]);
    // Run again: updates in place (no duplicates).
    await syncShopifyPurchaseOrders(admin([[spo(1, { archivedAt: "2026-10-10T00:00:00Z" })], [spo(2)]]) as never, S, { now: () => NOW.getTime() });
    expect(fake.tables.purchaseOrder!.length).toBe(2);
    expect(fake.tables.purchaseOrder![0]!.status).toBe("cancelled");
  });

  it("an ACCESS_DENIED store is skipped without throwing or deleting", async () => {
    fake.tables.purchaseOrder = [{ id: "keep", shop: S, source: "shopify", shopifyPoId: "gid://shopify/InventoryPurchaseOrder/5", number: "#PO5", status: "sent", lines: [] }];
    const r = await syncShopifyPurchaseOrders(admin([], { deny: true }) as never, S, { now: () => NOW.getTime() });
    expect(r.status).toBe("error");
    expect(fake.tables.purchaseOrder!.length).toBe(1);
  });
});

describe("auto-receive", () => {
  it("closes a sent order once the stock landed after the arrival date", async () => {
    fake.tables.purchaseOrder = [
      {
        id: "k1",
        shop: S,
        source: "keha",
        status: "sent",
        number: "PO-0001",
        sentAt: new Date("2026-10-01T10:00:00Z"),
        expectedDate: new Date("2026-10-15T00:00:00Z"),
        confirmedShipDate: null,
        lines: [{ ...line(V1, 20), baseOnHand: 2 }],
      },
      {
        id: "k2",
        shop: S,
        source: "keha",
        status: "sent",
        number: "PO-0002",
        sentAt: new Date("2026-10-10T10:00:00Z"),
        expectedDate: new Date("2026-10-30T00:00:00Z"),
        confirmedShipDate: null,
        lines: [{ ...line(V1, 20), baseOnHand: 2 }],
      },
    ];
    fake.tables.stockNow = [{ shop: S, variantId: V1, locationId: WH, onHand: 15, incoming: 0 }];
    fake.tables.salesDaily = [{ shop: S, variantId: V1, locationKey: "online", channel: "all", day: new Date("2026-10-05T00:00:00Z"), sold: 6 }];
    fake.tables.stockDaily = [];
    expect(await autoReceiveOrders(S, NOW)).toBe(1); // 15 − 2 + 6 = 19 of 20 (95%); k2 isn't due yet
    const [k1, k2] = fake.tables.purchaseOrder!;
    expect(k1!.status).toBe("received");
    expect((k1!.lines as { received?: number }[])[0]!.received).toBe(19);
    expect(k2!.status).toBe("sent");
  });
});
