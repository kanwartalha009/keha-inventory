/** SSR (task 2.2): Settings → Suppliers — list, editor (≤ 8 visible fields), Free lock. */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));

import SuppliersSettings, { type SuppliersData } from "../app/routes/app.settings_.suppliers";
import { newSupplierForm } from "../app/lib/suppliers-shared";

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const suppliers = (over: Partial<SuppliersData> = {}): SuppliersData => ({
  suppliers: [
    { id: "s1", name: "Acme Textiles", hasEmail: true, leadTimeDays: 30, minOrder: 10, minOrderTotal: 200, casePack: 6, currency: null, hidePrices: false, vendorMatch: ["Acme"], products: 3 },
    { id: "s2", name: "Beta", hasEmail: false, leadTimeDays: 7, minOrder: null, minOrderTotal: null, casePack: null, currency: "USD", hidePrices: true, vendorMatch: [], products: 0 },
  ],
  vendors: ["Acme", "Beta"],
  currency: "EUR",
  enabled: true,
  editing: null,
  ...over,
});

describe("Settings → Suppliers", () => {
  it("lists suppliers with lead time, minimums and assignment", () => {
    const html = render("/app/settings/suppliers", "suppliers", SuppliersSettings, suppliers());
    expect(html).toContain("Suppliers"); // the tab
    expect(html).toContain("Acme Textiles");
    expect(html).toContain("30 days");
    expect(html).toContain("10 per item · 200 per order · cases of 6");
    expect(html).toContain("Vendors: Acme");
    expect(html).toContain("Products picked: 3");
    expect(html).toContain("Email saved");
    expect(html).toContain("No email");
    expect(html).toContain("Assign products");
    expect(html).toContain("Add supplier");
  });

  it("shows the editor with ≤ 8 visible fields and More options", () => {
    const html = render(
      "/app/settings/suppliers?edit=new",
      "suppliers",
      SuppliersSettings,
      suppliers({ editing: { id: null, form: newSupplierForm(14, "EUR") } }),
    );
    expect(html).toContain("New supplier");
    for (const f of ["Supplier name", "Supplier email", "Lead time", "Minimum per item", "Minimum order total", "Case pack", "Products from these vendors"]) {
      expect(html).toContain(f);
    }
    expect(html).toContain("More options");
    expect(html).not.toContain("Hide prices from the supplier"); // collapsed
    const visible = (html.match(/<s-(text|email|number)-field/g) ?? []).length + (html.match(/<s-choice-list/g) ?? []).length;
    expect(visible).toBeLessThanOrEqual(8);
  });

  it("Free: teaches the plan, actions locked", () => {
    const html = render("/app/settings/suppliers", "suppliers", SuppliersSettings, suppliers({ enabled: false }));
    expect(html).toContain("Keep lead times, minimum orders and case packs for each supplier.");
    expect(html).toContain("Growth plan");
  });
});
