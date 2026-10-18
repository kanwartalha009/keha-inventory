/**
 * SSR (supplier module, Kanwar 2026-10-17): Next 13 weeks with payment terms, freight & duty, cash
 * still due on open orders and the monthly budget; Settings → Suppliers (terms, freight, measured
 * lead time; the editor's fields); Settings → Defaults (monthly budget); the supplier order builder
 * (terms, reliability, payments if ordered today); German labels.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));
vi.mock("../app/models/order-plan.server", () => ({ loadOrderPlan: vi.fn() }));
vi.mock("../app/models/settings.server", () => ({ getShopSettings: vi.fn(), saveShopSettings: vi.fn() }));
vi.mock("../app/models/supplier-order.server", () => ({ loadSupplierOrder: vi.fn(), createSupplierDraft: vi.fn(), addToSupplierDraft: vi.fn() }));
import OrderCalendar, { type CalendarPageData } from "../app/routes/app.reorder_.calendar";
import SuppliersSettings, { type SuppliersData } from "../app/routes/app.settings_.suppliers";
import Settings from "../app/routes/app.settings";
import Builder, { type BuilderPageData } from "../app/routes/app.reorder_.build";
import { LocaleProvider } from "../app/lib/i18n";
import { withPayments } from "../app/lib/cash-shared";
import { paidSummary } from "../app/lib/order-plan-shared";
import { buildSupplierOrder } from "../app/lib/supplier-order-shared";
import { newSupplierForm, supplierToForm } from "../app/lib/suppliers-shared";
import { DEFAULT_SETTINGS, settingsToForm } from "../app/lib/settings-shared";
import type { OrderPlanData } from "../app/lib/order-plan-shared";
import { orderNowFixture, orderPlanFixture } from "./order-plan-fixtures";

function render(path: string, id: string, Component: React.ComponentType, data: unknown, locale?: "de") {
  const Stub = createRoutesStub([{ id, path: path.split("?")[0]!, Component, loader: () => data }]);
  const app = <Stub initialEntries={[path]} hydrationData={{ loaderData: { [id]: data } }} />;
  return renderToString(locale ? <LocaleProvider defaultLocale={locale}>{app}</LocaleProvider> : app);
}

const TERMS = { depositPct: 30, balanceDue: "ship" as const, balanceDays: 0 };

/** The order plan fixture with Lisbon Linen on 30 % / 70 % at shipment, 10 % freight, an open order's balance, and a budget. */
function termsPlan(over: Partial<OrderPlanData> = {}): OrderPlanData {
  const plan = orderPlanFixture();
  plan.suppliers["supplier:s1"] = { ...plan.suppliers["supplier:s1"]!, terms: TERMS, landedPct: 10, transitDays: 7 };
  withPayments(plan.events, { "supplier:s1": { terms: TERMS, landedPct: 10, transitDays: 7 } });
  return {
    ...plan,
    committed: [{ day: "2026-10-28", amount: 900, kind: "balance", supplierKey: "supplier:s1", po: "po7", number: "PO-0007" }],
    ...over,
  };
}

describe("Next 13 weeks with payment terms", () => {
  it("cash paid per week, open orders' balances, freight & duty on the lines, the supplier's terms", () => {
    const plan = termsPlan();
    const html = render("/app/reorder/calendar", "cal", OrderCalendar, { enabled: true, plan } satisfies CalendarPageData);
    const s = paidSummary(plan);
    expect(s.committed).toBe(900);
    expect(html).toContain("Cash needed, next 13 weeks: €");
    expect(html).toContain("Orders to place");
    expect(html).toContain("Still due on open purchase orders");
    expect(html).toContain("keha-chart__bar--committed");
    expect(html).toMatch(/€[\d,]+ for orders to place · €900 still due on open purchase orders/);
    expect(html).toMatch(/Includes €[\d,]+ freight &amp; duty\./);
    expect(html).toContain("30% deposit, 70% at shipment + 10% freight &amp; duty");
    expect(html).toMatch(/\+ €[\d,]+ freight &amp; duty/);
    // Without a budget: the way to set one.
    expect(html).toContain("Set a monthly budget");
    expect(html).not.toContain("Fit to budget");
  });

  it("a monthly budget: each month against it; over → Fit to budget", () => {
    const plan = termsPlan({ budget: 100 });
    const html = render("/app/reorder/calendar", "cal", OrderCalendar, { enabled: true, plan } satisfies CalendarPageData);
    expect(html).toContain("Monthly budget");
    expect(html).toMatch(/\d+ months? (is|are) over your budget of €100\./);
    expect(html).toContain("Over by €");
    expect(html).toContain("Fit to budget");
    expect(html).toContain("October 2026");
    const roomy = render("/app/reorder/calendar", "cal", OrderCalendar, { enabled: true, plan: termsPlan({ budget: 1_000_000 }) } satisfies CalendarPageData);
    expect(roomy).toContain("Every month is within your budget of €1,000,000.");
    expect(roomy).not.toContain("Fit to budget");
  });

  it("German", () => {
    const html = render("/app/reorder/calendar", "cal", OrderCalendar, { enabled: true, plan: termsPlan({ budget: 100 }) } satisfies CalendarPageData, "de");
    expect(html).toContain("Noch offen bei laufenden Bestellungen");
    expect(html).toContain("30 % Anzahlung, 70 % beim Versand");
    expect(html).toContain("Ans Budget anpassen");
  });
});

