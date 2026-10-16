/**
 * Compute — pure part (spec §7, task 1.5): stored daily facts → engine inputs, and engine
 * results → stored rows. No I/O.
 *
 * Phase 1 rule (spec §3: one stock pool on Free / Growth; per-location planning is Pro,
 * phase 3; spec §7.1 "Online pool" = the sum over active, fulfillsOnlineOrders locations):
 * scope "online" =
 *   pool:  the ACTIVE locations that FULFIL ONLINE ORDERS;
 *   sales: the SalesDaily LOCATION view (channel "all") for locationKey "online" (sales with
 *          no POS location) plus the pool location ids — never the channel view, which
 *          includes POS stores outside the pool;
 *   stock: Σ StockDaily over the pool; a day is out of stock when the pooled ending units
 *          are ≤ 0 OR every pooled location that reported that day reported out of stock;
 *   data:  a day counts only when the variant has a pool StockDaily row that day; sales on a
 *          day without one are MISSING data, never "in stock";
 *   onHand / incoming: Σ StockNow over the pool.
 * The channel view (locationKey "all") is used only for revenue (ABC) and the unit price.
 */
import type { DailyRow, EngineSettings, VariantResult } from "./engine/index-shared";
import type { ProductTraffic, StoreConversion } from "./engine/money-shared";
import type { ShopSettings } from "./settings-shared";

export const SCOPE_ONLINE = "online";

/** Rows of facts the server reads (already grouped by variant × day in SQL). */
export type SalesDay = { variantId: string; day: string; sold: number; gross: number };
export type PooledStockDay = {
  variantId: string;
  day: string;
  /** Σ endUnits over the pooled locations that reported this day. */
  endUnits: number;
  /** Pooled locations with a row that day. */
  reported: number;
  /** …of which reported out of stock. */
  outReported: number;
};

export function poolLocationIds(locations: { id: string; active: boolean; online: boolean }[]): string[] {
  return locations.filter((l) => l.active && l.online).map((l) => l.id);
}

export function pooledOutOfStock(s: Pick<PooledStockDay, "endUnits" | "reported" | "outReported">): boolean {
  return s.endUnits <= 0 || (s.reported > 0 && s.outReported === s.reported);
}

/** SalesDaily location-view keys that belong to the online pool. */
export function poolSalesKeys(pool: string[]): string[] {
  return ["online", ...pool];
}

/**
 * Per-variant daily series. A day exists only when the variant has a pool stock row that
 * day (no row = missing data, never a zero-sale or in-stock day). `poolSales` (location view,
 * pool keys) gives units sold; `priceSales` (channel view) gives the day's unit price as
 * gross ÷ units.
 */
export function buildSeries(poolSales: SalesDay[], stock: PooledStockDay[], priceSales: SalesDay[] = []): Map<string, DailyRow[]> {
  const byVariant = new Map<string, Map<string, DailyRow>>();
  for (const s of stock) {
    let days = byVariant.get(s.variantId);
    if (!days) byVariant.set(s.variantId, (days = new Map()));
    days.set(s.day, { day: s.day, sold: 0, endStock: s.endUnits, outOfStock: pooledOutOfStock(s), price: null });
  }
  for (const s of poolSales) {
    const r = byVariant.get(s.variantId)?.get(s.day);
    if (r) r.sold += s.sold; // a sale on a day without pool stock data stays missing
  }
  const price = new Map<string, { sold: number; gross: number }>();
  for (const s of priceSales) {
    const k = `${s.variantId}|${s.day}`;
    const p = price.get(k) ?? { sold: 0, gross: 0 };
    p.sold += s.sold;
    p.gross += s.gross;
    price.set(k, p);
  }
  const out = new Map<string, DailyRow[]>();
  for (const [variantId, days] of byVariant) {
    const list = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    for (const r of list) {
      const p = price.get(`${variantId}|${r.day}`);
      r.price = p && p.sold > 0 && p.gross > 0 ? p.gross / p.sold : null;
    }
    out.set(variantId, list);
  }
  return out;
}

/** Σ gross over the series (90-day revenue for ABC). */
export function revenueOf(sales: SalesDay[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sales) m.set(s.variantId, (m.get(s.variantId) ?? 0) + s.gross);
  return m;
}

/** Shop settings → the engine overrides this phase uses (safety level maps in phase 2). */
export function engineSettingsFrom(s: ShopSettings): Partial<EngineSettings> {
  return { leadTimeDays: s.leadTimeDays, cycleDays: s.cycleDays, tooMuchDays: s.tooMuchDays, deadDays: s.deadDays };
}

