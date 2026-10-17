/**
 * Merchant audit 2026-10-18 on an in-memory Prisma: purchase-order ship-to and note (builder
 * create, draft edit, the default), the document in the supplier's language with its details
 * (PDF input, CSV), and the other model-level fixes of that round.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ shop: ["domain"] }, ["purchaseOrder"]);
  return { default: db.client, __fake: db };
});
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/services/shop-contact.server", () => ({ getShopContact: async () => ({ name: "Moda Norte", contactEmail: null, ownerEmail: null }) }));
vi.mock("../app/services/po-parties.server", () => ({
  poBuyer: async () => ({ name: "Moda Norte SL", lines: ["Calle Mayor 1", "28013 Madrid", "Spain"] }),
  poShipTo: async (_shop: string, id: string) => (id === "gid://shopify/Location/2" ? { name: "Getafe warehouse", lines: ["Polígono Sur 4", "28906 Getafe"] } : null),
}));

import * as dbModule from "../app/db.server";
import { useFakeFacts } from "./helpers/fake-facts";
import { getOrder, updateDraft } from "../app/models/reorder.server";
import { createSupplierDraft } from "../app/models/supplier-order.server";
import { documentFor } from "../app/services/po-document.server";
import { renderPoPdf } from "../app/services/po-pdf.server";
import { translate } from "../app/lib/i18n";
import { poDetailRows } from "../app/lib/po-document-shared";

const fake = (dbModule as unknown as { __fake: FakeDb }).__fake;
useFakeFacts(fake);
const S = "moda.myshopify.com";
const L1 = "gid://shopify/Location/1";
const L2 = "gid://shopify/Location/2";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const NOW = new Date("2026-10-18T10:00:00Z");

/** The order just created, with the database defaults the in-memory Prisma doesn't fill. */
function created() {
  const po = fake.tables.purchaseOrder[fake.tables.purchaseOrder.length - 1]!;
  po.createdAt = NOW;
  po.updatedAt = NOW;
  return po;
}

const variant = (n: number) => ({
  id: V(n),
  shop: S,
  productId: `P${n}`,
  productTitle: `Coat ${n}`,
  variantTitle: "M",
  sku: `C-${n}`,
  vendor: "Ningbo",
  image: null,
  tracked: true,
  isBundle: false,
  supplierId: null,
  caseQty: null,
  cost: 20,
  costCurrency: null,
  price: 90,
  supplierCode: null,
});

beforeEach(() => {
  fake.reset();
  fake.tables.shop = [{ domain: S, currency: "EUR", timezone: "Europe/Madrid", locale: "es", settings: { leadTimeDays: 14, cycleDays: 14 }, uninstalledAt: null }];
  fake.tables.location = [
    { id: L1, shop: S, name: "Barcelona store", active: true, online: false, role: "store", onlinePool: null },
    { id: L2, shop: S, name: "Getafe warehouse", active: true, online: true, role: "warehouse", onlinePool: null },
  ];
  fake.tables.variant = [variant(1), variant(2)];
  fake.tables.variantMetric = [];
  fake.tables.stockNow = [];
  fake.tables.purchaseOrder = [];
  fake.tables.supplier = [
    {
      id: "s1",
      shop: S,
      name: "Ningbo Knits",
      email: null,
      leadTimeDays: 60,
      transitDays: 35,
      minOrder: null,
      minOrderTotal: null,
      casePack: null,
      vendorMatch: ["Ningbo"],
      currency: null,
      orderCycleDays: null,
      minOrderValue: null,
      minOrderScope: "variant",
      exchangeRate: null,
      hidePrices: false,
      depositPercent: 30,
      balanceDue: "ship",
      balanceDays: null,
      landedCostPercent: 12,
      poLanguage: null,
      incoterms: "FOB Ningbo",
      updatedAt: NOW,
    },
  ];
});

describe("ship-to and the note", () => {
  it("the builder's draft keeps a valid ship-to and the note; a made-up location falls back to the main warehouse", async () => {
    const a = await createSupplierDraft(S, "supplier:s1", { [V(1)]: 12 }, { shipTo: L1, note: "  Pack per size " });
    expect(a).toMatchObject({ ok: true });
    expect(fake.tables.purchaseOrder[0]).toMatchObject({ shipToLocationId: L1, note: "Pack per size" });
    await createSupplierDraft(S, "supplier:s1", { [V(2)]: 6 }, { shipTo: "gid://shopify/Location/999" });
    expect(fake.tables.purchaseOrder[1]).toMatchObject({ shipToLocationId: L2, note: null });
    expect(await createSupplierDraft(S, "supplier:s1", { [V(2)]: 6 }, { note: "x".repeat(1001) })).toEqual({ ok: false, error: "invalid" });
  });

  it("a draft's ship-to and note are edited with its quantities; an unknown location is refused", async () => {
    await createSupplierDraft(S, "supplier:s1", { [V(1)]: 12 });
    const po = created();
    expect(await updateDraft(S, po.id as string, [12], NOW.toISOString(), { shipTo: L1, note: "Label in Spanish" })).toEqual({ ok: true });
    expect(po).toMatchObject({ shipToLocationId: L1, note: "Label in Spanish" });
    po.updatedAt = NOW;
    expect(await updateDraft(S, po.id as string, [12], NOW.toISOString(), { shipTo: "gid://shopify/Location/999", note: "" })).toEqual({ ok: false, error: "invalid" });
    expect(po).toMatchObject({ shipToLocationId: L1, note: "Label in Spanish" });
  });
});

describe("the document", () => {
  it("is in English for a supplier without a language (the store is Spanish), with buyer, ship-to, terms, Incoterms, dates and note", async () => {
    await createSupplierDraft(S, "supplier:s1", { [V(1)]: 12 }, { note: "Label cartons with the PO number" });
    const order = (await getOrder(S, created().id as string))!;
    const doc = await documentFor(S, order, NOW);
    expect(doc.locale).toBe("en");
    const rows = poDetailRows(doc.details!, (k) => k, (d) => d);
    expect(rows).toEqual([
      { label: "Buyer", lines: ["Moda Norte SL", "Calle Mayor 1", "28013 Madrid", "Spain"] },
      { label: "Ship to", lines: ["Getafe warehouse", "Polígono Sur 4", "28906 Getafe"] },
      { label: "Payment terms", lines: ["30% deposit, 70% at shipment"] },
      { label: "Delivery terms (Incoterms)", lines: ["FOB Ningbo"] },
      // A draft: as if sent today — arrival 18 Oct + 60 days, ship = arrival − 35 days in transit.
      { label: "Expected ship date", lines: ["2026-11-12"] },
      { label: "Expected arrival", lines: ["2026-12-17"] },
      { label: "Note", lines: ["Label cartons with the PO number"] },
    ]);
    const pdf = await renderPoPdf(doc);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("follows the supplier's PO language", async () => {
    fake.tables.supplier[0]!.poLanguage = "pl";
    await createSupplierDraft(S, "supplier:s1", { [V(1)]: 12 });
    const doc = await documentFor(S, (await getOrder(S, created().id as string))!, NOW);
    expect(doc.locale).toBe("pl");
    expect(poDetailRows(doc.details!, (k) => translate("pl", k), (d) => d)[0]!.label).toBe(translate("pl", "Buyer"));
  });
});
