/**
 * Products screen (spec §5.2): filters, paging, row mapping, CSV and the
 * detail view's chart series. Pure, client-safe. Unknown values stay null and
 * render "—" (invariant I-5).
 */
import { addDays, type DayKey } from "./engine/dates-shared";
import { safetyStock } from "./engine/order-shared";
import { VARIANT_STATUSES, type VariantStatus } from "./engine/types-shared";
import type { DueNote } from "./engine/forward-plan-shared";

type T = (s: string) => string;

export const PAGE_SIZE = 50;

/** Days shown in the detail chart: 13 months (spec §5.2). */
export const CHART_DAYS = 395;

/** Metrics come from the online pool in phase 1 (per-location scopes are Pro, phase 3). */
export const METRIC_SCOPE = "online";

// ── Status ────────────────────────────────────────────────────────────────

export function isVariantStatus(v: unknown): v is VariantStatus {
  return typeof v === "string" && (VARIANT_STATUSES as readonly string[]).includes(v);
}

/** Display order for the status filter. */
export const STATUS_ORDER: VariantStatus[] = ["out", "running_low", "healthy", "too_much", "dead", "not_enough_data"];

export function statusLabel(status: VariantStatus, t: T): string {
  switch (status) {
    case "out":
      return t("Out of stock");
    case "running_low":
      return t("Low stock");
    case "healthy":
      return t("In stock");
    case "too_much":
      return t("Overstock");
    case "dead":
      return t("Dead stock");
    case "not_enough_data":
      return t("Insufficient data");
  }
}

export type StatusTone = "critical" | "warning" | "success" | "caution" | "neutral" | "auto";

export function statusTone(status: VariantStatus): StatusTone {
  switch (status) {
    case "out":
      return "critical";
    case "running_low":
      return "warning";
    case "healthy":
      return "success";
    case "too_much":
      return "caution";
    case "dead":
      return "neutral";
    case "not_enough_data":
      return "auto";
  }
}

// ── Filters and paging ───────────────────────────────────────────────────

export type ProductFilters = {
  status: VariantStatus | null;
  collection: string | null;
  vendor: string | null;
  /** Shopify product type (URL `type`). */
  productType?: string | null;
  q: string | null;
  /** A Settings → Suppliers id, or "none" (no supplier: grouped by vendor). */
  supplier?: string | null;
  /** "title" = product name; default (null) = order-by date when the forecast is on. */
  sort?: ProductSort | null;
};

export type ProductSort = "orderBy" | "title";

const clean = (v: string | null): string | null => {
  const s = (v ?? "").trim();
  return s ? s.slice(0, 200) : null;
};

export function parseFilters(params: URLSearchParams): ProductFilters {
  const status = params.get("status");
  return {
    status: isVariantStatus(status) ? status : null,
    collection: clean(params.get("collection")),
    vendor: clean(params.get("vendor")),
    productType: clean(params.get("type")),
    q: clean(params.get("q")),
    supplier: clean(params.get("supplier")),
    sort: params.get("sort") === "title" ? "title" : params.get("sort") === "orderBy" ? "orderBy" : null,
  };
}

export function parsePage(params: URLSearchParams): number {
  const n = Number(params.get("page"));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Filters → query string (page left out: a new filter starts at page 1). */
export function filtersToParams(f: ProductFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.collection) p.set("collection", f.collection);
  if (f.vendor) p.set("vendor", f.vendor);
  if (f.productType) p.set("type", f.productType);
  if (f.q) p.set("q", f.q);
  if (f.supplier) p.set("supplier", f.supplier);
  if (f.sort) p.set("sort", f.sort);
  return p;
}

export type PageInfo = { page: number; pageCount: number; skip: number; take: number; hasPrev: boolean; hasNext: boolean };

/** Server-side paging; a page past the end is clamped to the last page. */
export function pageInfo(total: number, requested: number, size = PAGE_SIZE): PageInfo {
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), pageCount);
  return { page, pageCount, skip: (page - 1) * size, take: size, hasPrev: page > 1, hasNext: page < pageCount };
}

// ── Rows ─────────────────────────────────────────────────────────────────

export type ProductRow = {
  id: string;
  /** Numeric tail of the variant gid, for /app/products/:variantId. */
  numericId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  image: string | null;
  /** null = not computed yet. */
  status: VariantStatus | null;
  onHand: number | null;
  incoming: number | null;
  rate: number | null;
  /** Forecast columns: null when unknown OR locked by plan (see `forecast`). */
  daysLeft: number | null;
  neverRunsOut: boolean;
  orderBy: string | null;
  orderQty: number | null;
  /**
   * Units on sent / confirmed Keha orders (task 2.2). Keha orders never reach
   * Shopify, so this is never part of `incoming` (Shopify's own number): shown
   * beside it as "On order (Keha)", never added to it. 0 = none.
   */
  onOrder: number;
  /** Earliest expected arrival of those orders, "YYYY-MM-DD". */
  onOrderArrival: string | null;
  /** The merchant marked it "Don't reorder" (never in an order; still in the stock numbers). */
  noReorder?: boolean;
  /** Its order-by date has passed (the plan orders it today). */
  overdue?: boolean;
  /** A1: the season's first order, or why an overdue order has no date (forward-plan dueNote). */
  dueNote?: DueNote | null;
  productId?: string;
};