const supplierRows = (): SuppliersData => ({
  suppliers: [
    {
      id: "s1",
      name: "Acme Textiles",
      hasEmail: true,
      leadTimeDays: 40,
      minOrder: null,
      minOrderTotal: null,
      casePack: null,
      transitDays: 20,
      orderCycleDays: null,
      minOrderValue: null,
      minOrderScope: "variant",
      exchangeRate: null,
      currency: null,
      hidePrices: false,
      vendorMatch: ["Acme"],
      products: 0,
      terms: TERMS,
      landedPct: 12,
      leadStats: { samples: 5, promisedAvg: 40, actualAvg: 46, delayAvg: 6, sigma: 4, onTimeShare: 0.2 },
    },
    {
      id: "s2",
      name: "Beta",
      hasEmail: false,
      leadTimeDays: 7,
      minOrder: null,
      minOrderTotal: null,
      casePack: null,
      transitDays: null,
      orderCycleDays: null,
      minOrderValue: null,
      minOrderScope: "variant",
      exchangeRate: null,
      currency: null,
      hidePrices: false,
      vendorMatch: [],
      products: 0,
      leadStats: { samples: 2, promisedAvg: 7, actualAvg: 7, delayAvg: 0, sigma: 0, onTimeShare: 1 },
    },
  ],
  vendors: ["Acme"],
  currency: "EUR",
  enabled: true,
  editing: null,
});

describe("Settings → Suppliers", () => {
  it("the list: terms and freight under the name, how the supplier really delivers under the lead time", () => {
    const html = render("/app/settings/suppliers", "suppliers", SuppliersSettings, supplierRows());
    expect(html).toContain("30% deposit, 70% at shipment + 12% freight &amp; duty");
    expect(html).toContain("Usually 6 days late");
    expect(html).toContain("On time 20% · ± 4 days · 5 deliveries");
    // Fewer than 3 deliveries: how many, no verdict.
    expect(html).toContain("2 deliveries measured");
  });

  it("the editor: payment terms and freight & duty under More options", () => {
    const form = { ...supplierToForm({ ...supplierRows().suppliers[0]!, email: null, balanceDue: "after_arrival", depositPercent: 20, balanceDays: 30, landedCostPercent: 12 }) };
    const data = { ...supplierRows(), editing: { id: "s1", form } };
    // More options opens by itself only with an error; render with the disclosure state from the error path.
    const html = render("/app/settings/suppliers?edit=s1", "suppliers", SuppliersSettings, data);
    expect(html).toContain("Edit supplier");
    expect(html).not.toContain("Freight &amp; duty"); // collapsed under More options
    expect(newSupplierForm(14, "EUR")).toMatchObject({ balanceDue: "order", depositPercent: "", balanceDays: "", landedCostPercent: "" });
  });
});

describe("Settings → Defaults: monthly budget", () => {
  it("More options opens by itself with a budget, and shows it with the store currency", () => {
    const form = settingsToForm({ ...DEFAULT_SETTINGS, monthlyBudget: 5000 });
    const html = render("/app/settings", "settings", Settings, { form, currency: "EUR" });
    expect(html).toContain("Monthly purchasing budget");
    expect(html).toContain('value="5000"');
    expect(html).toContain('suffix="EUR"');
    const none = render("/app/settings", "settings", Settings, { form: settingsToForm(DEFAULT_SETTINGS), currency: "EUR" });
    expect(none).not.toContain("Monthly purchasing budget"); // collapsed
  });
});

describe("the supplier order builder", () => {
  it("payment terms, freight & duty in the total, how the supplier delivers, the payments if ordered today", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const view = buildSupplierOrder({
      plan,
      supplierKey: "supplier:s1",
      info: { ...plan.suppliers["supplier:s1"]!, terms: TERMS, landedPct: 10, transitDays: 7, leadStats: { samples: 4, promisedAvg: 14, actualAvg: 20, delayAvg: 6, sigma: 3, onTimeShare: 0.25 } },
      storeCycleDays: 14,
    });
    expect(view).toMatchObject({ terms: TERMS, landedPct: 10, transitDays: 7 });
    const html = render("/app/reorder/build", "build", Builder, { enabled: true, view, today: plan.today } satisfies BuilderPageData);
    expect(html).toContain("Payment terms");
    expect(html).toContain("30% deposit, 70% at shipment + 10% freight &amp; duty");
    expect(html).toContain("Usually 6 days late");
    expect(html).toMatch(/Cost: €[\d,.]+ · \+ €[\d,.]+ freight &amp; duty/);
    expect(html).toMatch(/If you order today: €[\d,.]+ deposit when you order · €[\d,.]+ at shipment, about [A-Z][a-z]{2} \d+, 2026 · €[\d,.]+ freight &amp; duty on arrival, about/);
  });

  it("no terms, no freight, nothing measured: as before", () => {
    const plan = orderNowFixture({ minOrderTotal: null });
    const view = buildSupplierOrder({ plan, supplierKey: "supplier:s1", info: plan.suppliers["supplier:s1"]!, storeCycleDays: 14 });
    const html = render("/app/reorder/build", "build", Builder, { enabled: true, view, today: plan.today } satisfies BuilderPageData);
    expect(html).not.toContain("Payment terms");
    expect(html).not.toContain("freight &amp; duty");
    expect(html).not.toContain("If you order today");
    expect(html).not.toContain("Usually");
  });
});

