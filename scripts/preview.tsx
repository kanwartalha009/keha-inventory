/**
 * Static visual preview of every admin screen (`npm run preview:static`).
 *
 * Server-renders each screen with fixture loader data (the same machinery as the SSR tests:
 * `createRoutesStub` + `renderToString`, fixtures from tests/home-fixtures.ts and
 * tests/order-plan-fixtures.ts, the rest mirrored from the *-ssr tests) in English and German,
 * and writes one HTML file per screen × state × locale plus an index. Each page loads the
 * Polaris web components from the Shopify CDN and inlines app/app.css, inside a 1000px fake
 * admin frame, so a browser that can reach cdn.shopify.com shows the real Polaris rendering.
 *
 * No loader, database or Shopify call runs: every `app/**\/*.server.ts` module is replaced by
 * a stub at import time (a Node module hook), and calling a stub throws.
 *
 *   npx tsx scripts/preview.tsx [--out <dir>]     (default /home/claude/preview)
 *
 * Not part of the app build (only app/ is built) or of the tests (vitest runs tests/** only).
 */
import { register } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import type { Locale } from "../app/lib/i18n";
import type { PlanCode } from "../app/lib/plan-shared";
import type { HomeLoaderData } from "../app/routes/app._index";
import type { ReorderPageData } from "../app/routes/app.reorder";
import type { CalendarPageData } from "../app/routes/app.reorder_.calendar";
import type { OpenOrdersPageData } from "../app/routes/app.reorder_.orders";
import type { OrderPageView } from "../app/routes/app.reorder_.$id";
import type { ProductsData } from "../app/routes/app.products";
import type { VariantDetailData } from "../app/routes/app.products_.$variantId";
import type { SuppliersData } from "../app/routes/app.settings_.suppliers";
import type { LocationsData } from "../app/routes/app.settings_.locations";
import type { AlertsLoaderData } from "../app/routes/app.settings_.alerts";
import type { ConfirmPageData } from "../app/routes/supplier.confirm.$token";
import type { PlannerData, ScenarioView } from "../app/models/planner.server";
import type { OpenOrderRow, OrderDetail } from "../app/models/reorder.server";
import type { PlanningLocation } from "../app/lib/locations-shared";
import type { PoLine } from "../app/lib/supplier-shared";
import type { ReorderVariantIn } from "../app/lib/reorder-shared";
import type { PlannerVariant } from "../app/lib/planner-shared";
import type { PlanMetric } from "../app/lib/transfers-shared";

// ── 1. Stub every server module before anything from app/ is imported ─────────────────────
// Exports are read from the source (functions, consts, classes, `export { … }`); each becomes a
// proxy that throws when called, so a component that reached the server would fail loudly.
const HOOKS = `
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function load(url, context, next) {
  const clean = url.split("?")[0];
  if (!/\\/app\\/.*\\.server\\.tsx?$/.test(clean)) return next(url, context);
  const src = await readFile(fileURLToPath(clean), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\\s+(?:async\\s+)?function\\*?\\s+(\\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\\s+(?:const|let|var|class|enum)\\s+(\\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\\s*\\{([^}]*)\\}/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (p && !p.startsWith("type ")) names.add(p.split(/\\s+as\\s+/).pop().trim());
    }
  }
  let out = "const stub = (n) => new Proxy(function () {}, { get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : stub(n + '.' + String(k))), apply: () => { throw new Error('preview: server code called: ' + n); }, construct: () => { throw new Error('preview: server code called: ' + n); } });\\n";
  for (const n of names) if (n !== "default") out += "export const " + n + " = stub(" + JSON.stringify(n) + ");\\n";
  if (/export\\s+default\\b/.test(src)) out += "export default stub('default');\\n";
  return { format: "module", source: out, shortCircuit: true };
}
`;
register("data:text/javascript," + encodeURIComponent(HOOKS));

// React warns that useLayoutEffect does nothing on the server; that is expected here.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
};

// ── 2. App code (dynamic, so the hook above is in place) ────────────────────────────────────
const { renderToString } = await import("react-dom/server");
const { createRoutesStub, Outlet, useLocation } = await import("react-router");
const { LocaleProvider, translate } = await import("../app/lib/i18n");
const { lockedPageFeature } = await import("../app/lib/plan-shared");
const { POLARIS_URL } = await import("../app/lib/polaris-shared");
const { LockedPage } = await import("../app/components/plan");
const { buildHome } = await import("../app/lib/dashboard-shared");
const { previewRows } = await import("../app/lib/order-plan-shared");
const { EMPTY_ORDER_PLAN } = await import("../app/lib/order-plan-shared");
const { buildReorderGroups } = await import("../app/lib/reorder-shared");
const { buildTransferPlan } = await import("../app/lib/transfers-shared");
const { addDays } = await import("../app/lib/engine/dates-shared");
const { computeScenario, createPlannerSeason } = await import("../app/lib/planner-shared");
const { dailySeries, monthlyTotals, pageInfo, readForecastInputs, recentDays, toProductRow } = await import("../app/lib/products-shared");
const { DEFAULT_SETTINGS, alertsToForm, settingsToForm } = await import("../app/lib/settings-shared");
const { homeRaw, actionList } = await import("../tests/home-fixtures");
const { orderPlanFixture, PLAN_TODAY } = await import("../tests/order-plan-fixtures");