/** Open Keha order units for one variant (models/reorder.server kehaOnOrder). */
export type OnOrderIn = { qty: number; arrival: string | null };

export type VariantRowIn = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  image: string | null;
};

export type MetricRowIn = {
  status: string;
  rate: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  orderQty: number | null;
  orderBy: Date | string | null;
};

export type StockSumIn = { onHand: number | null; incoming: number | null };

export function variantNumericId(gid: string): string {
  const m = /(\d+)$/.exec(gid);
  return m ? m[1]! : gid;
}

export function variantGid(numericId: string): string | null {
  return /^\d{1,20}$/.test(numericId) ? `gid://shopify/ProductVariant/${numericId}` : null;
}

const dayOf = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);

const finite = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * One table row. `forecast` false (Free) blanks the forecast columns on the
 * server so locked values never reach the browser.
 */
export function toProductRow(
  v: VariantRowIn,
  metric: MetricRowIn | null | undefined,
  stock: StockSumIn | null | undefined,
  forecast: boolean,
  onOrder?: OnOrderIn | null,
): ProductRow {
  const status = metric && isVariantStatus(metric.status) ? metric.status : null;
  return {
    id: v.id,
    numericId: variantNumericId(v.id),
    productTitle: v.productTitle,
    variantTitle: v.variantTitle,
    sku: v.sku,
    vendor: v.vendor,
    image: v.image,
    status,
    onHand: finite(stock?.onHand),
    incoming: finite(stock?.incoming),
    rate: finite(metric?.rate),
    daysLeft: forecast ? finite(metric?.daysLeft) : null,
    neverRunsOut: forecast ? !!metric?.neverRunsOut : false,
    orderBy: forecast ? dayOf(metric?.orderBy ?? null) : null,
    orderQty: forecast ? finite(metric?.orderQty) : null,
    onOrder: onOrder && onOrder.qty > 0 ? onOrder.qty : 0,
    onOrderArrival: onOrder && onOrder.qty > 0 ? onOrder.arrival : null,
  };
}

/** "Default Title" is Shopify's name for a product's only variant. */
export function variantName(title: string): string | null {
  return title && title !== "Default Title" ? title : null;
}

/** Sales per day while in stock, 1 decimal; "—" when unknown. */
export function formatRate(rate: number | null, locale: string): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rate);
  } catch {
    return rate.toFixed(1);
  }
}

/**
 * Days of stock left. "noSales": stock but a measured sales rate of zero — the days are unknown
 * (I-5: "—", with "No recent sales" as the reason), never "∞" (2026-10-17 click-through).
 */
export type DaysLeftView = { kind: "noSales" } | { kind: "none" } | { kind: "days"; days: number };

/** Whole days left, rounded DOWN (2.9 days is not 3 days of stock). */
export function daysLeftView(row: Pick<ProductRow, "daysLeft" | "neverRunsOut">): DaysLeftView {
  if (row.neverRunsOut) return { kind: "noSales" };
  if (row.daysLeft === null || !Number.isFinite(row.daysLeft)) return { kind: "none" };
  return { kind: "days", days: Math.max(0, Math.floor(row.daysLeft)) };
}

// ── CSV ──────────────────────────────────────────────────────────────────

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starts with
 * = + - @, or a tab / carriage return) gets a leading apostrophe (OWASP CSV
 * injection). Numbers are written as-is.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/** Whole file: UTF-8 BOM (Excel), CRLF line ends. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return "﻿" + [csvLine(header), ...rows.map(csvLine)].join("\r\n") + "\r\n";
}

/**
 * The Products CSV (spec §5.2, Growth): the filtered table, one row per
 * variant. Forecast columns are left empty when `forecast` is off.
 */
