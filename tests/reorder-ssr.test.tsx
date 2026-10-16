/**
 * SSR (task 2.2): the Reorder screen, a purchase order and the public
 * supplier page. Plus the PDF smoke test.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));

import Reorder, { type ReorderPageData } from "../app/routes/app.reorder";
import OrderPage, { loader as orderLoader, type OrderPageData, type OrderPageView } from "../app/routes/app.reorder_.$id";
import { authenticate } from "../app/shopify.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { featureMap } from "../app/lib/plan-shared";
import SupplierConfirm, { type ConfirmPageData } from "../app/routes/supplier.confirm.$token";
import { buildReorderGroups, type ReorderVariantIn } from "../app/lib/reorder-shared";
import { renderPoPdf, pdfSafe } from "../app/services/po-pdf.server";
import type { OrderDetail } from "../app/models/reorder.server";
import type { PoLine } from "../app/lib/supplier-shared";

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const v = (n: number, over: Partial<ReorderVariantIn> = {}): ReorderVariantIn => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
  vendor: "Acme",
  image: null,
  supplierId: null,
  caseQty: null,
  cost: 2.5,
  costCurrency: "EUR",
  ...over,
});

function reorderData(): ReorderPageData {
  const groups = buildReorderGroups({
    variants: [v(1), v(2, { vendor: "Beta" }), v(3, { cost: null })],
    metrics: new Map([
      [v(1).id, { orderQty: 7, orderBy: "2026-11-12", daysLeft: 9.6, neverRunsOut: false, rate: 2 }],
      [v(2).id, { orderQty: 4, orderBy: null, daysLeft: null, neverRunsOut: false, rate: null }],
      [v(3).id, { orderQty: 3, orderBy: "2026-11-20", daysLeft: 30, neverRunsOut: false, rate: 1 }],
    ]),
    stock: new Map([[v(1).id, { onHand: 12, incoming: 4 }]]),
    onOrder: new Map([[v(1).id, 0]]),
    suppliers: [
      { id: "s1", name: "Acme Textiles", leadTimeDays: 30, minOrder: null, minOrderTotal: 40, casePack: 6, vendorMatch: ["Acme"], currency: null, hasEmail: true },
    ],
    storeCurrency: "EUR",
    defaultLeadTimeDays: 14,
    selected: new Set([v(1).id]),
  });
  return {
    enabled: true,
    locationsEnabled: false,
    locations: [],
    location: null,
    transfers: { enabled: false, groups: [], recent: [], hasWarehouse: false, hasStore: false },
    groups,
    currency: "EUR",
    missingSelected: 0,
    openOrders: [
      { id: "po1", number: "PO-0001", source: "keha", status: "sent", supplierName: "Acme Textiles", units: 24, cost: 60, currency: "EUR", arrival: "2026-11-02", createdAt: "2026-10-01T00:00:00Z" },
      { id: "po2", number: "#PO7", source: "shopify", status: "sent", supplierName: "Zeta", units: 10, cost: null, currency: "EUR", arrival: null, createdAt: "2026-10-02T00:00:00Z" },
    ],
  };
}

describe("Reorder page", () => {
  it("groups by supplier, falls back to vendor, shows totals, top-up note, selection and open orders", () => {
    const html = render("/app/reorder?variants=1", "reorder", Reorder, reorderData());
    expect(html).toContain("Acme Textiles");
    expect(html).toContain("No supplier — grouped by vendor");
    expect(html).toContain("Beta");
    expect(html).toContain("30 days (supplier)");
    expect(html).toContain("14 days (store default)");
    expect(html).toContain("Nov 12, 2026"); // order-by of the Acme group
    expect(html).toContain("Topped up to reach Acme Textiles&#x27;s minimum of 40 units.");
    expect(html).toContain("The products from your action list are highlighted.");
    expect(html).toContain("From your action list");
    // Acme: two lines, cases of 6, topped up to ≥ 40 → whole cases.
    expect(html).toMatch(/Units: (42|48)/);
    // Unknown cost on one Acme line → the group cost is unknown.
    expect(html).toContain("Cost: —");
    expect(html).toContain("Create order");
    expect(html).toContain("Open orders");
    expect(html).toContain("PO-0001");
    expect(html).toContain("From Shopify");
    expect(html).toContain('href="/app/reorder/po2"');
    for (const h of ["Stock now", "Incoming", "Days of stock left", "Quantity", "Unit cost", "Line total"]) expect(html).toContain(h);
  });

  it("shows the empty state", () => {
    const html = render("/app/reorder", "reorder", Reorder, { ...reorderData(), groups: [], openOrders: [] });
    expect(html).toContain("Nothing to reorder right now");
    expect(html).toContain("No open orders.");
  });
});

const line = (n: number, qty: number, unitCost: number | null): PoLine => ({
  variantId: `gid://shopify/ProductVariant/${n}`,
  qty,
  unitCost,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
});

const order = (over: Partial<OrderDetail> = {}): OrderDetail => ({
  id: "po1",
  number: "PO-0001",
  source: "keha",
  status: "draft",
  supplierId: "s1",
  supplierName: "Acme Textiles",
  supplier: { name: "Acme Textiles", hasEmail: true, hidePrices: false, leadTimeDays: 30 },
  lines: [line(1, 12, 2.5), line(2, 6, 1)],
  currency: "EUR",
  confirmToken: "",
  confirmExpiresAt: null,
  confirmedShipDate: null,
  expectedDate: null,
  sentAt: null,
  receivedAt: null,
  cancelledAt: null,
  createdAt: "2026-10-16T10:00:00Z",
  ...over,
});

const pageData = (o: OrderDetail, over: Partial<OrderPageView> = {}): OrderPageView => ({
  enabled: true,
  order: o,
  link: null,
  hidePrices: false,
  features: { poExport: true, supplierConfirm: true },
  ...over,
});

describe("Order page", () => {
  it("draft: email the supplier, downloads, cancel; lines and totals", () => {
    const html = render("/app/reorder/po1", "order", OrderPage, pageData(order()));
    expect(html).toContain("PO-0001");
    expect(html).toContain("Draft");
    expect(html).toContain("Email supplier");
    expect(html).toContain("Mark as sent");
    expect(html).toContain("Download PDF");
    expect(html).toContain("Download CSV");
    expect(html).toContain("Cancel order");
    expect(html).toContain("Units: 18");
    expect(html).toContain("Cost: €36.00");
    expect(html).not.toContain("Supplier link");
  });

  it("sent: the supplier link, mark received / confirmed", () => {
    const html = render(
      "/app/reorder/po1",
      "order",
      OrderPage,
      pageData(order({ status: "sent", sentAt: "2026-10-16T10:00:00Z", expectedDate: "2026-11-15", confirmExpiresAt: "2026-12-15T10:00:00Z" }), {
        link: "https://inventory.keha.io/supplier/confirm/abc",
        hidePrices: true,
      }),
    );
    expect(html).toContain("Supplier link");
    expect(html).toContain("https://inventory.keha.io/supplier/confirm/abc");
    expect(html).toContain("without prices");
    expect(html).toContain("Mark as received");
    expect(html).toContain("Mark as confirmed");
    expect(html).toContain("Email again");
    expect(html).toContain("Nov 15, 2026");
  });

  it("Free opening an order link directly: the locked teaching page with See plans, not a 404 (nothing about the order sent)", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "free", features: featureMap("free"), comped: false, checked: true } as never);
    const data = (await orderLoader({ request: new Request("https://x/app/reorder/po1"), params: { id: "po1" }, context: {} } as never)) as OrderPageData;
    expect(data).toEqual({ enabled: false });
    const html = render("/app/reorder/po1", "order", OrderPage, data);
    expect(html).toContain("See plans");
    expect(html).toContain("Growth plan");
    expect(html).not.toContain("PO-0001");
  });

  it("Shopify orders are read-only", () => {
    const html = render("/app/reorder/po2", "order", OrderPage, pageData(order({ id: "po2", source: "shopify", status: "sent", number: "#PO7" })));
    expect(html).toContain("From Shopify");
    expect(html).toContain("This order comes from Shopify.");
    expect(html).not.toContain("Cancel order");
    expect(html).not.toContain("Download PDF");
  });
});

const view = {
  number: "PO-0001",
  storeName: "Acme Store",
  supplierName: "Acme Textiles",
  lines: [line(1, 12, 2.5)],
  totalUnits: 12,
  totalCost: 30,
  currency: "EUR",
  hidePrices: true,
  confirmedShipDate: null,
  expectedDate: "2026-11-15",
  minDate: "2026-10-16",
  maxDate: "2027-10-17",
};

describe("Supplier page", () => {
  it("shows the order without prices and a date picker, in the store language", () => {
    const d: ConfirmPageData = { state: "open", locale: "es", token: "t".repeat(43), view };
    const html = render(`/supplier/confirm/${"t".repeat(43)}`, "confirm", SupplierConfirm, d);
    expect(html).toContain("Pedido de compra PO-0001");
    expect(html).toContain("Shirt 1");
    expect(html).not.toContain("2,50");
    expect(html).not.toContain("Coste unitario");
    expect(html).toContain('type="date"');
    expect(html).toContain('min="2026-10-16"');
    expect(html).toContain("Confirmar fecha de envío");
    expect(html).toContain(`/supplier/confirm/${"t".repeat(43)}/pdf`);
  });

  it("shows prices when allowed", () => {
    const d: ConfirmPageData = { state: "open", locale: "en", token: "x".repeat(43), view: { ...view, hidePrices: false } };
    const html = render(`/supplier/confirm/${"x".repeat(43)}`, "confirm", SupplierConfirm, d);
    expect(html).toContain("Unit cost");
    expect(html).toContain("€2.50");
  });

  it("the same page for every invalid link, and a rate-limit page", () => {
    const invalid = render("/supplier/confirm/nope", "confirm", SupplierConfirm, { state: "invalid", locale: "en" });
    expect(invalid).toContain("This link isn&#x27;t valid any more");
    expect(invalid).not.toContain("PO-");
    const limited = render("/supplier/confirm/nope", "confirm", SupplierConfirm, { state: "limited", locale: "en" });
    expect(limited).toContain("Too many requests");
  });
});

describe("PDF", () => {
  it("renders a PDF (smoke) with and without prices", async () => {
    const base = {
      locale: "pl" as const,
      storeName: "Sklep Łódź",
      number: "PO-0001",
      supplierName: "Acme",
      orderDate: "2026-10-16",
      expectedDate: "2026-11-15",
      confirmedShipDate: null,
      currency: "EUR",
      lines: Array.from({ length: 60 }, (_, i) => line(i + 1, 6, 2.5)),
      confirmUrl: "https://inventory.keha.io/supplier/confirm/abc",
    };
    for (const hidePrices of [false, true]) {
      const pdf = await renderPoPdf({ ...base, hidePrices });
      expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
      expect(pdf.length).toBeGreaterThan(1000);
    }
  });

  it("keeps Western European text and drops accents the standard font can't draw", () => {
    expect(pdfSafe("Café — Größe € 10")).toBe("Café — Größe € 10");
    expect(pdfSafe("Łódź zażółć")).toBe("Lódz zazólc"); // ó is in Windows-1252
    expect(pdfSafe("1 234")).toBe("1 234");
    expect(pdfSafe("日本")).toBe("??");
  });
});