const { default: Home } = await import("../app/routes/app._index");
const { default: Reorder } = await import("../app/routes/app.reorder");
const { default: OrderCalendar } = await import("../app/routes/app.reorder_.calendar");
const { default: Planner } = await import("../app/routes/app.planner");
const { default: OpenOrders } = await import("../app/routes/app.reorder_.orders");
const { default: OrderPage } = await import("../app/routes/app.reorder_.$id");
const { default: Products } = await import("../app/routes/app.products");
const { default: VariantDetail } = await import("../app/routes/app.products_.$variantId");
const { default: Settings } = await import("../app/routes/app.settings");
const { default: Suppliers } = await import("../app/routes/app.settings_.suppliers");
const { default: Locations } = await import("../app/routes/app.settings_.locations");
const { default: Alerts } = await import("../app/routes/app.settings_.alerts");
const { default: Plans } = await import("../app/routes/app.plans");
const { default: SupplierConfirm } = await import("../app/routes/supplier.confirm.$token");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const OUT = resolve(outArg > -1 && process.argv[outArg + 1] ? process.argv[outArg + 1]! : "/home/claude/preview");
const NOW = new Date("2026-10-16T10:00:00Z");
const LOCALES: Locale[] = ["en", "de"];

// ── 3. Fixtures (mirrors of the *-ssr tests, with merchant-like names) ──────────────────────
const VID = (n: number) => `gid://shopify/ProductVariant/${n}`;
const WH: PlanningLocation = { id: "gid://shopify/Location/1", name: "Main warehouse", role: "warehouse" };
const STORE: PlanningLocation = { id: "gid://shopify/Location/2", name: "Barcelona", role: "store" };

function dashboard(plan: PlanCode, opts: { syncing?: boolean } = {}): HomeLoaderData {
  if (opts.syncing) return buildHome({ shop: null, money: null, trackedVariants: 0, variantsWithCost: 0, salesDays: 0 }, plan, NOW);
  const home = buildHome(homeRaw(), plan, NOW);
  const fx = orderPlanFixture();
  return {
    ...home,
    renderedAt: NOW.toISOString(),
    actions: actionList(plan, plan === "free" ? { fillers: 12 } : { preorderInstalled: plan === "pro" }),
    orderPlan: plan === "free" ? { kind: "preview", rows: previewRows(fx) } : { kind: "full", plan: fx },
  };
}

const rv = (n: number, title: string, over: Partial<ReorderVariantIn> = {}): ReorderVariantIn => ({
  id: VID(n),
  productTitle: title,
  variantTitle: "M",
  sku: `SKU-${n}`,
  vendor: "Acme",
  image: null,
  supplierId: null,
  caseQty: null,
  cost: 2.5,
  costCurrency: "EUR",
  ...over,
});

const OPEN_ORDERS: OpenOrderRow[] = [
  { id: "po1", number: "PO-0001", source: "keha", status: "sent", supplierName: "Acme Textiles", units: 24, cost: 60, currency: "EUR", arrival: "2026-11-02", createdAt: "2026-10-01T00:00:00Z" },
  { id: "po3", number: "PO-0002", source: "keha", status: "confirmed", supplierName: "Lisbon Linen", units: 120, cost: 1440, currency: "EUR", arrival: "2026-11-20", createdAt: "2026-10-08T00:00:00Z" },
  { id: "po2", number: "#PO7", source: "shopify", status: "sent", supplierName: "Zeta", units: 10, cost: null, currency: "EUR", arrival: null, createdAt: "2026-10-02T00:00:00Z" },
];
// The Open orders tab's rows (ships / arrives / remaining / age, merchant audit 2026-10-17).
const OPEN_ORDER_ROWS: OpenOrdersPageData["orders"] = [
  { id: "po4", number: "PO-0003", source: "keha", status: "sent", partial: false, supplierName: "Acme Textiles", units: 40, remaining: 40, cost: 100, currency: "EUR", ships: null, arrival: "2026-10-12", ageDays: 30, stale: false, overdue: true },
  { id: "po1", number: "PO-0001", source: "keha", status: "confirmed", partial: true, supplierName: "Acme Textiles", units: 24, remaining: 10, cost: 60, currency: "EUR", ships: "2026-10-28", arrival: "2026-11-02", ageDays: 16, stale: false, overdue: false },
  { id: "po3", number: "PO-0002", source: "keha", status: "confirmed", partial: false, supplierName: "Lisbon Linen", units: 120, remaining: 120, cost: 1440, currency: "EUR", ships: "2026-11-01", arrival: "2026-12-06", ageDays: 9, stale: false, overdue: false },
  { id: "po5", number: "PO-0004", source: "keha", status: "draft", partial: false, supplierName: "Lisbon Linen", units: 60, remaining: 60, cost: 720, currency: "EUR", ships: null, arrival: null, ageDays: 21, stale: true, overdue: false },
  { id: "po2", number: "#PO7", source: "shopify", status: "sent", partial: false, supplierName: "Zeta", units: 10, remaining: 10, cost: null, currency: "EUR", ships: null, arrival: null, ageDays: 15, stale: false, overdue: false },
];