export function productsCsv(rows: readonly ProductRow[], t: T, forecast: boolean): string {
  const header = [
    t("Product"),
    t("Variant"),
    t("SKU"),
    t("Vendor"),
    t("Status"),
    t("On hand"),
    t("Incoming"),
    t("Sales per day while in stock"),
    t("Days of stock"),
    t("Order by"),
    t("Suggested qty"),
  ];
  const body = rows.map((r) => {
    const left = daysLeftView(r);
    return [
      r.productTitle,
      variantName(r.variantTitle),
      r.sku,
      r.vendor,
      r.status ? statusLabel(r.status, t) : null,
      r.onHand,
      r.incoming,
      r.rate === null ? null : Math.round(r.rate * 10) / 10,
      !forecast ? null : left.kind === "noSales" ? "—" : left.kind === "days" ? left.days : null,
      forecast ? r.orderBy : null,
      forecast ? r.orderQty : null,
    ];
  });
  return toCsv(header, body);
}

// ── Detail: chart series and forecast inputs ─────────────────────────────

export type ChartDay = {
  day: DayKey;
  /** Units sold that day; null = no sales row (no data, not 0). */
  sold: number | null;
  /** True when every location was sold out; null = no stock row. */
  out: boolean | null;
};

/**
 * One entry per day for the last `days` days before `today`. Sales are summed
 * per day; a day is "sold out" when every stock row for that day is out.
 */
export function dailySeries(
  sales: readonly { day: Date | string; sold: number }[],
  stock: readonly { day: Date | string; outOfStock: boolean }[],
  today: DayKey,
  days = CHART_DAYS,
): ChartDay[] {
  const sold = new Map<string, number>();
  for (const r of sales) {
    const d = dayOf(r.day)!;
    sold.set(d, (sold.get(d) ?? 0) + (Number.isFinite(r.sold) ? r.sold : 0));
  }
  const out = new Map<string, boolean>();
  for (const r of stock) {
    const d = dayOf(r.day)!;
    out.set(d, (out.get(d) ?? true) && r.outOfStock);
  }
  const series: ChartDay[] = [];
  for (let k = days; k >= 1; k--) {
    const day = addDays(today, -k);
    series.push({ day, sold: sold.has(day) ? sold.get(day)! : null, out: out.has(day) ? out.get(day)! : null });
  }
  return series;
}

export type MonthTotal = { month: string; sold: number | null; outDays: number; dataDays: number };

/** Month totals for the chart's data-table fallback (newest first). */
export function monthlyTotals(series: readonly ChartDay[]): MonthTotal[] {
  const byMonth = new Map<string, MonthTotal>();
  for (const d of series) {
    const month = d.day.slice(0, 7);
    const m = byMonth.get(month) ?? { month, sold: null, outDays: 0, dataDays: 0 };
    if (d.sold !== null) {
      m.sold = (m.sold ?? 0) + d.sold;
      m.dataDays++;
    }
    if (d.out) m.outDays++;
    byMonth.set(month, m);
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** Last `n` days of the series, newest first (the "Recent sales" table). */
export function recentDays(series: readonly ChartDay[], n = 14): ChartDay[] {
  return series.slice(-n).reverse();
}

export type RateWindowView = { days: number; weight: number; inStockDays: number; rate: number | null; used: boolean };

/** Where the seasonal pattern came from (inputs.season: engine seasonFacts). */
export type SeasonSourceView =
  | { level: "store" }
  | { level: "collection"; collectionId: string; groupWeight?: number | null }
  | { level: "productType"; productType: string; groupWeight?: number | null };

/** inputs.season → its source; null when the metric has no season facts. `groupWeight` < 1: blended with the store's (accuracy audit 2026-10-18). */
export function readSeasonSource(raw: unknown): SeasonSourceView | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const w = typeof s.groupWeight === "number" && Number.isFinite(s.groupWeight) && s.groupWeight > 0 && s.groupWeight < 1 ? s.groupWeight : null;
  const blend = w !== null ? { groupWeight: w } : {};
  if (s.level === "collection" && typeof s.collectionId === "string" && s.collectionId) return { level: "collection", collectionId: s.collectionId, ...blend };
  if (s.level === "productType" && typeof s.productType === "string" && s.productType) return { level: "productType", productType: s.productType, ...blend };
  return s.level === "store" ? { level: "store" } : null;
}

/** inputs.season.seasonHistoryMonths (accuracy audit 2026-10-18); null when not under 13 months. */
function readSeasonsLearning(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const m = (raw as Record<string, unknown>).seasonHistoryMonths;
  return typeof m === "number" && Number.isInteger(m) && m >= 0 && m < 13 ? m : null;
}

export type ForecastInputsView = {
  windows: RateWindowView[];
  inStockDays: number | null;
  historyDays: number | null;
  seasonal: number | null;
  trend: number | null;
  leadTimeDays: number | null;
  leadTimeSource: "supplier" | "default" | null;
  cycleDays: number | null;
  z: number | null;
  /** The engine's safety stock, z × σ × √(lead time + order cycle): stored inputs.safety (rows stored before: the same formula); null when unknown. */
  safety: number | null;
  /** σ of the supplier's measured lead time the safety stock includes (days; supplier module); null = not used. */
  leadSigma?: number | null;
  /** Where the seasonal pattern came from; null for rows stored without it. */
  seasonSource?: SeasonSourceView | null;
  /** Under 13 months of sales: the whole months there are ("Seasons: learning — {n} of 13 months"); null otherwise. */
  seasonsLearning?: number | null;
  /** R4: unusual (spike) days capped in the pace; null for rows stored without it. */
  spikes?: SpikesView | null;
  /** R4: planned like another product / its type; null when not. */
  planLike?: PlanLikeView | null;
  /** R4: σ was measured on de-seasonalised demand. */
  sigmaSeasonal?: boolean;
  /** B4: safety stock from the forecast's own error — the days covered, the error, the fill target; null for rows stored without it. */
  error?: ErrorView | null;
  /** B5: a sustained level change the pace follows; null when none. */
  levelShift?: { day: string; ratio: number } | null;
};

export type ErrorView = { horizonDays: number; sigma: number; fill: number; ratio: number | null; samples: number };

function readError(raw: unknown): ErrorView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const horizonDays = n(r.horizonDays);
  const sigma = n(r.sigma);
  const fill = n(r.fill);
  if (horizonDays === null || sigma === null || fill === null) return null;
  return { horizonDays, sigma, fill, ratio: n(r.ratio), samples: n(r.samples) ?? 0 };
}

