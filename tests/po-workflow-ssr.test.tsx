/**
 * SSR: the purchase-order workflow fixes (merchant audit 2026-10-17) on the order page, the
 * Open orders tab and the supplier page — editable drafts with the save bar, delete, stale
 * drafts, partial receiving, overdue arrivals, automatic receipt with re-open, closed short,
 * cancel wording, ship date + arrival, supplier-currency prices and the minimums.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));

import OrderPage, { shouldRevalidate, type OrderPageView } from "../app/routes/app.reorder_.$id";
import OpenOrdersPage, { type OpenOrdersPageData } from "../app/routes/app.reorder_.orders";
import SupplierConfirm, { type ConfirmPageData } from "../app/routes/supplier.confirm.$token";
import type { OrderDetail, OrderSupplier } from "../app/models/reorder.server";
import type { OpenOrderListRow } from "../app/lib/purchase-order-shared";
import type { PoLine } from "../app/lib/supplier-shared";
import { LocaleProvider, translate } from "../app/lib/i18n";

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const line = (n: number, qty: number, unitCost: number | null, over: Partial<PoLine> = {}): PoLine => ({
  variantId: `gid://shopify/ProductVariant/${n}`,
  qty,
  unitCost,
  productTitle: `Shirt ${n}`,
  variantTitle: "M",
  sku: `SKU-${n}`,
  ...over,
});

const supplier = (over: Partial<OrderSupplier> = {}): OrderSupplier => ({
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
  ...over,
});

const order = (over: Partial<OrderDetail> = {}): OrderDetail => ({
  id: "po1",
  number: "PO-0001",
  source: "keha",
  status: "draft",
  supplierId: "s1",
  supplierName: "Acme Textiles",
  supplier: supplier(),
  lines: [line(1, 12, 2.5), line(2, 6, 1)],
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
  ...over,
});

const page = (o: OrderDetail, over: Partial<OrderPageView> = {}): OrderPageView => ({
  enabled: true,
  order: o,
  link: null,
  hidePrices: false,
  features: { poExport: true, supplierConfirm: true },
  today: "2026-10-17",
  stale: false,
  reopenTo: null,
  ...over,
});

const html = (o: OrderDetail, over: Partial<OrderPageView> = {}) => render("/app/reorder/po1", "order", OrderPage, page(o, over));
const sent = { status: "sent" as const, sentAt: "2026-10-01T10:00:00Z", expectedDate: "2026-10-31", arrival: "2026-10-31" };

describe("Order page · drafts", () => {
  it("quantities are editable with a remove button per line, a save bar and Delete draft", () => {
    const h = html(order());
    expect(h).toContain("<s-number-field");
    expect(h).toContain("Quantity for Shirt 1 — M");
    expect(h).toContain("Remove Shirt 2 — M");
    expect(h).toContain("Change quantities or remove lines, then save.");
    expect(h).toContain('id="keha-po-draft"');
    expect(h).toContain("Delete draft");
    expect(h).not.toContain("Receive items");
    // A draft has no arrival yet: when it will come once sent.
    expect(h).toContain("About 30 days after you send it");
  });

  it("an old draft says it no longer counts as ordered", () => {
    expect(html(order(), { stale: true })).toContain("Draft older than 14 days — no longer counted as ordered. Send it or delete it.");
    expect(html(order())).not.toContain("no longer counted as ordered");
  });

  it("warns below the supplier's unit, per-item and money minimums", () => {
    const h = html(order({ supplier: supplier({ minOrderTotal: 40, minOrder: 10, minOrderValue: 100 }) }));
    expect(h).toContain("18 units — below the supplier&#x27;s minimum order of 40 units.");
    expect(h).toContain("1 lines below the supplier&#x27;s minimum of 10 units per item.");
    expect(h).toContain("€36.00 — below the supplier&#x27;s minimum order value of €100.00.");
  });

  it("can't check a money minimum in another currency without a rate, and says so", () => {
    const h = html(order({ supplier: supplier({ currency: "USD", minOrderValue: 100 }) }));
    expect(h).toContain("The supplier&#x27;s minimum order value is $100.00.");
    expect(h).toContain("Prices are in EUR, your store currency.");
    expect(h).toContain("€30.00"); // store-currency prices, never "—" for the whole order
  });
});

describe("Order page · after deleting a draft", () => {
  it("doesn't re-read the deleted order (it navigates to Open orders instead)", () => {
    const args = (actionResult: unknown) => ({ actionResult, defaultShouldRevalidate: true }) as never;
    expect(shouldRevalidate(args({ ok: true, intent: "delete" }))).toBe(false);
    expect(shouldRevalidate(args({ ok: true, intent: "edit" }))).toBe(true);
    expect(shouldRevalidate(args({ ok: false, error: "changed" }))).toBe(true);
  });
});

describe("Order page · sent and later", () => {
  it("sent: read-only lines, Receive items, cancel wording that is true", () => {
    const h = html(order(sent));
    expect(h).toContain("Sent orders can&#x27;t be changed: your supplier already has them.");
    expect(h).not.toContain("<s-number-field label=\"Quantity for");
    expect(h).toContain("Receive items");
    expect(h).toContain("Cancel order");
    expect(h).not.toContain("Delete draft");
    // The receive screen: per line what's still to come, and close as short.
    expect(h).toContain("Receive PO-0001");
    expect(h).toContain("12 of 12 still to come");
    expect(h).toContain("Close the order: the rest won&#x27;t come");
    expect(h).toContain("Keha orders aren&#x27;t in Shopify, so add the stock in Shopify as usual.");
  });

  it("ship date and arrival: 'Ships 1 Nov · arrives ~6 Dec'; unconfirmed: the estimate", () => {
    expect(html(order({ ...sent, status: "confirmed", confirmedShipDate: "2026-11-01", arrival: "2026-12-06" }))).toContain(
      "Ships Nov 1, 2026 · arrives ~Dec 6, 2026",
    );
    expect(html(order(sent))).toContain("Arrives ~Oct 31, 2026 · ship date not confirmed yet");
  });

  it("partially received: the derived status, received column and what's still to come", () => {
    const h = html(order({ ...sent, lines: [line(1, 12, 2.5, { received: 8 }), line(2, 6, 1)] }));
    expect(h).toContain("Partially received");
    expect(h).toContain("Received 8 of 18 · 10 still to come");
    expect(h).toContain("4 of 12 still to come");
  });

  it("overdue arrivals are flagged", () => {
    const h = html(order({ ...sent, arrival: "2026-10-12" }));
    expect(h).toContain("Expected Oct 12, 2026 — not received.");
  });

  it("received automatically: says so and offers Re-open", () => {
    const h = html(
      order({ ...sent, status: "received", receivedAt: "2026-10-16T02:00:00Z", lines: [line(1, 12, 2.5, { received: 12, autoReceived: 12, reopenReceived: 0 })] }),
      { reopenTo: "sent" },
    );
    expect(h).toContain("Received automatically on Oct 16, 2026");
    expect(h).toContain("Re-open the order until Nov 15, 2026.");
    expect(h).toContain("Re-open order");
  });

  it("closed short and cancelled (re-open within 30 days)", () => {
    const short = html(
      order({ ...sent, status: "received", receivedAt: "2026-10-16T02:00:00Z", lines: [line(1, 12, 2.5, { received: 9, reopenReceived: 9 })] }),
      { reopenTo: "sent" },
    );
    expect(short).toContain("Closed with 3 units not delivered.");
    const cancelled = html(order({ ...sent, status: "cancelled", cancelledAt: "2026-10-10T00:00:00Z" }), { reopenTo: "sent" });
    expect(cancelled).toContain("You can re-open this order until Nov 9, 2026.");
    expect(cancelled).toContain("Re-open order");
    expect(cancelled).not.toContain("can&#x27;t be undone");
  });

  it("supplier-currency prices with the store-currency total", () => {
    const h = html(order({ ...sent, supplier: supplier({ currency: "USD", exchangeRate: 0.5 }) }));
    expect(h).toContain("$5.00"); // €2.50 → $5.00
    expect(h).toContain("Cost: $72.00");
    expect(h).toContain("€36.00 in your store currency");
  });

  it("German: the new strings are translated", () => {
    const German = () => (
      <LocaleProvider defaultLocale="de">
        <OrderPage />
      </LocaleProvider>
    );
    const h = render("/app/reorder/po1", "order", German, page(order({ ...sent, lines: [line(1, 12, 2.5, { received: 8 })] })));
    expect(h).toContain(translate("de", "Partially received"));
    expect(h).toContain(translate("de", "Receive items"));
    expect(translate("de", "Receive items")).not.toBe("Receive items");
  });
});

const row = (over: Partial<OpenOrderListRow>): OpenOrderListRow => ({
  id: "po1",
  number: "PO-0001",
  source: "keha",
  status: "sent",
  partial: false,
  supplierName: "Acme Textiles",
  units: 24,
  remaining: 24,
  cost: 60,
  currency: "EUR",
  ships: null,
  arrival: "2026-11-02",
  ageDays: 16,
  stale: false,
  overdue: false,
  ...over,
});

describe("Open orders tab", () => {
  it("columns supplier, order, status, ships, arrives, units, value, age; overdue and partial", () => {
    const data: OpenOrdersPageData = {
      enabled: true,
      today: "2026-10-17",
      orders: [
        row({ id: "a", overdue: true, arrival: "2026-10-12" }),
        row({ id: "b", number: "PO-0002", status: "confirmed", partial: true, remaining: 10, ships: "2026-11-01", arrival: "2026-12-06" }),
      ],
    };
    const h = render("/app/reorder/orders", "orders", OpenOrdersPage, data);
    for (const col of ["Supplier", "Order", "Status", "Ships", "Arrives", "Units", "Value", "Age (days)"]) expect(h).toContain(col);
    expect(h).toContain("Expected Oct 12, 2026 — not received");
    expect(h).toContain("Partially received");
    expect(h).toContain("10 / 24");
    expect(h).toContain("Nov 1, 2026");
    expect(h).toContain("Dec 6, 2026");
    expect(h).toContain("€60.00");
  });

  it("old drafts: a banner and a Not counted badge", () => {
    const h = render("/app/reorder/orders", "orders", OpenOrdersPage, {
      enabled: true,
      orders: [row({ status: "draft", stale: true, arrival: null }), row({ id: "x", status: "draft", stale: true, arrival: null })],
    } satisfies OpenOrdersPageData);
    expect(h).toContain("2 drafts are older than 14 days and no longer counted as ordered. Send them or delete them.");
    expect(h).toContain("Not counted");
  });
});

describe("Supplier page", () => {
  it("shows the supplier-currency prices it was given and keeps the ship-date wording", () => {
    const d: ConfirmPageData = {
      state: "open",
      locale: "en",
      token: "t".repeat(43),
      view: {
        number: "PO-0001",
        storeName: "Acme Store",
        supplierName: "Acme Textiles",
        lines: [{ productTitle: "Shirt", variantTitle: "M", sku: "S-M", qty: 12, unitCost: 5 }],
        totalUnits: 12,
        totalCost: 60,
        currency: "USD",
        hidePrices: false,
        confirmedShipDate: null,
        expectedDate: "2026-12-06",
        minDate: "2026-10-16",
        maxDate: "2027-10-17",
      },
    };
    const h = render(`/supplier/confirm/${"t".repeat(43)}`, "confirm", SupplierConfirm, d);
    expect(h).toContain("$5.00");
    expect(h).toContain("Total cost: $60.00");
    expect(h).toContain("Confirm ship date");
  });
});