function transfersPlan() {
  const inputs = { leadTimeDays: 10, cycleDays: 10, z: 1.65, seasonal: 1, trend: 1 };
  return buildTransferPlan({
    warehouses: [{ id: WH.id, name: WH.name, inPool: false }],
    stores: [{ id: STORE.id, name: STORE.name }],
    variants: new Map([
      [VID(1), { id: VID(1), productTitle: "Linen shirt", variantTitle: "S", sku: "LS-S", image: null }],
      [VID(2), { id: VID(2), productTitle: "Linen trousers", variantTitle: "M", sku: "LT-M", image: null }],
    ]),
    metrics: new Map<string, Map<string, PlanMetric & { daysLeft: number | null }>>([
      [WH.id, new Map([[VID(1), { status: "healthy", rate: 0, sigma: 0, daysLeft: null, inputs }], [VID(2), { status: "healthy", rate: 0, sigma: 0, daysLeft: null, inputs }]])],
      [STORE.id, new Map([[VID(1), { status: "out", rate: 1, sigma: 0, daysLeft: 0, inputs }], [VID(2), { status: "running_low", rate: 0.5, sigma: 0, daysLeft: 4, inputs }]])],
    ]),
    stock: new Map([
      [WH.id, new Map([[VID(1), { onHand: 50, available: 50, incoming: 0 }], [VID(2), { onHand: 30, available: 30, incoming: 0 }]])],
      [STORE.id, new Map([[VID(1), { onHand: 0, available: 0, incoming: 0 }], [VID(2), { onHand: 2, available: 2, incoming: 0 }]])],
    ]),
  });
}

function orderNow(kind: "free" | "growth" | "pro"): ReorderPageData {
  const groups = buildReorderGroups({
    variants: [
      rv(1, "Linen shirt", { supplierId: "s1" }),
      rv(2, "Linen trousers", { supplierId: "s1", cost: 6 }),
      rv(3, "Wool beanie", { vendor: "Beta", cost: 3.2 }),
      rv(4, "Canvas tote", { vendor: "Beta", cost: null }),
      rv(5, "Ceramic mug", { vendor: "Acme", cost: 1.8 }),
    ],
    metrics: new Map([
      [VID(1), { orderQty: 7, orderBy: "2026-11-12", daysLeft: 9.6, neverRunsOut: false, rate: 2 }],
      [VID(2), { orderQty: 18, orderBy: "2026-11-05", daysLeft: 6.2, neverRunsOut: false, rate: 3.1 }],
      [VID(3), { orderQty: 4, orderBy: null, daysLeft: null, neverRunsOut: false, rate: null }],
      [VID(4), { orderQty: 12, orderBy: "2026-11-20", daysLeft: 30, neverRunsOut: false, rate: 1 }],
      [VID(5), { orderQty: 3, orderBy: "2026-11-20", daysLeft: 30, neverRunsOut: false, rate: 1 }],
    ]),
    stock: new Map([
      [VID(1), { onHand: 12, incoming: 4 }],
      [VID(2), { onHand: 19, incoming: 0 }],
      [VID(5), { onHand: 30, incoming: 0 }],
    ]),
    onOrder: new Map([[VID(1), 0]]),
    suppliers: [
      { id: "s1", name: "Acme Textiles", leadTimeDays: 30, minOrder: null, minOrderTotal: 40, casePack: 6, vendorMatch: ["Acme"], currency: null, hasEmail: true },
    ],
    storeCurrency: "EUR",
    defaultLeadTimeDays: 14,
    selected: new Set([VID(1)]),
  });
  const base: ReorderPageData = {
    enabled: true,
    locationsEnabled: false,
    locations: [],
    location: null,
    locationCount: 1,
    showTransfers: false,
    transfers: { enabled: false, groups: [], recent: [], hasWarehouse: false, hasStore: false },
    groups,
    currency: "EUR",
    missingSelected: 0,
    openOrders: OPEN_ORDERS,
  };
  if (kind === "free") return { ...base, enabled: false, groups: [], openOrders: [], preview: previewRows(orderPlanFixture()) };
  if (kind === "growth") return base;
  return {
    ...base,
    locationsEnabled: true,
    locations: [WH, STORE],
    locationCount: 2,
    showTransfers: true,
    transfers: {
      enabled: true,
      groups: transfersPlan(),
      recent: [{ id: "t1", shopifyTransferId: "gid://shopify/InventoryTransfer/77", originName: WH.name, destinationName: STORE.name, units: 12, createdAt: "2026-10-15T10:00:00Z" }],
      hasWarehouse: true,
      hasStore: true,
    },
  };
}

