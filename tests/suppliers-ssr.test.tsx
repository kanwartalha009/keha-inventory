/** SSR (task 2.2): Settings → Suppliers — list, editor (≤ 8 visible fields), Free lock. */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));
const saveSupplier = vi.hoisted(() => vi.fn(async () => "s9"));
vi.mock("../app/models/suppliers.server", async (orig) => ({
  ...(await orig<typeof import("../app/models/suppliers.server")>()),
  otherSupplierNames: async () => [],
  storeCurrency: async () => "EUR",
  saveSupplier,
}));

import SuppliersSettings, { action, type SuppliersData } from "../app/routes/app.settings_.suppliers";
import { authenticate } from "../app/shopify.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { featureMap } from "../app/lib/plan-shared";
import { newSupplierForm } from "../app/lib/suppliers-shared";
import { expectSettingsAnatomy } from "./helpers/settings-anatomy";

function render(path: string, id: string, Component: React.ComponentType, data: unknown) {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  return renderToString(<Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />);
}

const suppliers = (over: Partial<SuppliersData> = {}): SuppliersData => ({
  suppliers: [
    { id: "s1", name: "Acme Textiles", hasEmail: true, leadTimeDays: 30, minOrder: 10, minOrderTotal: 200, casePack: 6, transitDays: 21, orderCycleDays: 30, minOrderValue: 1500, minOrderScope: "variant", exchangeRate: null, currency: null, hidePrices: false, vendorMatch: ["Acme"], products: 3 },
    { id: "s2", name: "Beta", hasEmail: false, leadTimeDays: 7, minOrder: null, minOrderTotal: null, casePack: null, transitDays: null, orderCycleDays: null, minOrderValue: null, minOrderScope: "variant", exchangeRate: 0.92, currency: "USD", hidePrices: true, vendorMatch: [], products: 0 },
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
    expect(html).toContain("10 per item · 200 per order · €1,500 minimum · cases of 6");
    expect(html).toContain("21 days in transit");
    // The supplier's own order cycle (2026-10-17); a supplier without one shows nothing extra.
    expect(html).toContain("Order enough for: 30 days");
    expect((html.match(/Order enough for: \d+ days/g) ?? []).length).toBe(1);
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
    for (const f of ["Supplier name", "Supplier email", "Lead time", "Transit time", "Minimum per item", "Minimum order (units)", "Case pack", "Products from these vendors"]) {
      expect(html).toContain(f);
    }
    expect(html).toContain("More options");
    expect(html).toContain("Total days from placing the order to stock arriving.");
    expect(html).toContain("Days from ship date to arrival — sea or air freight.");
    expect(html).not.toContain("Hide prices from the supplier"); // collapsed
    expect(html).not.toContain("Minimum order (value)"); // collapsed
    expect(html).not.toContain("How often you place an order with this supplier"); // collapsed (More options)
    const visible = (html.match(/<s-(text|email|number)-field/g) ?? []).length + (html.match(/<s-choice-list/g) ?? []).length;
    expect(visible).toBeLessThanOrEqual(8);
  });

  it("same anatomy as every tab: a Suppliers card with heading and description; Add supplier stays a title-bar action", () => {
    const html = render("/app/settings/suppliers", "suppliers", SuppliersSettings, suppliers());
    expectSettingsAnatomy(html, { cards: ["Suppliers"] });
    expect(html).toMatch(/<s-button[^>]*slot="primary-action"[^>]*>Add supplier</);
    // Row actions: two in view, the rest in a menu, so the row never wraps.
    expect(html).toContain('<s-menu id="keha-supplier-menu-s1"');
    expect(html).toMatch(/<s-menu id="keha-supplier-menu-s1"[^>]*>.*Remove assignments.*Delete<\/s-button><\/s-menu>/s);
    expect(html).not.toMatch(/<s-menu id="keha-supplier-menu-s2"[^>]*>[^]*?Remove assignments[^]*?<\/s-menu>/);
  });

  it("the editor saves through the save bar (a new supplier can be saved straight away), Cancel closes it", () => {
    const html = render(
      "/app/settings/suppliers?edit=new",
      "suppliers",
      SuppliersSettings,
      suppliers({ editing: { id: null, form: newSupplierForm(14, "EUR") } }),
    );
    expectSettingsAnatomy(html, { cards: ["New supplier", "Suppliers"], saveBar: "keha-settings-supplier" });
    expect(html).toContain("Cancel");
  });

  it("Free: teaches the plan, actions locked", () => {
    const html = render("/app/settings/suppliers", "suppliers", SuppliersSettings, suppliers({ enabled: false }));
    expect(html).toContain("Keep lead times, minimum orders and case packs for each supplier.");
    expect(html).toContain("Growth plan");
  });
});

describe("Settings → Suppliers: per-style minimum, money minimum, exchange rate", () => {
  it("a minimum per product reads 'per product' in the list", () => {
    const base = suppliers();
    const html = render(
      "/app/settings/suppliers",
      "suppliers",
      SuppliersSettings,
      suppliers({ suppliers: [{ ...base.suppliers[0]!, minOrderScope: "product", minOrderValue: null }] }),
    );
    expect(html).toContain("10 per product · 200 per order · cases of 6");
  });

  it("saves transit, value minimum, scope and the rate (store currency read on the server)", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    saveSupplier.mockClear();
    const form = {
      ...newSupplierForm(30, "EUR"),
      name: "Acme Textiles",
      transitDays: "21",
      minOrderValue: "1500.50",
      minOrderScope: "product",
      currency: "USD",
      exchangeRate: "0.92",
      orderCycleDays: "60",
    };
    const res = await action({
      request: new Request("https://x/app/settings/suppliers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "save", form }) }),
      params: {},
      context: {},
    } as never);
    expect(res).toMatchObject({ ok: true });
    expect(saveSupplier).toHaveBeenCalledWith(
      "acme.myshopify.com",
      null,
      expect.objectContaining({ transitDays: 21, orderCycleDays: 60, minOrderValue: 1500.5, minOrderScope: "product", currency: "USD", exchangeRate: 0.92 }),
    );
    saveSupplier.mockClear();
  });
});

describe("Settings → Suppliers save without secure storage", () => {
  it("production without a valid APP_ENCRYPTION_KEY: a supplier with an email isn't saved (translated error); without an email it is", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    const env = { key: process.env.APP_ENCRYPTION_KEY, node: process.env.NODE_ENV };
    const post = (form: Record<string, unknown>) =>
      action({
        request: new Request("https://x/app/settings/suppliers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "save", form }) }),
        params: {},
        context: {},
      } as never);
    try {
      process.env.NODE_ENV = "production";
      process.env.APP_ENCRYPTION_KEY = "";
      const form = { ...newSupplierForm(14, "EUR"), name: "Acme Textiles", email: "orders@acme.test" };
      expect(await post(form)).toEqual({ ok: false, errors: { email: "emailStorage" } });
      expect(saveSupplier).not.toHaveBeenCalled();
      expect(await post({ ...form, email: "" })).toMatchObject({ ok: true });
      expect(saveSupplier).toHaveBeenCalledTimes(1);
    } finally {
      process.env.APP_ENCRYPTION_KEY = env.key;
      process.env.NODE_ENV = env.node;
    }
  });
});
