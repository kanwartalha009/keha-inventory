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
vi.mock("../app/models/deferrals.server", () => ({
  applyFitToBudget: vi.fn(async () => ({ ok: true, batch: "B1", lines: 2, amount: 120 })),
  undoFitToBudget: vi.fn(async () => ({ ok: true })),
}));

import OrderPage, { type OrderPageView } from "../app/routes/app.reorder_.$id";
import Builder, { type BuilderPageData } from "../app/routes/app.reorder_.build";
import SuppliersSettings, { type SuppliersData } from "../app/routes/app.settings_.suppliers";
import type { OrderDetail } from "../app/models/reorder.server";
import { buildSupplierOrder } from "../app/lib/supplier-order-shared";
import { orderNowFixture, orderPlanFixture } from "./order-plan-fixtures";
import OrderCalendar, { action as calendarAction, type CalendarPageData } from "../app/routes/app.reorder_.calendar";
import Reorder, { type ReorderPageData } from "../app/routes/app.reorder";
import { authenticate } from "../app/shopify.server";
import { getEntitlements, upgradeResponse } from "../app/services/entitlements.server";
import { applyFitToBudget, undoFitToBudget } from "../app/models/deferrals.server";
import { featureMap } from "../app/lib/plan-shared";
import { buildOrderNow } from "../app/lib/reorder-shared";

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

describe("measured lead time on Settings → Suppliers and the builder", () => {
  const stats = { samples: 4, promisedAvg: 60, actualAvg: 68.75, delayAvg: 8.75, sigma: 4.79, onTimeShare: 0, medianDays: 68, p80Days: 75, medianDelay: 8 };

  it("the supplier row shows the measured lead time, flags a consistently late supplier and offers the median (with a confirm)", () => {
    const data: SuppliersData = {
      suppliers: [
        { id: "s1", name: "Ningbo Knits", hasEmail: true, leadTimeDays: 60, minOrder: null, minOrderTotal: null, casePack: null, transitDays: 35, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: [], products: 0, leadStats: stats },
      ],
      vendors: [],
      currency: "EUR",
      enabled: true,
      editing: null,
    };
    const h = render("/app/settings/suppliers", "suppliers", SuppliersSettings, data);
    expect(h).toContain("Measured: 68 days typical, 80% within 75 days");
    expect(h).toContain("Consistently late: 8 days");
    expect(h).toContain("Use measured lead time (68 days)");
    // Fewer than 3 deliveries: nothing to offer.
    const few = render("/app/settings/suppliers", "suppliers", SuppliersSettings, { ...data, suppliers: [{ ...data.suppliers[0]!, leadStats: { ...stats, samples: 2 } }] });
    expect(few).not.toContain("Use measured lead time");
    expect(few).not.toContain("Consistently late");
  });

  it("the builder warns about a consistently late supplier", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const view = buildSupplierOrder({ plan, supplierKey: "supplier:s1", info: { ...plan.suppliers["supplier:s1"]!, orderCycleDays: 30, leadStats: stats }, storeCycleDays: 14 });
    const h = render("/app/reorder/build?supplier=supplier:s1", "build", Builder, { enabled: true, view, today: plan.today } satisfies BuilderPageData);
    expect(h).toContain("is usually 8 days late (median of 4 deliveries, 68 days order to arrival)");
    expect(h).toContain("Review lead time");
  });
});

describe("Fit to budget → Apply / Undo", () => {
  it("Next 13 weeks: each Apply still in force is listed with Undo", () => {
    const plan = { ...orderPlanFixture(), budget: 100, holds: [{ batch: "B1", month: "2026-10", lines: 2, amount: 120, until: "2026-11-02", suppliers: ["Lisbon Linen"] }] };
    const h = render("/app/reorder/calendar", "cal", OrderCalendar, { enabled: true, plan } satisfies CalendarPageData);
    expect(h).toContain("Fit to budget: 2 orders moved out of October 2026 (€120, Lisbon Linen), waiting until Nov 2.");
    expect(h).toContain("Undo");
  });

  it("the action: Growth only, the month / batch go to the model (it re-reads the plan)", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    const post = (body: unknown) =>
      calendarAction({ request: new Request("https://x/app/reorder/calendar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params: {}, context: {} } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "free", features: featureMap("free"), comped: false, checked: true } as never);
    await post({ intent: "applyFit", month: "2026-10" });
    expect(upgradeResponse).toHaveBeenCalledWith("orderCalendar", expect.any(String));
    expect(applyFitToBudget).not.toHaveBeenCalled();
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    expect(await post({ intent: "applyFit", month: "2026-10" })).toEqual({ intent: "applyFit", ok: true, batch: "B1", lines: 2, amount: 120 });
    expect(applyFitToBudget).toHaveBeenCalledWith("acme.myshopify.com", "2026-10");
    expect(await post({ intent: "undoFit", batch: "B1" })).toEqual({ intent: "undoFit", ok: true });
    expect(undoFitToBudget).toHaveBeenCalledWith("acme.myshopify.com", "B1");
  });

  it("Order now says when orders wait for next month (never silently gone)", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const data: ReorderPageData = {
      enabled: true,
      locationsEnabled: false,
      locations: [],
      location: null,
      transfers: { enabled: false, groups: [], recent: [], hasWarehouse: false, hasStore: false },
      groups: buildOrderNow({ plan, stock: new Map(), onOrder: new Map() }),
      currency: "EUR",
      missingSelected: 0,
      today: plan.today,
      openOrders: [],
      held: 1,
    };
    const h = render("/app/reorder", "reorder", Reorder, data);
    expect(h).toContain("1 order waits until next month to fit your budget.");
    expect(h).toContain("See or undo on Next 13 weeks");
  });
});