function planner(over: Partial<PlannerData> = {}): PlannerData {
  const TODAY = "2026-10-16";
  const SHORT = { from: "2026-06-01", to: "2026-10-15" };
  const units = new Map<string, number>();
  for (let d = SHORT.from; d <= SHORT.to; d = addDays(d, 1)) units.set(d, 10);
  const V = (n: number, title: string, o: Partial<PlannerVariant> = {}): PlannerVariant => ({
    id: VID(n),
    productId: `gid://shopify/Product/${n}`,
    productTitle: title,
    variantTitle: "M",
    sku: `SKU-${n}`,
    image: null,
    vendor: "Acme",
    supplierId: null,
    collections: ["gid://shopify/Collection/1"],
    caseQty: null,
    cost: 4,
    costCurrency: "EUR",
    price: 20,
    rate: 2,
    sigma: 1,
    z: 1.65,
    enoughData: true,
    onHand: 0,
    incoming: 0,
    ...o,
  });
  const start = "2026-11-26";
  const end = "2026-11-30";
  const result = computeScenario({
    today: TODAY,
    start,
    end,
    targetType: "growth",
    targetValue: 20,
    currency: "EUR",
    defaultLeadTimeDays: 14,
    variants: [V(1, "Linen shirt", { supplierId: "s1" }), V(2, "Wool beanie", { cost: null, collections: ["gid://shopify/Collection/1", "gid://shopify/Collection/2"] })],
    suppliers: [{ id: "s1", name: "Slow Mill", leadTimeDays: 60, minOrder: null, minOrderTotal: null, casePack: null, vendorMatch: [], currency: null }],
    season: createPlannerSeason({ today: TODAY, start, end, store: { units, coverage: SHORT }, collections: new Map(), units12m: new Map() }),
    coverage: SHORT,
    lastYear: { from: "2025-11-26", to: "2025-11-30", units: null, revenue: null, coverage: 0 },
    computedAt: "2026-10-16T08:00:00.000Z",
  });
  const s: ScenarioView = { id: "sc1", name: "Black Friday 2026", event: "black_friday", start, end, targetType: "growth", targetValue: 20, computedAt: "2026-10-16T08:00:00.000Z" };
  return {
    enabled: true,
    plan: "growth",
    features: { collectionGoals: true, accuracy: true },
    today: TODAY,
    timezone: "Europe/Madrid",
    currency: "EUR",
    history: { enough: false, from: SHORT.from },
    scenarios: [s],
    selected: { ...s, result },
    canAdd: false,
    limit: 1,
    editing: null,
    collectionTitles: { "gid://shopify/Collection/1": "Summer", "gid://shopify/Collection/2": "Basics" },
    collectionOptions: [
      { id: "gid://shopify/Collection/1", title: "Summer" },
      { id: "gid://shopify/Collection/2", title: "Basics" },
    ],
    goals: {
      total: 130,
      window: { from: "2026-07-18", to: "2026-10-15" },
      rows: [
        {
          collectionId: "gid://shopify/Collection/1",
          title: "Summer",
          goalPct: 60,
          actualShare: 0.3,
          revenue: 300,
          gapPts: 30,
          holdingBack: [{ productId: "p1", title: "Linen shirt", atRisk: 250, out: 1, low: 0 }],
        },
        { collectionId: "gid://shopify/Collection/2", title: "Basics", goalPct: 70, actualShare: null, revenue: null, gapPts: null, holdingBack: [] },
      ],
    },
    scorecard: { kind: "empty", firstDate: "2026-12-01" },
    ...over,
  };
}

const pv = (n: number, productTitle: string, variantTitle = "M", vendor = "Acme") => ({ id: VID(n), productTitle, variantTitle, sku: `SKU-${n}`, vendor, image: null });

function productRows(forecast: boolean) {
  return [
    toProductRow(pv(1, "Linen shirt", "S"), { status: "out", rate: 2.34, daysLeft: 0, neverRunsOut: false, orderQty: 61, orderBy: "2026-10-12" }, { onHand: 0, incoming: 24 }, forecast),
    toProductRow(pv(2, "Linen shirt", "M"), { status: "running_low", rate: 1.8, daysLeft: 9.7, neverRunsOut: false, orderQty: 30, orderBy: "2026-10-20" }, { onHand: 12, incoming: 4 }, forecast),
    toProductRow(pv(3, "Linen trousers", "L"), { status: "healthy", rate: 1.1, daysLeft: 41.2, neverRunsOut: false, orderQty: 12, orderBy: "2026-11-14" }, { onHand: 45, incoming: 0 }, forecast),
    toProductRow(pv(4, "Wool beanie", "Default Title", "Beta"), { status: "too_much", rate: 0.2, daysLeft: 999, neverRunsOut: true, orderQty: null, orderBy: null }, { onHand: 400, incoming: 0 }, forecast),
    toProductRow(pv(5, "Ceramic mug", "Default Title"), { status: "dead", rate: 0, daysLeft: null, neverRunsOut: true, orderQty: null, orderBy: null }, { onHand: 85, incoming: 0 }, forecast),
    toProductRow(pv(6, "Canvas tote", "Natural", "Beta"), { status: "not_enough_data", rate: null, daysLeft: null, neverRunsOut: false, orderQty: null, orderBy: null }, { onHand: 20, incoming: 0 }, forecast),
    toProductRow(pv(7, "Gift card", "Default Title"), null, null, forecast),
  ];
}

function products(kind: "free" | "growth" | "pro"): ProductsData {
  const forecast = kind !== "free";
  const base: ProductsData = {
    rows: productRows(forecast),
    total: 120,
    info: pageInfo(120, 1),
    filters: { status: null, collection: null, vendor: null, q: null },
    options: { vendors: ["Acme", "Beta"], collections: ["Summer", "Basics"] },
    forecast,
    csv: forecast,
    locationsEnabled: false,
    locations: [],
    location: null,
    locationCount: 1,
  };
  return kind === "pro" ? { ...base, locationsEnabled: true, locations: [WH, STORE], locationCount: 2 } : base;
}

