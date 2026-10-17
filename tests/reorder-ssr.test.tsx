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
vi.mock("../app/models/order-plan.server", async () => {
  const { orderPlanFixture } = await import("./order-plan-fixtures");
  return { loadOrderPlan: vi.fn(async () => orderPlanFixture()) };
});

import Reorder, { loader as reorderLoader, showTransfers, type ReorderPageData } from "../app/routes/app.reorder";
import OpenOrdersPage, { type OpenOrdersPageData } from "../app/routes/app.reorder_.orders";
import type { PreviewRow } from "../app/lib/order-plan-shared";
import OrderPage, { loader as orderLoader, type OrderPageData, type OrderPageView } from "../app/routes/app.reorder_.$id";
import { authenticate } from "../app/shopify.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { featureMap } from "../app/lib/plan-shared";
import SupplierConfirm, { type ConfirmPageData } from "../app/routes/supplier.confirm.$token";
import { buildOrderNow } from "../app/lib/reorder-shared";
import { orderNowFixture } from "./order-plan-fixtures";
import { renderPoPdf, pdfSafe } from "../app/services/po-pdf.server";
import type { OrderDetail } from "../app/models/reorder.server";
import type { PoLine } from "../app/lib/supplier-shared";

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;

/** Order now from the real plan (orderNowFixture): Acme Textiles (minimum 150 units, cases of 6), vendor Beta. */
function reorderData(over: { minOrderTotal?: number | null } = {}): ReorderPageData {
  const plan = orderNowFixture({ minOrderTotal: over.minOrderTotal === undefined ? 150 : over.minOrderTotal });
  const groups = buildOrderNow({
    plan,
    stock: new Map([[V(1), { onHand: 5, incoming: 0 }]]),
    onOrder: new Map([[V(1), 0]]),
    selected: new Set([V(1)]),
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
    today: plan.today,
    openOrders: [
      { id: "po1", number: "PO-0001", source: "keha", status: "sent", supplierName: "Acme Textiles", units: 24, remaining: 24, cost: 60, remainingCost: 60, currency: "EUR", arrival: "2026-11-02", createdAt: "2026-10-01T00:00:00Z" },
      { id: "po2", number: "#PO7", source: "shopify", status: "sent", supplierName: "Zeta", units: 10, remaining: 10, cost: null, remainingCost: null, currency: "EUR", arrival: null, createdAt: "2026-10-02T00:00:00Z" },
    ],
  };
}

describe("Reorder page (Order plan · Order now)", () => {
  it("groups by supplier, falls back to vendor, shows totals, top-up note, selection; open orders are a tab now", () => {
    const html = render("/app/reorder?variants=1", "reorder", Reorder, reorderData());
    expect(html).toContain('heading="Order plan"');
    expect(html).toMatch(/aria-selected="true" class="keha-tab keha-tab--active">Order now</);
    expect(html).toContain("Acme Textiles");
    expect(html).toContain("No supplier — grouped by vendor");
    expect(html).toContain("Beta");
    expect(html).toContain("14 days (supplier)");
    expect(html).toContain("14 days (store default)");
    expect(html).toContain("Sep 29, 2026"); // the group's earliest order-by date (overdue)
    expect(html).toContain("Topped up to reach Acme Textiles&#x27;s minimum of 150 units.");
    expect(html).toContain("The products from your action list are highlighted.");
    expect(html).toContain("From your action list");
    // Acme: the plan's quantities, in whole cases of 6, topped up to ≥ 150.
    expect(html).toMatch(/Units: 15\d/);
    // A line without a cost is "—" and counted; the order's cost is still shown (store currency).
    expect(html).toMatch(/Cost: €[\d.,]+/);
    expect(html).toContain("1 lines without a cost price");
    expect(html).toContain("Create order");
    // The open orders list moved to its own tab (no duplicate): a count and a link stay.
    expect(html).not.toContain("PO-0001");
    expect(html).toContain("Open orders: 2");
    expect(html).toContain('href="/app/reorder/orders"');
    for (const h of ["Stock now", "Incoming", "Days of stock left", "Quantity", "Unit cost", "Line total"]) expect(html).toContain(h);
    // DESIGN-RULES: short header with the long form in a tooltip; number columns right-aligned.
    expect(html).toMatch(/<s-text interestFor="keha-left-[^"]+">Days left<\/s-text><s-tooltip id="keha-left-[^"]+">Days of stock left<\/s-tooltip>/);
    expect((html.match(/format="numeric"/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("each line shows its real deadline, never 'today' unless it is (audit 2026-10-17)", () => {
    const html = render("/app/reorder", "reorder", Reorder, reorderData());
    expect(html).toContain("Overdue since Sep 29");
    expect(html).toContain("Due Oct 18");
    expect(html).not.toContain("Due today");
  });

  it("lines are grouped by style: sizes together, an overdue product first, a product subtotal", () => {
    const html = render("/app/reorder", "reorder", Reorder, reorderData());
    const acme = html.slice(html.indexOf("Acme Textiles"), html.indexOf("Wool beanie"));
    // Canvas tote and Linen shirt are both overdue: by name; the shirt's sizes M then S, then its subtotal.
    const order = ["Canvas tote", "Linen shirt</s-text><s-text color=\"subdued\">M", "Linen shirt</s-text><s-text color=\"subdued\">S", "Linen shirt: subtotal"].map((x) => acme.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("Why this quantity: the plan's own terms, and last year's same weeks", () => {
    const html = render("/app/reorder", "reorder", Reorder, reorderData({ minOrderTotal: null }));
    expect(html).toContain("Why this quantity");
    expect(html).toContain("Forecast for the next 28 days: 56 (sales per day 2, season ×1) + safety 10 − on hand 5 − on order 0 = 61");
    expect(html).toContain("→ rounded to 66 (case pack 6)");
    expect(html).toContain("Forecast for the 28 days from this order:");
    expect(html).toContain("Sold in the same weeks last year: — (no history yet)");
  });

  it("Can join this order: the supplier's lines due before its next order, collapsed, at their own quantity", () => {
    const d = reorderData({ minOrderTotal: null });
    const acme = d.groups.find((g) => g.key === "supplier:s1")!;
    expect(acme.joinable.map((l) => [l.productTitle, l.orderBy, l.suggested])).toEqual([["Wool sock", "2026-10-24", 18]]);
    const html = render("/app/reorder", "reorder", Reorder, d);
    expect(html).toContain("Can join this order (1)");
    expect(html).toContain('aria-expanded="false"');
  });

  it("Create order's confirm shows units AND cost; the line menu: Don't reorder this product, with its own confirm", () => {
    const html = render("/app/reorder", "reorder", Reorder, reorderData());
    expect(html).toMatch(/Create a draft order for Acme Textiles\?/);
    expect(html).toMatch(/\d+ units, €[\d.,]+\. Nothing is sent to the supplier until you email the order or mark it as sent\./);
    expect(html).toContain("1 lines without a cost price are not in this total.");
    expect(html).toContain("It stays in your stock numbers");
    expect(html).toContain("Don&#x27;t reorder this product");
    expect(html).toContain('icon="menu-horizontal"');
  });

  it("one-location store: no location switcher at all; Pro with two: the switcher in a toolbar", () => {
    const one = render("/app/reorder", "reorder", Reorder, { ...reorderData(), locationCount: 1 });
    expect(one).not.toContain("keha-toolbar");
    expect(one).not.toContain("keha-switcher");
    const two = render("/app/reorder", "reorder", Reorder, { ...reorderData(), locationCount: 2 });
    expect(two).toContain("keha-toolbar");
  });

  it("units on an open Keha order use the short label", () => {
    const d = reorderData();
    d.groups[0]!.lines[0]!.onOrder = 6;
    expect(render("/app/reorder", "reorder", Reorder, d)).toContain("+6 on order");
  });

  it("old drafts: says they no longer count, with the way to Open orders", () => {
    const html = render("/app/reorder", "reorder", Reorder, { ...reorderData(), staleDrafts: 2 });
    expect(html).toContain("2 old drafts (more than 14 days, never sent) are no longer counted as ordered.");
  });

  it("empty: Nothing to order today, and the next order", () => {
    const html = render("/app/reorder", "reorder", Reorder, {
      ...reorderData(),
      groups: [],
      openOrders: [],
      next: { supplierKey: "supplier:s1", name: "Acme Textiles", kind: "supplier", orderBy: "2026-10-24" },
    });
    expect(html).toContain("Nothing to order today");
    expect(html).toContain("Next order: Acme Textiles by Oct 24, 2026.");
    expect(html).toContain('href="/app/reorder/calendar"');
    expect(html).not.toContain("Open orders: ");
    expect(render("/app/reorder", "reorder", Reorder, { ...reorderData(), groups: [], next: null })).toContain("No orders needed in the next 90 days.");
  });

  it("?supplier= shows that supplier only, with the way back", () => {
    const d = reorderData();
    const only = d.groups.find((g) => g.kind === "supplier")!;
    const html = render("/app/reorder?supplier=supplier:s1", "reorder", Reorder, {
      ...d,
      groups: [only],
      supplierFilter: { key: only.key, name: only.name, kind: only.kind },
      hiddenGroups: d.groups.length - 1,
    });
    expect(html).toContain("Showing Acme Textiles only.");
    expect(html).toContain("Show all suppliers");
    expect(html).not.toContain("No supplier — grouped by vendor");
  });

  it("transfers only when the store has somewhere to move stock", () => {
    const hidden = render("/app/reorder", "reorder", Reorder, { ...reorderData(), showTransfers: false });
    expect(hidden).not.toContain("Transfers: warehouse → stores");
    expect(hidden).not.toContain("Set up warehouses and stores");
    const locked = render("/app/reorder", "reorder", Reorder, { ...reorderData(), showTransfers: true });
    expect(locked).toContain("Transfers: warehouse → stores");
    expect(locked).toContain("Pro plan");
    expect(showTransfers({ transfersEnabled: true, planningLocations: 1, activeLocations: 5 })).toBe(false);
    expect(showTransfers({ transfersEnabled: true, planningLocations: 2, activeLocations: 0 })).toBe(true);
    expect(showTransfers({ transfersEnabled: false, planningLocations: 0, activeLocations: 1 })).toBe(false);
    expect(showTransfers({ transfersEnabled: false, planningLocations: 0, activeLocations: 2 })).toBe(true);
  });

  it("Free: a read-only preview of the 10 most urgent products and the teaching lock with the merchant's own numbers", () => {
    const preview: PreviewRow[] = [
      { variantId: V(1), productTitle: "Shirt 1", variantTitle: "M", daysLeft: 2.4, neverRunsOut: false, orderBy: "2026-10-01", overdue: true, qty: 61 },
      { variantId: V(2), productTitle: "Mug", variantTitle: "Default Title", daysLeft: 30, neverRunsOut: false, orderBy: "2026-11-12", overdue: false, qty: 28 },
    ];
    const html = render("/app/reorder", "reorder", Reorder, { ...reorderData(), groups: [], enabled: false, preview, teaser: { more: 23, suppliers: 4, cash: 5120, missingCost: 0 } });
    expect(html).toContain("keha-tabs");
    expect(html).toContain("Shirt 1");
    expect(html).toContain("Overdue");
    expect(html).toContain("61");
    expect(html).toContain("Nov 12, 2026");
    expect(html).toContain("Group by supplier, send purchase orders, see the next 90 days");
    expect(html).toContain("Your plan has 23 more products to order from 4 suppliers — €5,120 over the next 13 weeks.");
    expect(html).toContain('href="/app/plans?upgrade=reorderPlan"');
    // Read only: no quantities to edit, no purchase order, no CSV.
    expect(html).not.toContain("Create order");
    expect(html).not.toContain("<s-number-field");
    expect(html).not.toContain("Download CSV");
  });
});

describe("Order now loader", () => {
  it("Free: only the top-10 preview of the forward plan — no groups, no suppliers, no open orders", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "free", features: featureMap("free"), comped: false, checked: true } as never);
    const d = await reorderLoader({ request: new Request("https://app.test/app/reorder"), params: {}, context: {} } as never);
    expect(d.enabled).toBe(false);
    expect(d.preview!.length).toBeGreaterThan(0);
    expect(d.preview!.length).toBeLessThanOrEqual(10);
    expect(d.groups).toEqual([]);
    expect(d.openOrders).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("Lisbon Linen");
  });
});

describe("Open orders tab", () => {
  it("lists Keha and Shopify orders with links to their pages", () => {
    const orders: OpenOrdersPageData["orders"] = [
      { id: "po1", number: "PO-0001", source: "keha", status: "sent", partial: false, supplierName: "Acme Textiles", units: 24, remaining: 24, cost: 60, currency: "EUR", ships: null, arrival: "2026-11-02", ageDays: 16, stale: false, overdue: false },
      { id: "po2", number: "#PO7", source: "shopify", status: "sent", partial: false, supplierName: "Zeta", units: 10, remaining: 10, cost: null, currency: "EUR", ships: null, arrival: null, ageDays: 15, stale: false, overdue: false },
    ];
    const html = render("/app/reorder/orders", "orders", OpenOrdersPage, { enabled: true, orders } satisfies OpenOrdersPageData);
    expect(html).toMatch(/aria-selected="true" class="keha-tab keha-tab--active">Open orders</);
    expect(html).toContain("PO-0001");
    expect(html).toContain("From Shopify");
    expect(html).toContain('href="/app/reorder/po2"');
    expect(html).toContain("Expected arrival");
  });

  it("empty, and Free (the tab teaches)", () => {
    expect(render("/app/reorder/orders", "orders", OpenOrdersPage, { enabled: true, orders: [] })).toContain("No open orders.");
    const free = render("/app/reorder/orders", "orders", OpenOrdersPage, { enabled: false, orders: [] });
    expect(free).toContain("Purchase orders · Growth plan");
    expect(free).toContain("keha-tabs");
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
  supplier: {
    name: "Acme Textiles",
    hasEmail: true,
    hidePrices: false,
    leadTimeDays: 30,
    transitDays: null,
    currency: null,
    exchangeRate: null,
    minOrder: null,
    minOrderTotal: null,
    minOrderValue: null,
    minOrderScope: "variant",
  },
  lines: [line(1, 12, 2.5), line(2, 6, 1)],
  currency: "EUR",
  storeCurrency: "EUR",
  arrival: null,
  updatedAt: "2026-10-16T10:00:00.000Z",
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
  it("draft: email the supplier, downloads, delete; lines and totals", () => {
    const html = render("/app/reorder/po1", "order", OrderPage, pageData(order()));
    expect(html).toContain("PO-0001");
    expect(html).toContain("Draft");
    expect(html).toContain("Email supplier");
    expect(html).toContain("Mark as sent");
    expect(html).toContain("Download PDF");
    expect(html).toContain("Download CSV");
    expect(html).toContain("Delete draft");
    expect(html).not.toContain("Cancel order");
    expect(html).toContain("Units: 18");
    expect(html).toContain("Cost: €36.00");
    expect(html).not.toContain("Supplier link");
  });

  it("sent: the supplier link, mark received / confirmed", () => {
    const html = render(
      "/app/reorder/po1",
      "order",
      OrderPage,
      pageData(order({ status: "sent", sentAt: "2026-10-16T10:00:00Z", expectedDate: "2026-11-15", arrival: "2026-11-15", confirmExpiresAt: "2026-12-15T10:00:00Z" }), {
        link: "https://inventory.keha.io/supplier/confirm/abc",
        hidePrices: true,
      }),
    );
    expect(html).toContain("Supplier link");
    expect(html).toContain("https://inventory.keha.io/supplier/confirm/abc");
    expect(html).toContain("without prices");
    expect(html).toContain("Receive items");
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
