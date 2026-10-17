/**
 * SSR: the merchant audit 2026-10-18 fixes on their screens — ship-to and the note on the
 * supplier order builder and a draft's page (read-only once sent), the purchase-order language
 * and Incoterms in Settings → Suppliers.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn(() => new Response("upgrade", { status: 403 })) }));

import OrderPage, { type OrderPageView } from "../app/routes/app.reorder_.$id";
import Builder, { type BuilderPageData } from "../app/routes/app.reorder_.build";
import SuppliersSettings, { type SuppliersData } from "../app/routes/app.settings_.suppliers";
import type { OrderDetail } from "../app/models/reorder.server";
import { buildSupplierOrder } from "../app/lib/supplier-order-shared";
import { orderNowFixture } from "./order-plan-fixtures";

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const CHOICES = [
  { id: "gid://shopify/Location/1", name: "Getafe warehouse" },
  { id: "gid://shopify/Location/2", name: "Barcelona store" },
];

const order = (over: Partial<OrderDetail> = {}): OrderDetail => ({
  id: "po1",
  number: "PO-0001",
  source: "keha",
  status: "draft",
  supplierId: "s1",
  supplierName: "Ningbo Knits",
  supplier: { name: "Ningbo Knits", hasEmail: true, hidePrices: false, leadTimeDays: 60, transitDays: 35, currency: null, exchangeRate: null, minOrder: null, minOrderTotal: null, minOrderValue: null, minOrderScope: "variant" },
  lines: [{ variantId: "gid://shopify/ProductVariant/1", qty: 12, unitCost: 20, productTitle: "Coat", variantTitle: "M", sku: "C-M" }],
  currency: "EUR",
  storeCurrency: "EUR",
  confirmToken: "",
  confirmExpiresAt: null,
  confirmedShipDate: null,
  expectedDate: null,
  arrival: null,
  sentAt: null,
  receivedAt: null,
  cancelledAt: null,
  createdAt: "2026-10-16T10:00:00Z",
  updatedAt: "2026-10-16T10:00:00.000Z",
  shipToLocationId: "gid://shopify/Location/2",
  note: "Label cartons with the PO number",
  ...over,
});

const orderPage = (o: OrderDetail): OrderPageView => ({
  enabled: true,
  order: o,
  link: null,
  hidePrices: false,
  features: { poExport: true, supplierConfirm: true },
  today: "2026-10-18",
  stale: false,
  reopenTo: null,
  shipTo: { choices: CHOICES, current: o.shipToLocationId ?? null },
});

describe("Ship-to and the note on a purchase order", () => {
  it("a draft: pick the location and write the note, saved with the quantities", () => {
    const h = render("/app/reorder/po1", "order", OrderPage, orderPage(order()));
    expect(h).toContain("Ship to");
    expect(h).toContain("Getafe warehouse");
    expect(h).toContain("Barcelona store");
    expect(h).toContain("<s-text-area");
    expect(h).toContain("Note to the supplier");
    expect(h).toContain("Label cartons with the PO number");
    expect(h).toContain('id="keha-po-draft"');
  });

  it("sent: read-only rows", () => {
    const h = render("/app/reorder/po1", "order", OrderPage, orderPage(order({ status: "sent", sentAt: "2026-10-17T10:00:00Z", arrival: "2026-12-16", expectedDate: "2026-12-16" })));
    expect(h).not.toContain("<s-text-area");
    expect(h).toContain("Barcelona store");
    expect(h).toContain("Label cartons with the PO number");
  });

  it("the builder asks for both before the draft is created", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const view = buildSupplierOrder({ plan, supplierKey: "supplier:s1", info: { ...plan.suppliers["supplier:s1"]!, orderCycleDays: 30 }, storeCycleDays: 14 });
    const data: BuilderPageData = { enabled: true, view, today: plan.today, shipTo: { choices: CHOICES, default: CHOICES[0]!.id } };
    const h = render("/app/reorder/build?supplier=supplier:s1", "build", Builder, data);
    expect(h).toContain("Ship to");
    expect(h).toContain("Getafe warehouse");
    expect(h).toContain("Note to the supplier");
  });
});

describe("Settings → Suppliers: order language and Incoterms", () => {
  it("the list says which language the orders are in, with the Incoterms", () => {
    const data: SuppliersData = {
      suppliers: [
        { id: "s1", name: "Ningbo Knits", hasEmail: true, leadTimeDays: 60, minOrder: null, minOrderTotal: null, casePack: null, transitDays: 35, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: [], products: 0, poLanguage: "en", incoterms: "FOB Ningbo" },
        { id: "s2", name: "Istanbul Denim", hasEmail: true, leadTimeDays: 21, minOrder: null, minOrderTotal: null, casePack: null, transitDays: null, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: [], products: 0, poLanguage: "de", incoterms: null },
      ],
      vendors: [],
      currency: "EUR",
      enabled: true,
      editing: null,
    };
    const h = render("/app/settings/suppliers", "suppliers", SuppliersSettings, data);
    expect(h).toContain("Order language: English · FOB Ningbo");
    expect(h).toContain("Order language: Deutsch");
  });
});