function variantDetail(): VariantDetailData {
  // 13 months of daily sales with a weekly rhythm and two sold-out stretches (deterministic).
  const sales: { day: string; sold: number }[] = [];
  const stock: { day: string; outOfStock: boolean }[] = [];
  let day = addDays(PLAN_TODAY, -400);
  for (let i = 0; day < PLAN_TODAY; i++, day = addDays(day, 1)) {
    const out = (i >= 120 && i < 131) || (i >= 330 && i < 336);
    stock.push({ day, outOfStock: out });
    sales.push({ day, sold: out ? 0 : 1 + ((i * 7) % 5) + (i % 7 === 5 || i % 7 === 6 ? 2 : 0) });
  }
  const series = dailySeries(sales, stock, PLAN_TODAY);
  const inputs = readForecastInputs(
    {
      windows: [
        { days: 28, weight: 0.5, inStockDays: 28, soldInStock: 84, rate: 3, used: true },
        { days: 56, weight: 0.3, inStockDays: 50, soldInStock: 140, rate: 2.8, used: true },
        { days: 112, weight: 0.2, inStockDays: 5, soldInStock: 5, rate: 1, used: false },
      ],
      inStockDays: 380,
      historyDays: 400,
      seasonal: 1.1,
      trend: 1,
      leadTimeDays: 30,
      leadTimeSource: "supplier",
      cycleDays: 14,
      z: 1.65,
    },
    2,
  );
  return { row: productRows(true)[1]!, vendor: "Acme", series, months: monthlyTotals(series), recent: recentDays(series, 14), inputs, forecast: true };
}

const suppliers: SuppliersData = {
  suppliers: [
    { id: "s1", name: "Acme Textiles", hasEmail: true, leadTimeDays: 30, minOrder: 10, minOrderTotal: 200, casePack: 6, currency: null, hidePrices: false, vendorMatch: ["Acme"], products: 3 },
    { id: "s2", name: "Lisbon Linen", hasEmail: true, leadTimeDays: 21, minOrder: null, minOrderTotal: 500, casePack: null, currency: null, hidePrices: true, vendorMatch: [], products: 12 },
    { id: "s3", name: "Beta", hasEmail: false, leadTimeDays: 7, minOrder: null, minOrderTotal: null, casePack: null, currency: "USD", hidePrices: true, vendorMatch: [], products: 0 },
  ],
  vendors: ["Acme", "Beta"],
  currency: "EUR",
  enabled: true,
  editing: null,
};

const locations: LocationsData = {
  enabled: true,
  locations: [
    { id: WH.id, name: WH.name, online: true, role: "warehouse", pool: "follow", counts: true },
    { id: STORE.id, name: STORE.name, online: false, role: "store", pool: "no", counts: false },
    { id: "gid://shopify/Location/3", name: "Pop-up Madrid", online: false, role: "other", pool: "follow", counts: false },
  ],
};

const alerts: AlertsLoaderData = { form: alertsToForm(DEFAULT_SETTINGS), slack: { connected: false, error: null }, canSlack: true };

const PLANS = [
  { code: "free", name: "Free", amountMonthly: 0, amountAnnual: 0, currency: "USD", trialDays: 0 },
  { code: "growth", name: "Growth", amountMonthly: 4900, amountAnnual: 49000, currency: "USD", trialDays: 14 },
  { code: "pro", name: "Pro", amountMonthly: 9900, amountAnnual: 99000, currency: "USD", trialDays: 14 },
];

const poLine = (n: number, title: string, qty: number, unitCost: number | null): PoLine => ({ variantId: VID(n), qty, unitCost, productTitle: title, variantTitle: "M", sku: `SKU-${n}` });

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
  lines: [poLine(1, "Linen shirt", 12, 2.5), poLine(2, "Linen trousers", 6, 6), poLine(5, "Ceramic mug", 24, 1.8)],
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

const orderPage = (o: OrderDetail, over: Partial<OrderPageView> = {}): OrderPageView => ({ enabled: true, order: o, link: null, hidePrices: false, features: { poExport: true, supplierConfirm: true }, ...over });

const TOKEN = "t".repeat(43);
const confirm = (locale: Locale): ConfirmPageData => ({
  state: "open",
  locale,
  token: TOKEN,
  view: {
    number: "PO-0001",
    storeName: "Acme Store",
    supplierName: "Acme Textiles",
    lines: [
      { qty: 120, unitCost: 2.5, productTitle: "Linen shirt", variantTitle: "M", sku: "SKU-1" },
      { qty: 60, unitCost: 6, productTitle: "Linen trousers", variantTitle: "L", sku: "SKU-2" },
    ],
    totalUnits: 180,
    totalCost: 660,
    currency: "EUR",
    hidePrices: false,
    confirmedShipDate: null,
    expectedDate: "2026-11-15",
    minDate: "2026-10-16",
    maxDate: "2027-10-17",
  },
});

// ── 4. Screens × states ─────────────────────────────────────────────────────────────────────
type Nav = "dashboard" | "orderplan" | "products" | "settings" | "plans" | "public";
const NAV: { id: Exclude<Nav, "public">; label: string }[] = [
  // Labels of AppNav in app/routes/app.tsx (s-app-nav only renders inside the admin).
  { id: "dashboard", label: "Dashboard" },
  { id: "orderplan", label: "Order plan" },
  { id: "products", label: "Products" },
  { id: "settings", label: "Settings" },
  { id: "plans", label: "Plans" },
];

