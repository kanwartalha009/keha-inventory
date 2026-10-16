/**
 * SSR: Products (task 1.7). Rows render; Free shows the forecast columns
 * locked (plan tag in the header, empty cells) and a locked CSV button;
 * Growth shows the values, "∞" for never-runs-out and "—" for unknowns.
 * Plus the variant detail page.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/services/entitlements.server", () => ({ getEntitlements: vi.fn(), upgradeResponse: vi.fn() }));
vi.mock("../app/models/products.server", () => ({
  listProducts: vi.fn(),
  productFilterOptions: vi.fn(),
  getVariantDetail: vi.fn(),
  allProducts: vi.fn(),
}));

import Products, { type ProductsData } from "../app/routes/app.products";
import VariantDetailPage, { type VariantDetailData } from "../app/routes/app.products_.$variantId";
import { dailySeries, monthlyTotals, pageInfo, readForecastInputs, recentDays, toProductRow } from "../app/lib/products-shared";

const v = (n: number, over: Partial<{ productTitle: string; variantTitle: string; image: string | null }> = {}) => ({
  id: `gid://shopify/ProductVariant/${n}`,
  productTitle: over.productTitle ?? `Shirt ${n}`,
  variantTitle: over.variantTitle ?? "M",
  sku: `SKU-${n}`,
  vendor: "Acme",
  image: over.image ?? null,
});

function rows(forecast: boolean) {
  return [
    toProductRow(v(1, { image: "https://cdn.shopify.com/a.jpg" }), { status: "running_low", rate: 2.34, daysLeft: 9.7, neverRunsOut: false, orderQty: 30, orderBy: "2026-10-20" }, { onHand: 12, incoming: 4 }, forecast),
    toProductRow(v(2), { status: "too_much", rate: 0, daysLeft: null, neverRunsOut: true, orderQty: null, orderBy: null }, { onHand: 400, incoming: 0 }, forecast),
    toProductRow(v(3, { variantTitle: "Default Title" }), null, null, forecast),
  ];
}

function data(forecast: boolean, over: Partial<ProductsData> = {}): ProductsData {
  return {
    rows: rows(forecast),
    total: 120,
    info: pageInfo(120, 2),
    filters: { status: null, collection: null, vendor: null, q: null },
    options: { vendors: ["Acme", "Beta"], collections: ["Summer"] },
    forecast,
    csv: forecast,
    ...over,
  };
}

function render(d: ProductsData) {
  const Stub = createRoutesStub([{ id: "products", path: "/app/products", Component: Products, loader: () => d }]);
  return renderToString(<Stub initialEntries={["/app/products?page=2"]} hydrationData={{ loaderData: { products: d } }} />);
}

const count = (html: string, s: string) => html.split(s).length - 1;

describe("Products page", () => {
  it("renders one row per variant with status, stock, incoming and rate", () => {
    const html = render(data(true));
    expect(html).toContain("Shirt 1");
    expect(html).toContain("M · SKU-1");
    expect(html).toContain("Shirt 3");
    expect(html).not.toContain("Default Title");
    expect(html).toContain("Running low");
    expect(html).toContain("Too much");
    expect(html).toContain(">12<");
    expect(html).toContain(">400<");
    expect(html).toContain("2.3");
    expect(html).toContain('src="https://cdn.shopify.com/a.jpg"');
    expect(html).toContain('href="/app/products/1"');
    expect(html).toContain("Page 2 of 3 · Variants: 120");
    for (const h of ["Stock now", "Incoming", "Sales per day while in stock", "Days of stock left", "Order by", "Suggested qty"]) {
      expect(html).toContain(h);
    }
    // Filters: status, collection, vendor, search.
    expect(html).toContain("All statuses");
    expect(html).toContain("All collections");
    expect(html).toContain("All vendors");
    expect(html).toContain("Search by product, variant or SKU");
    // Stock now / Incoming say which locations they cover.
    expect(html).toContain("Online stock pool: active locations that fulfil online orders.");
    expect(html).toContain('<s-text interestFor="keha-pool-stock">Stock now</s-text><s-tooltip id="keha-pool-stock">');
  });

  it("Growth: forecast values, ∞ with an accessible label, and dashes for unknowns", () => {
    const html = render(data(true));
    expect(html).toContain('aria-label="Never runs out at current sales"');
    expect(html).toContain("∞");
    expect(html).toMatch(/<s-table-cell>9<\/s-table-cell>/); // 9.7 days → 9
    expect(html).toContain("Oct 20, 2026");
    expect(html).toMatch(/<s-table-cell>30<\/s-table-cell>/);
    expect(count(html, "<s-table-cell>—</s-table-cell>")).toBeGreaterThanOrEqual(7); // row 3 has no metric/stock
    expect(html).not.toContain("Growth plan");
    expect(html).toContain("Export CSV");
    expect(html).not.toContain('href="/app/plans?upgrade=csvExport"');
  });

  it("Free: forecast columns locked in the header with empty cells, CSV locked to Plans", () => {
    const html = render(data(false));
    expect(count(html, 'icon="lock"')).toBeGreaterThanOrEqual(4); // 3 headers + CSV button
    expect(count(html, "Growth plan")).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("∞");
    expect(html).not.toContain("Oct 20, 2026");
    expect(html).not.toMatch(/<s-table-cell>30<\/s-table-cell>/);
    expect(html).toContain("See how many days each variant will last and how many to order.");
    expect(html).toContain('href="/app/plans?upgrade=csvExport"');
    expect(html).toContain("Export CSV · Growth plan");
    // The non-forecast columns still show.
    expect(html).toContain("Running low");
    expect(html).toContain(">12<");
  });

  it("empty result: filters active offer to clear them", () => {
    const html = render(data(true, { rows: [], total: 0, info: pageInfo(0, 1), filters: { status: "dead", collection: null, vendor: null, q: null } }));
    expect(html).toContain("No variants match these filters.");
    expect(html).toContain("Clear filters");
  });
});

function detail(forecast: boolean): VariantDetailData {
  const series = dailySeries(
    [
      { day: "2026-10-14", sold: 3 },
      { day: "2026-10-15", sold: 5 },
    ],
    [
      { day: "2026-10-13", outOfStock: true },
      { day: "2026-10-15", outOfStock: false },
    ],
    "2026-10-16",
  );
  const inputs = readForecastInputs(
    {
      windows: [
        { days: 28, weight: 0.5, inStockDays: 20, soldInStock: 40, rate: 2, used: true },
        { days: 56, weight: 0.3, inStockDays: 5, soldInStock: 5, rate: 1, used: false },
      ],
      inStockDays: 60,
      historyDays: 90,
      seasonal: 1,
      trend: 1,
      leadTimeDays: 14,
      leadTimeSource: "default",
      cycleDays: 14,
      z: 1.65,
    },
    2,
  );
  return {
    row: rows(forecast)[0]!,
    vendor: "Acme",
    series,
    months: monthlyTotals(series),
    recent: recentDays(series, 14),
    inputs: forecast ? inputs : inputs && { ...inputs, leadTimeDays: null, leadTimeSource: null, cycleDays: null, z: null, safety: null },
    forecast,
  };
}

function renderDetail(d: VariantDetailData) {
  const Stub = createRoutesStub([{ id: "detail", path: "/app/products/:variantId", Component: VariantDetailPage, loader: () => d }]);
  return renderToString(<Stub initialEntries={["/app/products/1"]} hydrationData={{ loaderData: { detail: d } }} />);
}

describe("Variant detail", () => {
  it("chart with an aria-label and a month table fallback, forecast inputs, recent sales", () => {
    const html = renderDetail(detail(true));
    expect(html).toContain('role="img"');
    expect(html).toContain("Units sold per day over the last 13 months. Sold-out days are shaded: 1.");
    expect(count(html, 'class="keha-chart__out"')).toBe(1);
    expect(count(html, 'class="keha-chart__bar"')).toBe(2);
    expect(html).toContain("Month");
    expect(html).toContain("How the forecast was built");
    expect(html).toContain("Last 28 days");
    expect(html).toContain("Not used: too few days in stock");
    expect(html).toContain("No seasonal data yet");
    expect(html).toContain("14 days (store default)");
    expect(html).toContain("12 units"); // safety = 1.65 × σ 2 × √14 = 12.3
    expect(html).toContain("Based on: ");
    expect(html).toContain("Recent sales");
    expect(html).toContain("Sold out");
    expect(html).toContain('href="/app/products"');
  });

  it("Free: forecast parts locked, sales rate still shown", () => {
    const html = renderDetail(detail(false));
    expect(html).toContain("Growth plan");
    expect(html).toContain("Last 28 days");
    expect(html).not.toContain("days (store default)");
    expect(html).not.toContain("Oct 20, 2026");
  });
});