function readLevelShift(raw: unknown): { day: string; ratio: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ratio = n(r.ratio);
  return typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && ratio !== null ? { day: r.day, ratio } : null;
}

export type SpikesView = {
  cap: number | null;
  count: number;
  off: boolean;
  days: { day: string; sold: number; cap: number }[];
  /** Recurring high days added back to the pace, units a day (accuracy audit 2026-10-18); null when none. */
  recurringPerDay?: number | null;
};
export type PlanLikeView = { kind: "product" | "productType"; name: string; pct: number; ownDays: number; weight: number };

function readSpikes(raw: unknown): SpikesView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.days)
    ? r.days
        .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
        .map((d) => ({ day: typeof d.day === "string" ? d.day : "", sold: n(d.sold) ?? 0, cap: n(d.cap) ?? 0 }))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))
    : [];
  const rec = r.recurring && typeof r.recurring === "object" ? n((r.recurring as Record<string, unknown>).perDay) : null;
  return { cap: n(r.cap), count: Math.max(days.length, n(r.count) ?? 0), off: r.off === true, days, recurringPerDay: rec !== null && rec > 0 ? rec : null };
}

function readPlanLike(raw: unknown): PlanLikeView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.kind !== "product" && r.kind !== "productType") || typeof r.name !== "string") return null;
  return { kind: r.kind, name: r.name, pct: n(r.pct) ?? 100, ownDays: n(r.ownDays) ?? 0, weight: n(r.weight) ?? 1 };
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** VariantMetric.inputs (engine VariantInputs JSON), read defensively. */
export function readForecastInputs(raw: unknown, sigma: number | null): ForecastInputsView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const windows: RateWindowView[] = Array.isArray(r.windows)
    ? r.windows
        .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
        .map((w) => ({
          days: n(w.days) ?? 0,
          weight: n(w.weight) ?? 0,
          inStockDays: n(w.inStockDays) ?? 0,
          rate: n(w.rate),
          used: w.used === true,
        }))
    : [];
  const lead = n(r.leadTimeDays);
  const z = n(r.z);
  const cycle = n(r.cycleDays);
  const safety =
    n(r.safety) ??
    (z !== null && sigma !== null && Number.isFinite(sigma) && lead !== null ? safetyStock(z, sigma, lead + (cycle ?? 0)) : null);
  return {
    windows,
    inStockDays: n(r.inStockDays),
    historyDays: n(r.historyDays),
    seasonal: n(r.seasonal),
    trend: n(r.trend),
    leadTimeDays: lead,
    leadTimeSource: r.leadTimeSource === "supplier" || r.leadTimeSource === "default" ? r.leadTimeSource : null,
    cycleDays: cycle,
    z,
    safety,
    leadSigma: n(r.leadSigma),
    seasonSource: readSeasonSource(r.season),
    seasonsLearning: readSeasonsLearning(r.season),
    spikes: readSpikes(r.spikes),
    planLike: readPlanLike(r.planLike),
    sigmaSeasonal: r.sigmaSeasonal === true,
    error: readError(r.error),
    levelShift: readLevelShift(r.levelShift),
  };
}

/** A multiplier of exactly 1.0 means "no seasonal / trend data yet" (spec §7.3). */
export function isNeutralMultiplier(v: number | null): boolean {
  return v === null || v === 1;
}