type Screen = {
  slug: string;
  screen: string;
  state: string;
  nav: Nav;
  /** URL the page is rendered at (search params included). */
  url: string;
  /** Route pattern when the URL has params. */
  pattern?: string;
  plan: PlanCode;
  Component: ComponentType;
  data: (locale: Locale) => unknown;
  /** English keys (translated per locale) or fixture text expected in the HTML. */
  expect: string[];
};

const S = (s: Screen) => s;
const screens: Screen[] = [
  S({ slug: "dashboard--free-ready", screen: "Dashboard", state: "Free, ready", nav: "dashboard", url: "/app", plan: "free", Component: Home, data: () => dashboard("free"), expect: ["Dashboard", "Money at stake", "Linen shirt"] }),
  S({ slug: "dashboard--growth-ready", screen: "Dashboard", state: "Growth, ready", nav: "dashboard", url: "/app", plan: "growth", Component: Home, data: () => dashboard("growth"), expect: ["Order this week", "Money at stake", "Lisbon Linen", "Reorder Tee"] }),
  S({ slug: "dashboard--growth-syncing", screen: "Dashboard", state: "Growth, syncing (empty)", nav: "dashboard", url: "/app", plan: "growth", Component: Home, data: () => dashboard("growth", { syncing: true }), expect: ["Reading your store…", "Setup guide"] }),
  S({ slug: "dashboard--pro-ready", screen: "Dashboard", state: "Pro, ready", nav: "dashboard", url: "/app", plan: "pro", Component: Home, data: () => dashboard("pro"), expect: ["Order this week", "Money at stake", "Take preorders for the gap"] }),

  S({ slug: "order-now--free-preview", screen: "Order plan → Order now", state: "Free preview", nav: "orderplan", url: "/app/reorder", plan: "free", Component: Reorder, data: () => orderNow("free"), expect: ["Order plan", "What to order, and by when", "Linen shirt"] }),
  S({ slug: "order-now--growth", screen: "Order plan → Order now", state: "Growth", nav: "orderplan", url: "/app/reorder?variants=1", plan: "growth", Component: Reorder, data: () => orderNow("growth"), expect: ["Order plan", "Acme Textiles", "Create order"] }),
  S({ slug: "order-now--pro-2-locations", screen: "Order plan → Order now", state: "Pro, 2 locations + transfers", nav: "orderplan", url: "/app/reorder", plan: "pro", Component: Reorder, data: () => orderNow("pro"), expect: ["Acme Textiles", "Create transfer in Shopify", "Barcelona"] }),
  S({ slug: "next-90-days--growth", screen: "Order plan → Next 90 days", state: "Growth", nav: "orderplan", url: "/app/reorder/calendar", plan: "growth", Component: OrderCalendar, data: (): CalendarPageData => ({ enabled: true, plan: orderPlanFixture() }), expect: ["Next 90 days", "Lisbon Linen", "Download CSV"] }),
  S({ slug: "season-plan--growth-scenario", screen: "Order plan → Season plan", state: "Growth, with scenario", nav: "orderplan", url: "/app/planner", plan: "growth", Component: Planner, data: () => planner(), expect: ["Season plan", "Black Friday 2026", "Slow Mill"] }),
  S({ slug: "season-plan--growth-empty", screen: "Order plan → Season plan", state: "Growth, empty", nav: "orderplan", url: "/app/planner", plan: "growth", Component: Planner, data: () => planner({ scenarios: [], selected: null, canAdd: true }), expect: ["Plan your next season", "New scenario"] }),
  S({ slug: "open-orders--growth", screen: "Order plan → Open orders", state: "Growth", nav: "orderplan", url: "/app/reorder/orders", plan: "growth", Component: OpenOrders, data: (): OpenOrdersPageData => ({ enabled: true, orders: OPEN_ORDER_ROWS, today: "2026-10-17" }), expect: ["Open orders", "PO-0001", "From Shopify"] }),

  S({ slug: "products--growth", screen: "Products", state: "Growth", nav: "products", url: "/app/products", plan: "growth", Component: Products, data: () => products("growth"), expect: ["Products", "Linen shirt", "Export CSV"] }),
  S({ slug: "products--pro-2-locations", screen: "Products", state: "Pro, 2 locations", nav: "products", url: "/app/products", plan: "pro", Component: Products, data: () => products("pro"), expect: ["Products", "Linen shirt", "keha-switcher"] }),
  S({ slug: "products--free", screen: "Products", state: "Free", nav: "products", url: "/app/products", plan: "free", Component: Products, data: () => products("free"), expect: ["Products", "Linen shirt", "upgrade=csvExport"] }),
  S({ slug: "product-detail--growth", screen: "Product detail", state: "Growth", nav: "products", url: "/app/products/2", pattern: "/app/products/:variantId", plan: "growth", Component: VariantDetail, data: () => variantDetail(), expect: ["How the forecast was built", "Recent sales", "Linen shirt"] }),

  S({ slug: "settings-defaults", screen: "Settings → Defaults", state: "Growth", nav: "settings", url: "/app/settings", plan: "growth", Component: Settings, data: () => ({ form: settingsToForm(DEFAULT_SETTINGS) }), expect: ["How long do your suppliers take?", "App language"] }),
  S({ slug: "settings-suppliers", screen: "Settings → Suppliers", state: "Growth", nav: "settings", url: "/app/settings/suppliers", plan: "growth", Component: Suppliers, data: () => suppliers, expect: ["Add supplier", "Acme Textiles", "Lisbon Linen"] }),
  S({ slug: "settings-locations", screen: "Settings → Locations", state: "Pro", nav: "settings", url: "/app/settings/locations", plan: "pro", Component: Locations, data: () => locations, expect: ["Counts for online sales", "Main warehouse", "Barcelona"] }),
  S({ slug: "settings-alerts", screen: "Settings → Alerts", state: "Growth, Slack not connected", nav: "settings", url: "/app/settings/alerts", plan: "growth", Component: Alerts, data: () => alerts, expect: ["Send the Monday email", "Slack webhook link"] }),

  S({ slug: "plans--unconfirmed", screen: "Plans", state: "Plan not confirmed (fail open)", nav: "plans", url: "/app/plans", plan: "pro", Component: Plans, data: () => ({ plans: PLANS, plan: "pro", billing: null, comped: false, checked: false, manageUrl: "https://admin.shopify.com/x" }), expect: ["All features on", "Compare plans"] }),
  S({ slug: "plans--growth", screen: "Plans", state: "Growth (active)", nav: "plans", url: "/app/plans", plan: "growth", Component: Plans, data: () => ({ plans: PLANS, plan: "growth", billing: { status: "ACTIVE", planCode: "growth" }, comped: false, checked: true, manageUrl: "https://admin.shopify.com/x" }), expect: ["Current plan", "Change plan", "Compare plans"] }),

  S({ slug: "purchase-order--draft", screen: "Purchase order", state: "Draft", nav: "orderplan", url: "/app/reorder/po1", pattern: "/app/reorder/:id", plan: "growth", Component: OrderPage, data: () => orderPage(order()), expect: ["PO-0001", "Email supplier", "Download PDF"] }),
  S({ slug: "purchase-order--sent", screen: "Purchase order", state: "Sent, supplier link", nav: "orderplan", url: "/app/reorder/po1", pattern: "/app/reorder/:id", plan: "growth", Component: OrderPage, data: () => orderPage(order({ status: "sent", sentAt: "2026-10-16T10:00:00Z", expectedDate: "2026-11-15", arrival: "2026-11-15", confirmExpiresAt: "2026-12-15T10:00:00Z" }), { link: "https://inventory.keha.io/supplier/confirm/abc", hidePrices: true }), expect: ["PO-0001", "Supplier link", "Receive items"] }),

  S({ slug: "supplier-confirm", screen: "Supplier confirm (public)", state: "Open, prices shown", nav: "public", url: `/supplier/confirm/${TOKEN}`, pattern: "/supplier/confirm/:token", plan: "growth", Component: SupplierConfirm, data: (l) => confirm(l), expect: ["PO-0001", "Linen shirt", "Acme Textiles"] }),
];