// ---------------------------------------------------------------------------
// Sold-out page traffic
// ---------------------------------------------------------------------------

const PRODUCT_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z0-9]{2,4})?\/)?(?:collections\/[^/]+\/)?products\/([^/?#]+)\/?$/i;

/**
 * Product handle in a landing path: `/products/<handle>`, locale-prefixed `/es/products/<h>`
 * or `/en-us/products/<h>`, and the collection-scoped `/collections/<c>/products/<h>`. Query
 * and fragment are ignored; the handle is lower-cased and URL-decoded. Null otherwise.
 */
export function productHandleFromPath(path: string): string | null {
  const clean = path.trim().split(/[?#]/)[0];
  const m = PRODUCT_PATH_RE.exec(clean);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

export type TrafficProduct = { productId: string; handle: string; variantIds: string[] };

/**
 * One entry per product per day in [from, to] on which EVERY variant has data; fully out of
 * stock when every variant was out that day. Sessions = landings on the product's URL.
 */
export function productTraffic(
  products: TrafficProduct[],
  series: Map<string, DailyRow[]>,
  sessionsByHandleDay: Map<string, Map<string, number>>,
  from: string,
  to: string,
): ProductTraffic[] {
  const outByVariant = new Map<string, Map<string, boolean>>();
  for (const [v, rows] of series) {
    const m = new Map<string, boolean>();
    for (const r of rows) if (r.day >= from && r.day <= to) m.set(r.day, r.outOfStock);
    outByVariant.set(v, m);
  }
  const out: ProductTraffic[] = [];
  for (const p of products) {
    if (!p.variantIds.length) continue;
    const first = outByVariant.get(p.variantIds[0]);
    if (!first) continue;
    const sessions = sessionsByHandleDay.get(p.handle.toLowerCase());
    const days: ProductTraffic["days"][number][] = [];
    for (const day of [...first.keys()].sort()) {
      let allOut = true;
      let complete = true;
      for (const v of p.variantIds) {
        const o = outByVariant.get(v)?.get(day);
        if (o === undefined) {
          complete = false;
          break;
        }
        if (!o) allOut = false;
      }
      if (!complete) continue;
      days.push({ day, fullyOutOfStock: allOut, sessions: sessions?.get(day) ?? 0 });
    }
    out.push({ productId: p.productId, handle: p.handle, days });
  }
  return out;
}

/** Landing sessions per product handle per day. */
export function sessionsByHandle(rows: { landingPath: string; day: string; sessions: number }[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const h = productHandleFromPath(r.landingPath);
    if (!h) continue;
    let days = m.get(h);
    if (!days) m.set(h, (days = new Map()));
    days.set(r.day, (days.get(r.day) ?? 0) + r.sessions);
  }
  return m;
}

/** Store conversion = Σ checkouts ÷ Σ sessions; AOV = Σ gross ÷ Σ orders. Null when unknown. */
export function storeConversion(t: { sessions: number; checkouts: number; orders: number; gross: number }): StoreConversion {
  return {
    conversionRate: t.sessions > 0 ? t.checkouts / t.sessions : null,
    aov: t.orders > 0 && t.gross > 0 ? t.gross / t.orders : null,
  };
}

// ---------------------------------------------------------------------------
// Results → rows
// ---------------------------------------------------------------------------

export type MetricRow = {
  rate: number | null;
  sigma: number | null;
  daysLeft: number | null;
  neverRunsOut: boolean;
  status: string;
  role: string;
  orderQty: number | null;
  orderBy: string | null;
  inputs: unknown;
};

/** JSON-safe copy: non-finite numbers become null (Postgres JSON has no Infinity / NaN). */
export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? null : x)));
}

/** daysLeft Infinity (rate 0 with stock) → null + neverRunsOut, never a huge number. */
export function metricRow(r: VariantResult): MetricRow {
  const infinite = r.daysLeft === Infinity;
  return {
    rate: r.rate,
    sigma: r.sigma,
    daysLeft: infinite || r.daysLeft === null || !Number.isFinite(r.daysLeft) ? null : r.daysLeft,
    neverRunsOut: infinite,
    status: r.status,
    role: r.role,
    orderQty: r.orderQty,
    orderBy: r.orderBy,
    inputs: jsonSafe(r.inputs),
  };
}

/** Free plan: money is recomputed only when the last row is from an earlier calendar month. */
export function moneyDue(refresh: "monthly" | "daily", lastDay: string | null, today: string): boolean {
  if (refresh === "daily" || !lastDay) return true;
  return lastDay.slice(0, 7) < today.slice(0, 7);
}
