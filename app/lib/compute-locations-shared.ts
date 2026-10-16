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
 */
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