// ── 5. Render ───────────────────────────────────────────────────────────────────────────────
function renderScreen(s: Screen, locale: Locale): string {
  const data = s.data(locale);
  const path = s.pattern ?? s.url.split("?")[0]!;
  if (s.nav === "public") {
    const Stub = createRoutesStub([{ id: "screen", path, Component: s.Component, loader: () => data }]);
    return renderToString(<Stub initialEntries={[s.url]} hydrationData={{ loaderData: { screen: data } }} />);
  }
  // The admin layout (app/routes/app.tsx): the locale, the busy wrapper and the page-level plan lock.
  function Shell() {
    const { pathname } = useLocation();
    const locked = lockedPageFeature(pathname, s.plan);
    return (
      <LocaleProvider defaultLocale={locale}>
        <div className="keha-content">{locked ? <LockedPage feature={locked} /> : <Outlet />}</div>
      </LocaleProvider>
    );
  }
  const Stub = createRoutesStub([{ id: "shell", path: "/", Component: Shell, children: [{ id: "screen", path, Component: s.Component, loader: () => data }] }]);
  return renderToString(<Stub initialEntries={[s.url]} hydrationData={{ loaderData: { screen: data } }} />);
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const fileName = (s: Screen, locale: Locale) => `${s.slug}--${locale}.html`;

const SHOPIFY_STUB = `window.shopify = (function () {
  var noop = function () {};
  var done = function () { return Promise.resolve(); };
  return {
    loading: noop,
    toast: { show: noop, hide: noop },
    saveBar: { show: done, hide: done, toggle: done, leaveConfirmation: done },
    modal: { show: done, hide: done, toggle: done },
    idToken: function () { return Promise.resolve(""); },
    config: {}, environment: { embedded: false }
  };
})();`;

const CHROME_CSS = `
html, body { margin: 0; background: #f1f1f1; }
.pv-label { position: sticky; top: 0; z-index: 1000; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 6px 12px; background: #1a1a1a; color: #fff; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.pv-label b { font-weight: 600; }
.pv-label a { color: #9ecbff; }
.pv-label .pv-pill { padding: 1px 6px; border-radius: 4px; background: #444; }
.pv-admin { display: flex; align-items: flex-start; gap: 0; }
.pv-nav { flex: 0 0 240px; box-sizing: border-box; padding: 12px; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #303030; }
.pv-nav__app { font-weight: 650; padding: 6px 8px; }
.pv-nav ol { list-style: none; margin: 0; padding: 0; }
.pv-nav li { padding: 6px 8px 6px 20px; border-radius: 8px; white-space: nowrap; }
.pv-nav li.pv-on { background: #fff; font-weight: 600; }
.pv-frame { flex: 0 0 1000px; width: 1000px; min-height: 100vh; background: #f1f1f1; overflow-x: auto; }
.pv-public { background: #f1f1f1; min-height: 100vh; padding: 1px 0; }
/* App Bridge elements render in the admin, outside the app iframe. */
ui-save-bar, s-app-nav { display: none !important; }
`;

function page(s: Screen, locale: Locale, body: string, appCss: string): string {
  const other = LOCALES.filter((l) => l !== locale);
  const saveBar = body.includes("<ui-save-bar");
  const label = `<div class="pv-label"><a href="index.html">All screens</a><b>${esc(s.screen)}</b><span>${esc(s.state)}</span><span class="pv-pill">${locale}</span><span class="pv-pill">plan: ${s.plan}</span><span class="pv-pill">${esc(s.url.length > 60 ? s.url.slice(0, 57) + "…" : s.url)}</span>${saveBar ? '<span class="pv-pill">save bar: Save / Discard (in the admin top bar)</span>' : ""}${other.map((l) => `<a href="${fileName(s, l)}">${l}</a>`).join(" ")}</div>`;
  const admin = s.nav !== "public";
  const nav = `<nav class="pv-nav" aria-label="Admin app nav (preview)"><div class="pv-nav__app">Keha Inventory Intelligence</div><ol>${NAV.map((n) => `<li${n.id === s.nav ? ' class="pv-on"' : ""}>${esc(translate(locale, n.label))}</li>`).join("")}</ol></nav>`;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`${s.screen} · ${s.state} · ${locale}`)}</title>
