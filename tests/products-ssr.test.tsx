/**
 * SSR: Products (task 1.7). Rows render; Free shows the forecast columns
 * locked (plan tag in the header, empty cells) and a locked CSV button;
 * Growth shows the values, and "—" for unknowns (with "No recent sales" when stock has no sales to measure from).
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
  supplierFilterOptions: vi.fn(),
  getVariantDetail: vi.fn(),
  allProducts: vi.fn(),
  setProductCaseSize: vi.fn(async () => ({ ok: true, count: 3 })),
  setProductSupplierCode: vi.fn(async () => ({ ok: true, count: 3 })),
}));
vi.mock("../app/models/reorder.server", () => ({ setNoReorder: vi.fn(async () => ({ ok: true, count: 1 })) }));
vi.mock("../app/models/forecast-overrides.server", () => ({
  forecastChoiceFor: vi.fn(async () => ({ noCap: false, like: null, offer: null })),
  likeTargetExists: vi.fn(async () => true),
  setNoCap: vi.fn(async () => undefined),
  setPlanLike: vi.fn(async () => undefined),
}));
vi.mock("../app/services/jobs/queue.server", () => ({ enqueueJob: vi.fn(async () => true) }));

import Products, { action as productsAction, type ProductsData } from "../app/routes/app.products";
import VariantDetailPage, { action as detailAction, type VariantDetailData } from "../app/routes/app.products_.$variantId";
import { authenticate } from "../app/shopify.server";
import { getEntitlements } from "../app/services/entitlements.server";
import { getVariantDetail, setProductCaseSize, setProductSupplierCode } from "../app/models/products.server";
import { setNoReorder } from "../app/models/reorder.server";
import { featureMap } from "../app/lib/plan-shared";
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
    locationsEnabled: false,
    locations: [],
    location: null,
    locationCount: 1,
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
    // Short headers that never wrap; the long form is each header's tooltip.
    for (const h of ["Stock now", "Incoming", "Sales/day", "Days left", "Order by", "To order"]) {
      expect(html).toContain(h);
    }
    for (const h of ["Sales per day while in stock", "Days of stock left", "The next planned order (the same as Order now)"]) {
      expect(html).toContain(`<s-tooltip id="keha-col-`);
      expect(html).toContain(h);
    }
    // Filters: status, collection, vendor, search.
    expect(html).toContain("All statuses");
    expect(html).toContain("All collections");
    expect(html).toContain("All vendors");
    expect(html).toContain('placeholder="Product, variant or SKU"');
    // Stock now / Incoming say which locations they cover.
    expect(html).toContain("Stock counted in supplier orders: every active location unless you left it out in Settings → Locations.");
    expect(html).toContain('<s-text interestFor="keha-pool-stock">Stock now</s-text><s-tooltip id="keha-pool-stock">');
    // Numbers are right-aligned: numeric columns use the Polaris numeric format.
    expect(count(html, 'format="numeric"')).toBe(5);
  });

  it("Growth: forecast values; no sales to measure from → a dash with \"No recent sales\" (never ∞); dashes for unknowns", () => {
    const html = render(data(true));
    expect(html).not.toContain("∞");
    expect(html).toMatch(/<s-text interestFor="keha-left-\d+">—<\/s-text><s-tooltip id="keha-left-\d+">No recent sales<\/s-tooltip>/);
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
    // Headers carry a compact lock badge with the plan name, on the header's own line.
    expect(count(html, '<s-badge icon="lock" tone="info">Growth</s-badge>')).toBe(3);
    expect(html).toMatch(/<span class="keha-th">.*?Days left.*?<s-badge icon="lock"/);
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

describe("Products layout (2026-10-17 design rules)", () => {
  it("one toolbar in the table's filter slot: search on the left, every filter in one group on the right", () => {
    const html = render(data(true));
    const bar = /<div class="keha-toolbar" slot="filters">(.*?)<s-table-header-row>/s.exec(html)?.[1] ?? "";
    expect(bar).toContain('<div class="keha-toolbar__search"><s-search-field');
    const filters = /<div class="keha-toolbar__filters">(.*)$/s.exec(bar)?.[1] ?? "";
    for (const f of ["All statuses", "All collections", "All vendors"]) expect(filters).toContain(f);
    expect(html).not.toContain("keha-filters");
  });

  it("Export CSV is a page header action, not part of the content", () => {
    const html = render(data(true));
    expect(html).toMatch(/<s-button slot="secondary-actions"[^>]*icon="export"/);
  });

  it("a single-location store gets no location switcher at all", () => {
    const html = render(data(true, { locationCount: 1 }));
    expect(html).not.toContain("keha-switcher");
    expect(html).not.toContain("Stock counted in supplier orders</s-option>");
    expect(html).not.toContain("upgrade=locations");
  });

  it("empty states use the shared centred pattern", () => {
    const html = render(data(true, { rows: [], total: 0, info: pageInfo(0, 1) }));
    expect(html).toContain("Your products appear here once your catalog is read.");
    expect(html).toMatch(/<s-box padding="base"><s-stack direction="block" gap="small" alignItems="center">/);
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
    expect(html).toContain("17 units"); // safety = 1.65 × σ 2 × √(lead 14 + cycle 14) = 17.5 → 17
    expect(html).toContain("Based on: ");
    expect(html).toContain("Recent sales");
    expect(html).toContain("Sold out");
    expect(html).toContain('href="/app/products"');
  });

  it("days of stock left with no recent sales: a dash with the reason, never ∞", () => {
    const d = detail(true);
    const html = renderDetail({ ...d, row: { ...d.row, daysLeft: null, neverRunsOut: true } });
    expect(html).not.toContain("∞");
    expect(html).toContain('<s-text interestFor="keha-detail-left">—</s-text><s-tooltip id="keha-detail-left">No recent sales</s-tooltip>');
  });

  it("layout: every card uses the shared head; count columns are right-aligned; no header wraps", () => {
    const html = renderDetail(detail(true));
    for (const title of ["Stock", "Sales, last 13 months", "How the forecast was built", "Recent sales"]) {
      expect(html).toContain(`<div class="keha-form-card__head"><s-stack gap="small-500"><s-heading>${title}</s-heading>`);
    }
    expect(html).not.toMatch(/<s-section heading=/);
    expect(count(html, 'format="numeric"')).toBe(6);
    // The long rate header is short in the table, long in its tooltip.
    expect(html).toContain('<s-text interestFor="keha-window-rate">Sales/day</s-text><s-tooltip id="keha-window-rate">Sales per day while in stock</s-tooltip>');
  });

  it("plain words (audit): Safety level, the growth assumption, stock counted in supplier orders", () => {
    const html = renderDetail({ ...detail(true), trendMode: "off" });
    expect(html).toContain("Safety level");
    expect(html).not.toContain("Service level factor");
    // Merchant audit 2026-10-18: z 1.65 reads as the in-stock target it stands for, not "1.65".
    expect(html).toContain("95% in-stock target");
    expect(html).toContain("the chance it doesn&#x27;t run out before the next delivery");
    expect(html).not.toMatch(/Safety level<\/[^>]+>\s*<[^>]+>1\.65/);
    expect(html).toContain("Not applied (growth assumption off)");
    // The Trend row never says "No seasonal data yet" (only the seasonal row can).
    expect(count(html, "No seasonal data yet")).toBe(1);
    expect(renderDetail({ ...detail(true), trendMode: "store" })).toContain("No change from last year");
    expect(html).toContain("Stock counted in supplier orders");
    expect(html).not.toContain("Online stock pool");
  });

  it("Ordering: Don't reorder (product or this variant) and the product's case size", () => {
    const html = renderDetail({ ...detail(true), productId: "gid://shopify/Product/1", variantCount: 3, caseQty: 12 });
    expect(html).toContain("<s-heading>Ordering</s-heading>");
    expect(html).toContain("Don&#x27;t reorder this product");
    expect(html).toContain("Don&#x27;t reorder this variant");
    expect(html).toContain('label="Case size"');
    expect(html).toContain('value="12"');
    const off = renderDetail({ ...detail(true), noReorder: true, productNoReorder: true, row: { ...detail(true).row, noReorder: true, orderQty: null } });
    expect(off).toContain("This product is set to Don&#x27;t reorder");
    expect(off).toContain("Reorder again");
    expect(off).toContain("Not reordered");
  });

  it("Free: forecast parts locked, sales rate still shown", () => {
    const html = renderDetail(detail(false));
    expect(html).toContain("Growth plan");
    expect(html).toContain("Last 28 days");
    expect(html).not.toContain("days (store default)");
    expect(html).not.toContain("Oct 20, 2026");
  });
});

describe("Products: the plan's To order, Don't reorder, sort and supplier filter", () => {
  it("rows: Not reordered, Overdue, a row menu; toolbar: supplier and sort", () => {
    const [a, b, c] = rows(true);
    const html = render(
      data(true, {
        rows: [{ ...a!, overdue: true, productId: "gid://shopify/Product/1" }, { ...b!, noReorder: true, orderQty: null }, c!],
        options: { vendors: [], collections: [], suppliers: [{ id: "s1", name: "Lisbon Linen" }] },
      }),
    );
    expect(html).toContain("Not reordered");
    expect(html).toContain("Overdue");
    expect(html).toContain("Don&#x27;t reorder this variant");
    expect(html).toContain("Don&#x27;t reorder this product");
    expect(html).toContain("Reorder again");
    expect(html).toContain("All suppliers");
    expect(html).toContain("Lisbon Linen");
    expect(html).toContain("Sort: order-by date");
    expect(html).toContain("The next planned order (the same as Order now)");
  });

  it("actions: Don't reorder a variant or a product; the product's case size (validated)", async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    const post = (body: unknown) => ({ request: new Request("https://x/app/products", { method: "POST", body: JSON.stringify(body) }), params: { variantId: "1" }, context: {} }) as never;
    expect(await productsAction(post({ intent: "noReorder", variantId: "gid://shopify/ProductVariant/1", value: true }))).toEqual({ ok: true, count: 1 });
    expect(setNoReorder).toHaveBeenLastCalledWith("acme.myshopify.com", { variantId: "gid://shopify/ProductVariant/1" }, true);
    await productsAction(post({ intent: "noReorder", productId: "gid://shopify/Product/9", value: false }));
    expect(setNoReorder).toHaveBeenLastCalledWith("acme.myshopify.com", { productId: "gid://shopify/Product/9" }, false);
    await expect(productsAction(post({ intent: "noReorder", variantId: "nope" }))).rejects.toBeInstanceOf(Response);
    vi.mocked(getVariantDetail).mockResolvedValue({ variant: { productId: "gid://shopify/Product/1" } } as never);
    expect(await detailAction(post({ intent: "caseQty", caseQty: 0 }))).toEqual({ ok: false, error: "caseQty" });
    expect(await detailAction(post({ intent: "caseQty", caseQty: 24 }))).toEqual({ ok: true, count: 3 });
    expect(setProductCaseSize).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", 24);
    await detailAction(post({ intent: "caseQty", caseQty: null }));
    expect(setProductCaseSize).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", null);
    await detailAction(post({ intent: "noReorder", scope: "product", value: true }));
    expect(setNoReorder).toHaveBeenLastCalledWith("acme.myshopify.com", { productId: "gid://shopify/Product/1" }, true);
    await detailAction(post({ intent: "noReorder", scope: "variant", value: true }));
    expect(setNoReorder).toHaveBeenLastCalledWith("acme.myshopify.com", { variantId: "gid://shopify/ProductVariant/1" }, true);
  });
});

describe("Product type: the Products filter and the season source on the detail page", () => {
  it("toolbar: a Product type select in its own toolbar box, the chosen type selected; none known → no select", () => {
    const html = render(
      data(true, {
        filters: { status: null, collection: null, vendor: null, productType: "Jackets", q: null },
        options: { vendors: [], collections: [], productTypes: ["Jackets", "Shirts"] },
      }),
    );
    const filters = /<div class="keha-toolbar__filters">(.*?)<s-table-header-row>/s.exec(html)?.[1] ?? "";
    expect(filters).toMatch(/<div class="keha-toolbar__item"><s-select[^>]*label="Product type"[^>]*>.*?All product types.*?<\/s-select><\/div>/s);
    expect(filters).toContain("Shirts");
    expect(filters).toMatch(/<s-option value="Jackets" selected="">|<s-select[^>]*value="Jackets"/);
    expect(render(data(true))).not.toContain("All product types");
  });

  it("the type filter counts as a filter: an empty result offers Clear filters", () => {
    const html = render(data(true, { rows: [], total: 0, info: pageInfo(0, 1), filters: { status: null, collection: null, vendor: null, productType: "Hats", q: null } }));
    expect(html).toContain("No variants match these filters.");
    expect(html).toContain("Clear filters");
  });

  it("CSV export reads the same type filter", async () => {
    const { loader: csvLoader } = await import("../app/routes/app.products.csv");
    const { allProducts } = await import("../app/models/products.server");
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    vi.mocked(allProducts).mockResolvedValue([]);
    const res = (await csvLoader({ request: new Request("https://x/app/products/csv?type=Jackets&vendor=Acme"), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(200);
    expect(vi.mocked(allProducts).mock.calls.at(-1)![1]).toMatchObject({ productType: "Jackets", vendor: "Acme" });
  });

  const withSource = (season: unknown, seasonCollection: string | null = null): VariantDetailData => {
    const d = detail(true);
    return { ...d, inputs: readForecastInputs({ ...d.inputs, windows: [], season }, 2), seasonCollection };
  };

  it("How the forecast was built names where the season came from", () => {
    expect(renderDetail(withSource({ level: "collection", collectionId: "gid://shopify/Collection/7" }, "Coats"))).toContain("Collection “Coats”");
    expect(renderDetail(withSource({ level: "productType", productType: "Jackets" }))).toContain("Product type “Jackets”");
    expect(renderDetail(withSource({ level: "store" }))).toContain("Your whole store");
    // A collection deleted since: still says it was a collection.
    expect(renderDetail(withSource({ level: "collection", collectionId: "gid://shopify/Collection/7" }))).toContain("One of its collections");
    const html = renderDetail(withSource({ level: "productType", productType: "Jackets" }));
    expect(html).toMatch(/Season from.*Product type “Jackets”/s);
    // Rows stored before the source was recorded: no row.
    expect(renderDetail(detail(true))).not.toContain("Season from");
  });
});

describe("Ordering: the product's supplier code (size-grid purchase orders)", () => {
  it("the field shows the saved code; saving validates it and writes it for the product", async () => {
    const html = renderDetail({ ...detail(true), productId: "gid://shopify/Product/1", variantCount: 3, supplierCode: "ART-4410" });
    expect(html).toContain('label="Supplier code"');
    expect(html).toContain('value="ART-4410"');
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "growth", features: featureMap("growth"), comped: false, checked: true } as never);
    vi.mocked(getVariantDetail).mockResolvedValue({ variant: { productId: "gid://shopify/Product/1" } } as never);
    const post = (body: unknown) => ({ request: new Request("https://x/app/products/1", { method: "POST", body: JSON.stringify(body) }), params: { variantId: "1" }, context: {} }) as never;
    expect(await detailAction(post({ intent: "supplierCode", supplierCode: "  ART 9 " }))).toEqual({ ok: true, count: 3 });
    expect(setProductSupplierCode).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", "ART 9");
    expect(await detailAction(post({ intent: "supplierCode", supplierCode: "x".repeat(65) }))).toEqual({ ok: false, error: "supplierCode" });
    // Saved with a new case size from the same save bar.
    await detailAction(post({ intent: "caseQty", caseQty: 12, supplierCode: "" }));
    expect(setProductSupplierCode).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", null);
    expect(setProductCaseSize).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", 12);
  });
});

describe("How the forecast was built: the supplier's delivery spread in safety stock (supplier module)", () => {
  it("measured (≥ 3 deliveries): said next to the safety stock; not measured: nothing extra", () => {
    const base = detail(true);
    const html = renderDetail({ ...base, inputs: { ...base.inputs!, leadSigma: 4.4 } });
    expect(html).toContain("incl. late deliveries (± 4.4 days)");
    expect(renderDetail(base)).not.toContain("incl. late deliveries");
    expect(readForecastInputs({ leadTimeDays: 30, z: 1.65, safety: 12, leadSigma: 4.4 }, 1)!.leadSigma).toBe(4.4);
    expect(readForecastInputs({ leadTimeDays: 30, z: 1.65, safety: 12 }, 1)!.leadSigma).toBeNull();
  });
});

describe("Forecast choices (R4): Don't cap and Plan like", () => {
  const spikes = { cap: 9, count: 2, off: false, days: [{ day: "2026-10-01", sold: 30, cap: 9 }, { day: "2026-09-14", sold: 300, cap: 9 }] };
  it("unusual days capped: the largest day, the cap and Don't cap; none → no button", () => {
    const d = detail(true);
    const html = renderDetail({ ...d, inputs: { ...d.inputs!, spikes }, choice: { noCap: false, like: null, offer: null } });
    expect(html).toContain("<s-heading>Forecast choices</s-heading>");
    expect(html).toContain("2 unusual days capped (largest Sep 14: 300 units, counted as 9)");
    expect(html).toContain("Don&#x27;t cap this product");
    expect(html).not.toContain("High days that come back");
    // Recurring high days (accuracy audit 2026-10-18): the yearly average added back is said.
    const rec = renderDetail({ ...d, inputs: { ...d.inputs!, spikes: { ...spikes, recurringPerDay: 3.92 } }, choice: { noCap: false, like: null, offer: null } });
    expect(rec).toContain("High days that come back (promotions, repeat orders) count as 3.9 a day over the year.");
    const none = renderDetail({ ...d, choice: { noCap: false, like: null, offer: null } });
    expect(none).toContain("No unusual days in the last 90 days.");
    expect(none).not.toContain("Don&#x27;t cap this product");
    const off = renderDetail({ ...d, choice: { noCap: true, like: null, offer: null } });
    expect(off).toContain("Unusual days are not capped for this product");
    expect(off).toContain("Cap unusual days again");
    // Old fixtures without a choice: no card (nothing breaks).
    expect(renderDetail(d)).not.toContain("Forecast choices");
  });

  it("a new product: the offer, the type's median suggestion and the search; a chosen reference with Stop", () => {
    const d = detail(true);
    const young = { ...d, inputs: { ...d.inputs!, inStockDays: 6 } };
    const html = renderDetail({ ...young, choice: { noCap: false, like: null, offer: { productType: "Jackets", suggestion: { rate: 2.5, products: 7 } } } });
    expect(html).toContain("Only 6 days in stock so far: too few to measure its own pace. Plan it like a similar product until it has 28 days in stock.");
    expect(html).toContain("Suggested: the median Jackets product sells 2.5 a day.");
    expect(html).toContain("Use this suggestion");
    expect(html).toContain('label="Similar product"');
    // No type median (no type, or no product of it with a pace): no suggestion, search only.
    expect(renderDetail({ ...young, choice: { noCap: false, like: null, offer: { productType: null, suggestion: null } } })).not.toContain("Suggested:");
    const like = renderDetail({
      ...d,
      inputs: { ...d.inputs!, planLike: { kind: "product", name: "Parka Classic", pct: 80, ownDays: 6, weight: 0.79 } },
      choice: { noCap: false, like: { kind: "product", ref: "gid://shopify/Product/2", name: "Parka Classic", pct: 80, rate: 3 }, offer: { productType: "Jackets", suggestion: null } },
    });
    expect(like).toContain("Based on Parka Classic at 80 % until this product has 28 days in stock (now 6).");
    expect(like).toContain("Stop planning like Parka Classic");
    expect(like).not.toContain('label="Similar product"');
    const gone = renderDetail({ ...d, choice: { noCap: false, like: { kind: "productType", ref: "Jackets", name: "Jackets", pct: 100, rate: null }, offer: null } });
    expect(gone).toContain("Based on the median Jackets product at 100 %");
    expect(gone).toContain("Jackets has no sales pace yet, so this product is planned on its own sales.");
  });

  it("actions: noCap, planLike (validated, the reference must exist), planLikeOff; each queues a compute", async () => {
    const fo = await import("../app/models/forecast-overrides.server");
    const { enqueueJob } = await import("../app/services/jobs/queue.server");
    vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: "acme.myshopify.com" } } as never);
    vi.mocked(getEntitlements).mockResolvedValue({ plan: "free", features: featureMap("free"), comped: false, checked: true } as never);
    vi.mocked(getVariantDetail).mockResolvedValue({ variant: { productId: "gid://shopify/Product/1" } } as never);
    const post = (body: unknown) => ({ request: new Request("https://x/app/products/1", { method: "POST", body: JSON.stringify(body) }), params: { variantId: "1" }, context: {} }) as never;
    vi.mocked(enqueueJob).mockClear();
    expect(await detailAction(post({ intent: "noCap", value: true }))).toEqual({ ok: true, count: 1 });
    expect(fo.setNoCap).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", true);
    await detailAction(post({ intent: "noCap", value: false }));
    expect(fo.setNoCap).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", false);
    expect(await detailAction(post({ intent: "planLike", kind: "product", ref: "gid://shopify/Product/2", pct: 80 }))).toEqual({ ok: true, count: 1 });
    expect(fo.setPlanLike).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", { kind: "product", ref: "gid://shopify/Product/2", pct: 80 });
    // Itself, a bad percent, a bad id: refused.
    for (const bad of [{ kind: "product", ref: "gid://shopify/Product/1", pct: 100 }, { kind: "productType", ref: "Jackets", pct: 5 }, { kind: "product", ref: "x", pct: 100 }]) {
      expect(await detailAction(post({ intent: "planLike", ...bad }))).toEqual({ ok: false, error: "planLike" });
    }
    vi.mocked(fo.likeTargetExists).mockResolvedValueOnce(false);
    expect(await detailAction(post({ intent: "planLike", kind: "productType", ref: "Nope", pct: 100 }))).toEqual({ ok: false, error: "planLike" });
    expect(await detailAction(post({ intent: "planLikeOff" }))).toEqual({ ok: true, count: 1 });
    expect(fo.setPlanLike).toHaveBeenLastCalledWith("acme.myshopify.com", "gid://shopify/Product/1", null);
    expect(enqueueJob).toHaveBeenCalledTimes(4);
    expect(enqueueJob).toHaveBeenLastCalledWith("acme.myshopify.com", "compute");
  });
});

describe("How the forecast was built: safety from the forecast's own error, a level shift (B4, B5)", () => {
  it("shows the fill target, the error over the protection days and the backtest ratio; and a level change", () => {
    const base = detail(true);
    const inputs = { ...base.inputs!, error: { horizonDays: 42, sigma: 18.4, fill: 0.95, ratio: 1.7, samples: 13 }, levelShift: { day: "2026-09-01", ratio: 2.4 } };
    const html = renderDetail({ ...base, inputs });
    expect(html).toContain("Fill target");
    expect(html).toContain("95 %");
    expect(html).toContain("Forecast error over 42 days");
    expect(html).toContain("± 18 units");
    expect(html).toContain("last 13 weeks: 1.7× the expected error");
    expect(html).toContain("Sales stepped up on");
    expect(renderDetail(base)).not.toContain("Fill target");
    expect(readForecastInputs({ error: { horizonDays: 42, sigma: 18.4, fill: 0.95, ratio: null, samples: 0 } }, 1)!.error).toEqual({ horizonDays: 42, sigma: 18.4, fill: 0.95, ratio: null, samples: 0 });
    expect(readForecastInputs({}, 1)!.error).toBeNull();
  });
});
