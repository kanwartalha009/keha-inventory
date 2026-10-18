/**
 * SSR: sample data mode in the admin (components/sample) — the banner on every page (with the
 * Growth note and the "your store is ready" offer), the Dashboard's "Explore Keha with sample
 * data" card and its confirm, and the store-changing actions switched off with a note: the Clear
 * discount dialog, Create transfer, the purchase order's email / send / receive, Settings → Alerts.
 * English and German.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub, Outlet } from "react-router";
import type { ComponentType, ReactNode } from "react";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() }, unauthenticated: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), planFor: vi.fn(), upgradeResponse: vi.fn() }));

import Home, { type HomeLoaderData } from "../app/routes/app._index";
import Reorder, { type ReorderPageData } from "../app/routes/app.reorder";
import OrderPage, { type OrderPageView } from "../app/routes/app.reorder_.$id";
import AlertsSettings, { type AlertsLoaderData } from "../app/routes/app.settings_.alerts";
import { AppPage } from "../app/components/ui";
import { ClearDialog } from "../app/components/action-list";
import { SampleProvider, type SampleView } from "../app/components/sample";
import { LocaleProvider, translate, type Locale } from "../app/lib/i18n";
import { buildHome } from "../app/lib/dashboard-shared";
import { DEFAULT_SETTINGS, alertsToForm } from "../app/lib/settings-shared";
import { buildTransferPlan, type PlanMetric } from "../app/lib/transfers-shared";
import type { OrderDetail } from "../app/models/reorder.server";
import { actionList, homeRaw } from "./home-fixtures";

const NOW = new Date("2026-10-16T10:00:00Z");
const ON: SampleView = { on: true, loadedAt: "2026-10-16T09:00:00.000Z", realReady: false, planLifted: true };
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const has = (html: string, locale: Locale, key: string) => html.includes(esc(translate(locale, key))) || html.includes(translate(locale, key));

function render(Component: ComponentType, data: unknown, opts: { sample?: SampleView; locale?: Locale; path?: string; url?: string } = {}) {
  const path = opts.path ?? "/app";
  const Shell = () => (
    <LocaleProvider defaultLocale={opts.locale ?? "en"}>
      <SampleProvider value={opts.sample ?? { on: false }}>
        <Outlet />
      </SampleProvider>
    </LocaleProvider>
  );
  const Stub = createRoutesStub([{ id: "shell", path: "/", Component: Shell, children: [{ id: "screen", path, Component, loader: () => data }] }]);
  return renderToString(<Stub initialEntries={[opts.url ?? path]} hydrationData={{ loaderData: { screen: data } }} />);
}

const Page = ({ children }: { children?: ReactNode }) => <AppPage heading="Products">{children ?? <s-paragraph>Body</s-paragraph>}</AppPage>;

describe("the sample data banner", () => {
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: on every page while sample data is shown, with Switch to my store; never otherwise`, () => {
      const html = render(Page, {}, { sample: ON, locale });
      expect(has(html, locale, "You're viewing sample data — nothing here is from your store.")).toBe(true);
      expect(has(html, locale, "Switch to my store")).toBe(true);
      expect(has(html, locale, "Sample data shows every Growth feature, whatever your plan.")).toBe(true);
      expect(html).toContain('tone="warning"');
      // Switching back asks first.
      expect(has(html, locale, "Switch to your store?")).toBe(true);
      expect(has(html, locale, "The sample data is deleted and every screen shows your own store again.")).toBe(true);
      expect(has(html, locale, "Your store is ready — your own order plan is waiting.")).toBe(false);
      const off = render(Page, {}, { locale });
      expect(has(off, locale, "You're viewing sample data — nothing here is from your store.")).toBe(false);
    });
  }

  it("offers to switch once the store's own data is ready; no plan note on Growth", () => {
    const html = render(Page, {}, { sample: { ...ON, realReady: true, planLifted: false } });
    expect(html).toContain("Your store is ready — your own order plan is waiting.");
    expect(html).not.toContain("Sample data shows every Growth feature");
    expect(html).toMatch(/<s-button variant="primary"[^>]*>Switch to my store/);
    expect(html).toContain("Generated on Oct 16, 2026.");
    expect(html).not.toContain("Refresh sample data");
  });

  it("offers a fresh sample store once it is a few days old (its dates drift from today)", () => {
    for (const locale of ["en", "de"] as const) expect(has(render(Page, {}, { sample: { ...ON, stale: true }, locale }), locale, "Refresh sample data")).toBe(true);
  });
});

describe("Dashboard: Explore Keha with sample data", () => {
  const syncing = (): HomeLoaderData => ({ ...buildHome({ shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 }, "free", NOW), sampleOffer: true });

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: while the store isn't ready, the card with its confirm`, () => {
      const html = render(Home, syncing(), { locale });
      for (const k of [
        "Explore Keha with sample data",
        "While we read your store, try every screen on a simulated clothing store: 60 products, 14 months of sales, suppliers and purchase orders. Nothing is added to your Shopify store, and you can switch back at any time.",
        "Explore with sample data",
        "Explore with sample data?",
        "Load sample data",
      ])
        expect(has(html, locale, k), k).toBe(true);
      // Still the store's own progress: the first-sync screen leads, the card offers sample data meanwhile.
      expect(has(html, locale, "Setting up your order plan")).toBe(true);
      expect(html.indexOf(esc(translate(locale, "Setting up your order plan")))).toBeLessThan(html.indexOf(esc(translate(locale, "Explore Keha with sample data"))));
    });
  }

  it("not once the store is ready (or while sample data is shown)", () => {
    const ready: HomeLoaderData = { ...buildHome(homeRaw(), "growth", NOW), sampleOffer: false };
    expect(render(Home, ready)).not.toContain("Explore Keha with sample data");
  });
});

describe("store-changing actions are off on sample data, with a note", () => {
  const row = actionList("growth").rows.find((r) => r.kind === "clear") ?? actionList("growth").rows[0]!;

  it("Clear: the discount dialog says it's off and its button is disabled", () => {
    const Dialog = () => <ClearDialog row={row} timezone="Europe/Madrid" onClose={() => {}} onCreated={() => {}} />;
    const html = render(Dialog, {}, { sample: ON });
    expect(html).toContain("Discounts are off in sample data — nothing is created in your store.");
    expect(html).toMatch(/<s-button variant="primary"[^>]*disabled="(?:true)?"[^>]*>Create discount/);
    const live = render(Dialog, {});
    expect(live).not.toContain("Discounts are off in sample data");
    expect(live).not.toMatch(/<s-button variant="primary"[^>]*disabled="(?:true)?"[^>]*>Create discount/);
  });

  it("Transfers: Create transfer in Shopify is disabled, with the note", () => {
    const V = "gid://shopify/ProductVariant/1";
    const inputs = { leadTimeDays: 10, cycleDays: 10, z: 1.65, seasonal: 1, trend: 1 };
    const groups = buildTransferPlan({
      warehouses: [{ id: "gid://shopify/Location/1", name: "Main", inPool: false }],
      stores: [{ id: "gid://shopify/Location/2", name: "Barcelona" }],
      variants: new Map([[V, { id: V, productTitle: "Linen shirt", variantTitle: "S", sku: "LS-S", image: null }]]),
      metrics: new Map<string, Map<string, PlanMetric & { daysLeft: number | null }>>([
        ["gid://shopify/Location/1", new Map([[V, { status: "healthy", rate: 0, sigma: 0, daysLeft: null, inputs }]])],
        ["gid://shopify/Location/2", new Map([[V, { status: "out", rate: 1, sigma: 0, daysLeft: 0, inputs }]])],
      ]),
      stock: new Map([
        ["gid://shopify/Location/1", new Map([[V, { onHand: 50, available: 50, incoming: 0 }]])],
        ["gid://shopify/Location/2", new Map([[V, { onHand: 0, available: 0, incoming: 0 }]])],
      ]),
    });
    const data = {
      enabled: true,
      groups: [],
      openOrders: [],
      currency: "EUR",
      missingSelected: 0,
      locationsEnabled: true,
      locations: [],
      location: null,
      showTransfers: true,
      transfers: { enabled: true, groups, recent: [], hasWarehouse: true, hasStore: true },
    } as unknown as ReorderPageData;
    for (const locale of ["en", "de"] as const) {
      const html = render(Reorder, data, { sample: ON, locale, path: "/app/reorder" });
      expect(has(html, locale, "Transfers are off in sample data — nothing is created in your store.")).toBe(true);
      expect(html).toMatch(new RegExp(`<s-button variant="primary"[^>]*disabled="(?:true)?"[^>]*>${translate(locale, "Create transfer in Shopify")}`));
    }
    expect(render(Reorder, data, { path: "/app/reorder" })).not.toContain("Transfers are off in sample data");
  });

  it("Purchase order on sample data: emailing is off, the rest of the workflow is on", () => {
    const order: OrderDetail = {
      id: "po1",
      number: "PO-0001",
      source: "keha",
      status: "draft",
      supplierId: "s1",
      supplierName: "Porto Knitwear Lda.",
      supplier: { name: "Porto Knitwear Lda.", hasEmail: true, hidePrices: false, leadTimeDays: 28, transitDays: 3, currency: null, exchangeRate: null, minOrder: null, minOrderTotal: null, minOrderValue: null, minOrderScope: "variant" },
      lines: [{ variantId: "gid://shopify/ProductVariant/1", qty: 12, unitCost: 20, productTitle: "Merino crew jumper", variantTitle: "M", sku: "KNIT-1-M" }],
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
    };
    const view: OrderPageView = { enabled: true, order, link: null, hidePrices: false, features: { poExport: true, supplierConfirm: true }, today: "2026-10-16", stale: false, reopenTo: null };
    for (const locale of ["en", "de"] as const) {
      const html = render(OrderPage, view, { sample: ON, locale, path: "/app/reorder/:id", url: "/app/reorder/po1" });
      expect(has(html, locale, "Sample data: every step works on the sample orders, but nothing is emailed to a supplier.")).toBe(true);
      expect(html).toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Open in your email")}`));
      // The workflow runs on the sample rows (database only): only reaching a supplier is off.
      expect(html).not.toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Mark as ordered")}`));
      expect(html).not.toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Delete draft")}`));
    }
    const live = render(OrderPage, view, { path: "/app/reorder/:id", url: "/app/reorder/po1" });
    expect(live).not.toMatch(/disabled="(?:true)?"[^>]*>Open in your email/);
  });

  it("An open purchase order can be closed (Close order), also on sample data; Receive items is on", () => {
    const order: OrderDetail = {
      id: "po2",
      number: "PO-0002",
      source: "keha",
      status: "confirmed",
      supplierId: "s1",
      supplierName: "Istanbul Denim A.S.",
      supplier: { name: "Istanbul Denim A.S.", hasEmail: true, hidePrices: false, leadTimeDays: 35, transitDays: 6, currency: null, exchangeRate: null, minOrder: null, minOrderTotal: null, minOrderValue: null, minOrderScope: "variant" },
      lines: [{ variantId: "gid://shopify/ProductVariant/1", qty: 12, unitCost: 20, productTitle: "Straight leg jeans", variantTitle: "32", sku: "JEAN-32", received: 4 }],
      currency: "EUR",
      storeCurrency: "EUR",
      confirmToken: "",
      confirmExpiresAt: null,
      confirmedShipDate: "2026-10-18",
      expectedDate: null,
      arrival: "2026-10-24",
      sentAt: "2026-09-18T10:00:00Z",
      receivedAt: null,
      cancelledAt: null,
      createdAt: "2026-09-18T10:00:00Z",
      updatedAt: "2026-10-16T10:00:00.000Z",
      coverDays: 180,
    } as OrderDetail;
    const view: OrderPageView = { enabled: true, order, link: null, hidePrices: false, features: { poExport: true, supplierConfirm: true }, today: "2026-10-18", stale: false, reopenTo: null };
    for (const opts of [{}, { sample: ON }, { sample: ON, locale: "de" as const }]) {
      const locale = opts.locale ?? "en";
      const html = render(OrderPage, view, { ...opts, path: "/app/reorder/:id", url: "/app/reorder/po2" });
      expect(html).toContain(`>${translate(locale, "Close order")}</s-button>`);
      expect(html).toContain(translate(locale, "Ordered for"));
      expect(html).not.toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Close order")}`));
      expect(html).not.toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Receive items")}`));
      expect(html).not.toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Cancel order")}`));
    }
  });

  it("Settings → Alerts: the store's own alerts, shown but not changed from sample data", () => {
    const data: AlertsLoaderData = { form: alertsToForm(DEFAULT_SETTINGS), slack: { connected: true, error: null }, canSlack: true };
    for (const locale of ["en", "de"] as const) {
      const html = render(AlertsSettings, data, { sample: ON, locale, path: "/app/settings/alerts" });
      expect(has(html, locale, "Alerts, Slack and the weekly summary email always use your own store. Switch to your store to change them.")).toBe(true);
      expect(html).toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Send a test message")}`));
      expect(html).toMatch(new RegExp(`disabled="(?:true)?"[^>]*>${translate(locale, "Disconnect")}`));
    }
    expect(render(AlertsSettings, data, { path: "/app/settings/alerts" })).not.toContain("always use your own store");
  });
});