<link rel="preconnect" href="https://cdn.shopify.com/">
<link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css">
${admin ? `<script>${SHOPIFY_STUB}</script>\n<script src="${POLARIS_URL}"></script>\n<style>\n${appCss}\n</style>` : ""}
<style>${CHROME_CSS}</style>
</head>
<body>
${label}
${admin ? `<div class="pv-admin">${nav}<div class="pv-frame">${body}</div></div>` : `<div class="pv-public">${body}</div>`}
</body>
</html>
`;
}

function indexPage(rows: { s: Screen; files: string[] }[]): string {
  const items = rows
    .map(({ s, files }) => `<tr><td>${esc(s.screen)}</td><td>${esc(s.state)}</td><td>${s.plan}</td><td>${files.map((f, i) => `<a href="${f}">${LOCALES[i]}</a>`).join(" · ")}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keha admin preview</title>
<style>body{margin:0;padding:24px;background:#f1f1f1;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#303030}table{border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:8px 14px;border-bottom:1px solid #ebebeb}th{background:#f7f7f7;font-weight:600}a{color:#005bd3}</style>
</head><body>
<h1>Keha Inventory Intelligence — admin preview</h1>
<p>Static server render with fixture data (${screens.length} screens × ${LOCALES.length} languages). Polaris loads from the Shopify CDN; the app is in a 1000px frame (the admin iframe at a 1280px screen).</p>
<table><thead><tr><th>Screen</th><th>State</th><th>Plan</th><th>Open</th></tr></thead><tbody>
${items}
</tbody></table>
</body></html>
`;
}

async function main() {
  const appCss = await readFile(join(ROOT, "app/app.css"), "utf8");
  await mkdir(OUT, { recursive: true });
  for (const f of await readdir(OUT)) if (f.endsWith(".html")) await rm(join(OUT, f));

  const rows: { s: Screen; files: string[] }[] = [];
  const problems: string[] = [];
  const summary: string[] = [];
  for (const s of screens) {
    const files: string[] = [];
    for (const locale of LOCALES) {
      const file = fileName(s, locale);
      files.push(file);
      let body = "";
      try {
        body = renderScreen(s, locale);
      } catch (e) {
        problems.push(`${file}: render failed — ${(e as Error).message}`);
      }
      const html = page(s, locale, body, appCss);
      await writeFile(join(OUT, file), html);
      const missing = s.expect.filter((k) => !body.includes(esc(translate(locale, k))) && !body.includes(translate(locale, k)));
      if (!body) problems.push(`${file}: empty render`);
      else if (missing.length) problems.push(`${file}: missing ${missing.map((m) => JSON.stringify(translate(locale, m))).join(", ")}`);
      summary.push(`${missing.length || !body ? "FAIL" : "ok  "}  ${file.padEnd(48)} ${String(Buffer.byteLength(html)).padStart(7)} B`);
    }
    rows.push({ s, files });
  }
  await writeFile(join(OUT, "index.html"), indexPage(rows));

  console.log(summary.join("\n"));
  console.log(`\n${rows.length} screens × ${LOCALES.length} languages = ${rows.length * LOCALES.length} pages + index.html → ${OUT}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n` + problems.join("\n"));
    process.exitCode = 1;
  }
}

await main();

