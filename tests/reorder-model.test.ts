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
import { useFakeFacts } from "./helpers/fake-facts";
import {
  deleteDraft,
  insertWithNumber,
  kehaOnOrder,
  openOrderList,
  openOrders,
  pricingFor,
  receiveOrder,
  reopenOrder,
  staleDraftCount,
  transitionOrder,
  updateDraft,
} from "../app/models/reorder.server";
import { allowConfirmRequest, confirmShipDate, lookupConfirm } from "../app/services/supplier-confirm.server";
import { autoReceiveOrders, syncShopifyPurchaseOrders } from "../app/services/sync/po.server";
import { loader as confirmLoader } from "../app/routes/supplier.confirm.$token";
import { deleteSupplier } from "../app/models/suppliers.server";
import { documentFor } from "../app/services/po-document.server";
import { getOrder } from "../app/models/reorder.server";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(fake);
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

describe("open Keha units (ordering audit 2026-10-17)", () => {
  const po = (id: string, over: Record<string, unknown>) => ({ id, shop: S, number: id, source: "keha", status: "sent", supplierId: "s1", lines: [line(V1, 10)], confirmedShipDate: null, expectedDate: null, createdAt: NOW, ...over });

  it("transit: a confirmed ship date arrives the supplier's transit days later (Open orders too)", async () => {
    fake.tables.supplier = [{ id: "s1", shop: S, name: "Far", email: null, leadTimeDays: 45, transitDays: 21, hidePrices: false }];
    fake.tables.purchaseOrder = [po("a", { status: "confirmed", confirmedShipDate: new Date("2026-10-20T00:00:00Z"), expectedDate: new Date("2026-10-25T00:00:00Z") })];
    expect((await kehaOnOrder(S, ["sent", "confirmed"])).get(V1)).toEqual({ qty: 10, arrival: "2026-11-10" });
    expect((await openOrders(S))[0]!.arrival).toBe("2026-11-10");
    // Without a confirmed ship date: the lead-time estimate.
    fake.tables.purchaseOrder = [po("b", { expectedDate: new Date("2026-11-30T00:00:00Z") })];
    expect((await kehaOnOrder(S, ["sent"])).get(V1)!.arrival).toBe("2026-11-30");
  });

  it("drafts older than 14 days stop counting as ordered (and are counted for the banner)", async () => {
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    fake.tables.purchaseOrder = [po("old", { status: "draft", createdAt: days(20) }), po("new", { status: "draft", createdAt: days(3) }), po("sent", { createdAt: days(40) })];
    expect((await kehaOnOrder(S, ["draft", "sent", "confirmed"], undefined, { now: NOW })).get(V1)!.qty).toBe(20);
    // One rule for every reader (no opt-in any more): 12 days later the 3-day draft is 15 days old too.
    expect((await kehaOnOrder(S, ["draft", "sent", "confirmed"], undefined, { now: days(-12) })).get(V1)!.qty).toBe(10);
    expect(await staleDraftCount(S, NOW)).toBe(1);
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

  it("opens a sent order in the supplier's PO language (English by default, not the store's), without prices when hidden, and records the ship date", async () => {
    fake.tables.purchaseOrder = [];
    seed();
    const found = await lookupConfirm(token, NOW);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.locale).toBe("en");
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
  const k = (id: string, over: Record<string, unknown>) => ({
    id,
    shop: S,
    source: "keha",
    status: "sent",
    number: `PO-${id}`,
    supplierId: null,
    sentAt: new Date("2026-10-01T10:00:00Z"),
    expectedDate: new Date("2026-10-15T00:00:00Z"),
    confirmedShipDate: null,
    lines: [{ ...line(V1, 20), baseOnHand: 2 }],
    createdAt: new Date("2026-10-01T09:00:00Z"),
    ...over,
  });

  it("closes a sent order once the stock landed inside the arrival window, and marks it as automatic", async () => {
    fake.tables.purchaseOrder = [k("k1", {}), k("k2", { expectedDate: new Date("2026-10-30T00:00:00Z") })];
    fake.tables.stockNow = [{ shop: S, variantId: V1, locationId: WH, onHand: 15, incoming: 0 }];
    // Window of k1 opens 8 Oct (expected 15 Oct − 7): on hand 2 at the end of 7 Oct, 6 sold since.
    fake.tables.stockDaily = [{ shop: S, variantId: V1, locationId: WH, day: new Date("2026-10-07T00:00:00Z"), endUnits: 2 }];
    // Pool demand is the channel view (all channels, demandWhere); the location view is never added.
    fake.tables.salesDaily = [
      { shop: S, variantId: V1, locationKey: "all", channel: "Online Store", day: new Date("2026-10-10T00:00:00Z"), sold: 6 },
      { shop: S, variantId: V1, locationKey: "online", channel: "all", day: new Date("2026-10-10T00:00:00Z"), sold: 6 },
    ];
    expect(await autoReceiveOrders(S, NOW)).toBe(1); // 15 − 2 + 6 = 19 of 20 (95%); k2's window opens 23 Oct
    const [k1, k2] = fake.tables.purchaseOrder!;
    expect(k1!.status).toBe("received");
    expect((k1!.lines as { received?: number; autoReceived?: number }[])[0]).toMatchObject({ received: 19, autoReceived: 19, reopenReceived: 0 });
    expect(k2!.status).toBe("sent");
    // The merchant can undo it within 30 days: back to sent, nothing received.
    expect(await reopenOrder(S, "k1", NOW)).toEqual({ ok: true, to: "sent" });
    const back = fake.tables.purchaseOrder!.find((r) => r.id === "k1")!;
    expect(back.status).toBe("sent");
    expect(back.receivedAt).toBeNull();
    expect((back.lines as Record<string, unknown>[])[0]).not.toHaveProperty("received");
    expect((back.lines as Record<string, unknown>[])[0]).not.toHaveProperty("autoReceived");
  });

  it("a stock rise before the window opened (a correction) doesn't close the order", async () => {
    fake.tables.purchaseOrder = [k("k1", {})];
    fake.tables.stockNow = [{ shop: S, variantId: V1, locationId: WH, onHand: 22, incoming: 0 }];
    // +20 already on 5 Oct (a stock correction): on hand 22 at the end of 7 Oct, nothing since.
    fake.tables.stockDaily = [{ shop: S, variantId: V1, locationId: WH, day: new Date("2026-10-07T00:00:00Z"), endUnits: 22 }];
    fake.tables.salesDaily = [];
    expect(await autoReceiveOrders(S, NOW)).toBe(0);
    expect(fake.tables.purchaseOrder![0]!.status).toBe("sent");
  });

  it("one delivery closes one order, not two; arrival uses the supplier's transit days", async () => {
    fake.tables.supplier![0]!.transitDays = 30;
    fake.tables.purchaseOrder = [
      k("k1", {}),
      k("k3", { expectedDate: new Date("2026-10-14T00:00:00Z") }),
      // Ships 20 Oct + 30 transit days: its window opens on the ship date, still ahead.
      k("k4", { supplierId: "s1", status: "confirmed", confirmedShipDate: new Date("2026-10-20T00:00:00Z") }),
    ];
    fake.tables.stockNow = [{ shop: S, variantId: V1, locationId: WH, onHand: 22, incoming: 0 }];
    fake.tables.stockDaily = [
      { shop: S, variantId: V1, locationId: WH, day: new Date("2026-10-06T00:00:00Z"), endUnits: 2 },
      { shop: S, variantId: V1, locationId: WH, day: new Date("2026-10-07T00:00:00Z"), endUnits: 2 },
    ];
    fake.tables.salesDaily = [];
    expect(await autoReceiveOrders(S, NOW)).toBe(1);
    expect(fake.tables.purchaseOrder!.map((r) => r.status)).toEqual(["sent", "received", "confirmed"]);
    expect((await getOrder(S, "k4"))!.arrival).toBe("2026-11-19");
  });

  it("never touches drafts or partly hand-received orders", async () => {
    fake.tables.purchaseOrder = [
      k("d1", { status: "draft", sentAt: null }),
      k("m1", { lines: [{ ...line(V1, 20), baseOnHand: 2, received: 5 }] }),
    ];
    fake.tables.stockNow = [{ shop: S, variantId: V1, locationId: WH, onHand: 40, incoming: 0 }];
    fake.tables.stockDaily = [{ shop: S, variantId: V1, locationId: WH, day: new Date("2026-10-07T00:00:00Z"), endUnits: 2 }];
    fake.tables.salesDaily = [];
    expect(await autoReceiveOrders(S, NOW)).toBe(0);
  });
});

describe("draft edits, delete, receiving, re-open (merchant audit 2026-10-17)", () => {
  const V2 = "gid://shopify/ProductVariant/2";
  const seed = (over: Record<string, unknown> = {}) =>
    fake.tables.purchaseOrder!.push({
      id: "po1",
      shop: S,
      number: "PO-0001",
      status: "draft",
      source: "keha",
      supplierId: "s1",
      supplierName: "Acme",
      lines: [line(V1, 12), line(V2, 6)],
      confirmToken: "c".repeat(43),
      confirmExpiresAt: null,
      confirmedShipDate: null,
      expectedDate: null,
      currency: "EUR",
      sentAt: null,
      receivedAt: null,
      cancelledAt: null,
      createdAt: NOW,
      updatedAt: new Date("2026-10-16T09:30:00Z"),
      ...over,
    });
  const row = () => fake.tables.purchaseOrder!.find((r) => r.id === "po1")!;
  const qtys = () => (row().lines as { qty: number }[]).map((l) => l.qty);

  beforeEach(() => {
    fake.tables.purchaseOrder = [];
  });

  it("edits a draft's quantities and removes a line; refuses stale versions, sent orders and an empty draft", async () => {
    seed();
    expect(await updateDraft(S, "po1", [20, 0], "2026-10-16T09:30:00.000Z")).toEqual({ ok: true });
    expect(qtys()).toEqual([20]);
    expect(await updateDraft(S, "po1", [5], "2026-10-15T00:00:00.000Z")).toEqual({ ok: false, error: "changed" });
    expect(await updateDraft(S, "po1", [0])).toEqual({ ok: false, error: "empty" });
    expect(await updateDraft("other.myshopify.com", "po1", [5])).toEqual({ ok: false, error: "notFound" });
    row().status = "sent";
    expect(await updateDraft(S, "po1", [5])).toEqual({ ok: false, error: "notAllowed" });
    expect(qtys()).toEqual([20]);
  });

  it("deletes a draft only", async () => {
    seed({ status: "sent" });
    expect(await deleteDraft(S, "po1")).toEqual({ ok: false, error: "notAllowed" });
    row().status = "draft";
    expect(await deleteDraft("other.myshopify.com", "po1")).toEqual({ ok: false, error: "notFound" });
    expect(await deleteDraft(S, "po1")).toEqual({ ok: true });
    expect(fake.tables.purchaseOrder).toEqual([]);
  });

  it("receives part of an order (stays open, only the rest counts as on order), then closes the rest as short", async () => {
    seed({ status: "confirmed", sentAt: new Date("2026-10-01T10:00:00Z"), confirmedShipDate: new Date("2026-10-10T00:00:00Z") });
    expect(await receiveOrder(S, "po1", [0, 0], false, undefined, NOW)).toEqual({ ok: false, error: "nothing" });
    expect(await receiveOrder(S, "po1", [8, 0], false, undefined, NOW)).toEqual({ ok: true });
    expect(row().status).toBe("confirmed");
    expect((await kehaOnOrder(S, ["sent", "confirmed"])).get(V1)?.qty).toBe(4);
    expect(await receiveOrder(S, "po1", [2, 6], true, undefined, NOW)).toEqual({ ok: true });
    expect(row().status).toBe("received");
    expect((row().lines as { received?: number; reopenReceived?: number }[]).map((l) => [l.received, l.reopenReceived])).toEqual([
      [10, 8],
      [6, 0],
    ]);
    expect((await kehaOnOrder(S, ["sent", "confirmed"])).get(V1)).toBeUndefined();
    // Re-open: back to confirmed with the 8 received before it closed.
    expect(await reopenOrder(S, "po1", NOW)).toEqual({ ok: true, to: "confirmed" });
    expect((row().lines as { received?: number }[]).map((l) => l.received)).toEqual([8, undefined]);
    expect(await receiveOrder(S, "po1", [1, 0], false, "2026-01-01T00:00:00.000Z", NOW)).toEqual({ ok: false, error: "changed" });
  });

  it("re-opens a cancelled order within 30 days only", async () => {
    seed({ status: "cancelled", sentAt: new Date("2026-10-01T10:00:00Z"), cancelledAt: new Date("2026-10-10T00:00:00Z") });
    expect(await reopenOrder(S, "po1", new Date("2026-11-10T00:00:00Z"))).toEqual({ ok: false, error: "notAllowed" });
    expect(await reopenOrder(S, "po1", NOW)).toEqual({ ok: true, to: "sent" });
    expect(row().cancelledAt).toBeNull();
  });

  it("Mark as received keeps what re-opening needs", async () => {
    seed({ status: "sent", sentAt: new Date("2026-10-01T10:00:00Z"), lines: [{ ...line(V1, 12), received: 3 }] });
    expect(await transitionOrder(S, "po1", "received", NOW)).toEqual({ ok: true });
    expect((row().lines as { received?: number; reopenReceived?: number }[])[0]).toMatchObject({ received: 12, reopenReceived: 3 });
  });

  it("the order page data: supplier currency, transit, minimums, store currency", async () => {
    Object.assign(fake.tables.supplier![0]!, { currency: "USD", exchangeRate: new Prisma.Decimal("0.5"), transitDays: 35, minOrderValue: new Prisma.Decimal("100"), minOrderScope: "variant" });
    seed({ status: "confirmed", confirmedShipDate: new Date("2026-11-01T00:00:00Z") });
    const o = (await getOrder(S, "po1"))!;
    expect(o.storeCurrency).toBe("EUR");
    expect(o.arrival).toBe("2026-12-06");
    expect(o.supplier).toMatchObject({ currency: "USD", exchangeRate: 0.5, transitDays: 35, minOrderValue: 100 });
    expect(pricingFor(o)).toMatchObject({ currency: "USD", factor: 2, converted: true });
    // PDF / CSV / email input: supplier-currency prices (prices hidden for s1 → none at all).
    fake.tables.supplier![0]!.hidePrices = false;
    const doc = await documentFor(S, (await getOrder(S, "po1"))!, NOW);
    expect(doc.currency).toBe("USD");
    expect(doc.lines[0]!.unitCost).toBe(4);
    expect(doc.expectedDate).toBe("2026-12-06");
  });

  it("the Open orders list: arrival with transit, overdue, stale drafts, partial", async () => {
    fake.tables.supplier![0]!.transitDays = 10;
    seed({ id: "a", number: "PO-0001", status: "confirmed", sentAt: new Date("2026-09-20T00:00:00Z"), confirmedShipDate: new Date("2026-10-01T00:00:00Z"), lines: [{ ...line(V1, 12), received: 2 }] });
    seed({ id: "b", number: "PO-0002", status: "draft", createdAt: new Date("2026-09-25T00:00:00Z") });
    fake.tables.purchaseOrder!.push({ id: "c", shop: S, number: "#PO7", source: "shopify", status: "sent", lines: [], createdAt: NOW, supplierId: null });
    const { rows, today } = await openOrderList(S, NOW);
    expect(today).toBe("2026-10-16");
    expect(rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(rows[0]).toMatchObject({ arrival: "2026-10-11", ships: "2026-10-01", overdue: true, partial: true, remaining: 10, units: 12 });
    expect(rows[2]).toMatchObject({ stale: true, ageDays: 21 });
  });
});
