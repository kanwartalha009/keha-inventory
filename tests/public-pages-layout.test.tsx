/**
 * Public pages follow the layout rules too (docs/DESIGN-RULES.md): on the supplier page the
 * order table scrolls inside the card on a phone, and every number column is right-aligned,
 * on one line, with lined-up digits.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));

import SupplierConfirm, { type ConfirmPageData } from "../app/routes/supplier.confirm.$token";

const token = "t".repeat(43);
const d: ConfirmPageData = {
  state: "open",
  locale: "en",
  token,
  view: {
    number: "PO-0001",
    storeName: "Acme Store",
    supplierName: "Acme Textiles",
    lines: [{ qty: 1200, unitCost: 2.5, productTitle: "Shirt", variantTitle: "M", sku: "SKU-1" }],
    totalUnits: 1200,
    totalCost: 3000,
    currency: "EUR",
    hidePrices: false,
    confirmedShipDate: null,
    expectedDate: "2026-11-15",
    minDate: "2026-10-16",
    maxDate: "2027-10-17",
  },
};

function render() {
  const Stub = createRoutesStub([{ id: "confirm", path: "/supplier/confirm/:token", Component: SupplierConfirm, loader: () => d }]);
  return renderToString(<Stub initialEntries={[`/supplier/confirm/${token}`]} hydrationData={{ loaderData: { confirm: d } }} />);
}

describe("Supplier page layout", () => {
  it("the table scrolls inside its own box; numbers stay on one line, right-aligned, digits lined up", () => {
    const html = render();
    expect(html).toMatch(/<div style="overflow-x:auto[^"]*"><table/);
    const numeric = html.match(/<t[hd] style="[^"]*text-align:right[^"]*white-space:nowrap[^"]*font-variant-numeric:tabular-nums/g) ?? [];
    expect(numeric.length).toBe(6); // Quantity, Unit cost, Line total — header and the one row
    expect(html).toContain("1,200");
  });
});
