/**
 * Per-location planning — pure part (spec §3 `locations`, §4 J7, §7.1 "Store X"; Pro).
 *
 * One VariantMetric row per variant × planning location (an ACTIVE location whose role is
 * warehouse or store), scope = Location.id:
 *   sales: the SalesDaily LOCATION view only — channel "all", locationKey = that location's
 *          id (its POS sales). Never the channel view (locationKey "all"): the two views
 *          hold the same sales and must never be added together. Online orders are keyed
 *          "online" whichever location fulfils them, so a warehouse's own rate is its POS
 *          sales only (usually none) — its online demand is the online pool's;
 *   stock: StockDaily at that location; a day is out when its ending units are ≤ 0 or it
 *          reported out of stock (the pooled rule with one location);
 *   data:  a day counts only when there is a StockDaily row at that location that day;
 *   onHand / incoming: StockNow at that location;
 *   carried: only variants stocked there — a StockNow row (Shopify has an inventory level
 *          at the location) or stock history in the window. A store that doesn't carry a
 *          product gets no row (it would read "Out" otherwise);
 *   engine: the same computeVariant with the variant's ABC role, supplier, case pack and
 *          the seasonal × trend already worked out for the online pool (seasonality is
 *          store or collection level, never recomputed per location). Keha orders are
 *          counted with the online pool only (they carry no destination location).
 *
 * Warehouses (review fix: a warehouse's own sales are its POS sales, ≈ 0, so nearly every
 * product read Dead / Too much there). Demand source per location (`demandSourceFor`):
 *   store                               → its own sales (as above);
 *   warehouse that counts for online    → the ONLINE POOL's sales series (rate, σ, in-stock
 *     sales ("online_pool")               days, last sale) applied to the warehouse's own stock:
 *                                         status / days left / order-by say how long THIS
 *                                         warehouse's stock lasts at the online pace. With several
 *                                         pool locations each one is measured against the whole
 *                                         online pace (conservative: it reads low sooner).
 *                                         inputs.demandSource = "online_pool" so the transfer plan
 *                                         doesn't keep the online pool's needs twice;
 *   warehouse outside the online pool   → its own sales when it has any in the window; with
 *     ("own" / neutral)                   none, a neutral "Not enough data" (no days left, no
 *                                         order advice) instead of Dead / Too much — nothing to
 *                                         judge it by. Rate and σ stay (0) for the transfer plan.
 *   Rate windows only: stock rows are read for the history window the rate needs, nothing older.
 */
import type { VariantResult } from "./engine/index-shared";
import type { PooledStockDay } from "./compute-shared";
import { SCOPE_ONLINE } from "./compute-shared";

export type LocationStockDay = { variantId: string; day: string; endUnits: number; outOfStock: boolean };

/** StockDaily rows of ONE location → the pooled shape buildSeries reads (one reporter a day). */
export function locationStockDays(rows: readonly LocationStockDay[]): PooledStockDay[] {
  const byKey = new Map<string, PooledStockDay>();
  for (const r of rows) {
    const k = `${r.variantId}|${r.day}`;
    const cur = byKey.get(k);
    if (cur) {
      // One row per (variant, day, location) by the table's key; sum defensively.
      cur.endUnits += r.endUnits;
      cur.reported += 1;
      cur.outReported += r.outOfStock ? 1 : 0;
    } else byKey.set(k, { variantId: r.variantId, day: r.day, endUnits: r.endUnits, reported: 1, outReported: r.outOfStock ? 1 : 0 });
  }
  return [...byKey.values()];
}

/** Variants stocked at a location: an inventory level now, or stock history in the window. */
export function carriedAt(stockNowIds: Iterable<string>, historyIds: Iterable<string>): Set<string> {
  return new Set([...stockNowIds, ...historyIds]);
}

/** VariantMetric scopes to keep: the online pool plus each planning location. */
export function keptScopes(planningIds: readonly string[]): string[] {
  return [SCOPE_ONLINE, ...planningIds];
}

export type DemandSource = "own" | "online_pool";

/** Where a planning location's demand comes from (see the header). */
export function demandSourceFor(role: string, inPool: boolean): DemandSource {
  return role === "warehouse" && inPool ? "online_pool" : "own";
}

/**
 * A warehouse outside the online pool with no sale of its own in the window: neutral "Not
 * enough data" — no days left, no order advice (never Dead / Too much from 0 sales). Stores, and
 * warehouses that sold something there, keep their result.
 */
export function neutralWarehouse(r: VariantResult, role: string, source: DemandSource, ownSold: number): VariantResult {
  if (role !== "warehouse" || source !== "own" || ownSold > 0) return r;
  return { ...r, status: "not_enough_data", daysLeft: null, safetyDays: null, orderQty: null, orderBy: null };
}
