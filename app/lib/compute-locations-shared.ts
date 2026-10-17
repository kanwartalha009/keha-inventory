/**
 * Per-location planning — pure part (spec §3 `locations`, §4 J7, §7.1 "Store X"; Pro).
 *
 * One VariantMetric row per variant × planning location (an ACTIVE location whose role is
 * warehouse or store), scope = Location.id:
 *   stock: StockDaily at that location; a day is out when its ending units are ≤ 0 or it
 *          reported out of stock (the pooled rule with one location), and sold-out only when
 *          nothing sold (audit H1);
 *   data:  a day counts only when there is a StockDaily row at that location that day;
 *   onHand / incoming: StockNow at that location;
 *   carried: only variants stocked there — a StockNow row (Shopify has an inventory level
 *          at the location) or stock history in the window. A store that doesn't carry a
 *          product gets no row (it would read "Out" otherwise);
 *   engine: the same computeVariant with the variant's ABC role, supplier, case pack and
 *          the seasonal × trend (and weekly shape) already worked out for the pool (seasonality
 *          is store or collection level, never recomputed per location). Keha orders are
 *          counted with the pool only (they carry no destination location).
 *
 * Demand per location (audit 2026-10-17, H7: every warehouse used to be judged against ALL
 * online demand, so three warehouses got 3× the advice). `demandSourceFor`:
 *   store                                → its OWN sales (SalesDaily location view, key = the
 *     ("own")                              store's id: its POS sales). Order advice only for a
 *                                          store with sales of its own in the window; a store
 *                                          without any gets a neutral "Not enough data";
 *   warehouse that counts in supplier    → planned as ONE POOL: its share of the online demand
 *     orders ("online_pool")               (location view keys "online" + the pool warehouses'
 *                                          own POS sales), split across the pool's warehouses by
 *                                          their stock on hand (`warehouseShares`). So the
 *                                          warehouses' days left equal the pool's and their keep
 *                                          levels add up to the pool's once (the transfer plan
 *                                          keeps demandSource "online_pool" semantics: never
 *                                          twice). No per-warehouse order advice: the pool
 *                                          (scope "online") orders for all of them;
 *   warehouse left out of supplier orders → its own sales when it has any in the window; with
 *     ("own" / neutral)                    none, a neutral "Not enough data" (no days left, no
 *                                          order advice) instead of Dead / Too much — nothing to
 *                                          judge it by. Rate and σ stay (0) for the transfer plan.
 *   Rate windows only: stock rows are read for the history window the rate needs, nothing older.
 */
import type { DailyRow, VariantResult } from "./engine/index-shared";
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
 * A store, or a warehouse left out of supplier orders, with no sale of its own in the window:
 * neutral "Not enough data" — no days left, no order advice (never Dead / Too much from 0 sales).
 * Locations that sold something there, and pool warehouses (online demand), keep their result.
 */
export function neutralLocation(r: VariantResult, source: DemandSource, ownSold: number): VariantResult {
  if (source !== "own" || ownSold > 0) return r;
  return {
    ...r,
    status: "not_enough_data",
    daysLeft: null,
    coverDays: null,
    safetyDays: null,
    orderQty: null,
    orderBy: null,
    inputs: { ...r.inputs, orderNeed: null },
  };
}

/** Kept for its readers: the warehouse-only form of neutralLocation. */
export function neutralWarehouse(r: VariantResult, role: string, source: DemandSource, ownSold: number): VariantResult {
  return role === "warehouse" ? neutralLocation(r, source, ownSold) : r;
}

/** A pool warehouse: the pool orders for it — no order quantity, order-by or need of its own. */
export function poolWarehouse(r: VariantResult): VariantResult {
  return { ...r, orderQty: null, orderBy: null, inputs: { ...r.inputs, orderNeed: null } };
}

/**
 * Each pool warehouse's share of the online demand for one variant: its on-hand ÷ the pool
 * warehouses' total on-hand (negative counts as 0); equal shares when none holds stock. Shares
 * add up to 1.
 */
export function warehouseShares(onHandByWarehouse: ReadonlyMap<string, number>): Map<string, number> {
  const ids = [...onHandByWarehouse.keys()];
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const total = ids.reduce((a, id) => a + Math.max(0, onHandByWarehouse.get(id) ?? 0), 0);
  for (const id of ids) out.set(id, total > 0 ? Math.max(0, onHandByWarehouse.get(id) ?? 0) / total : 1 / ids.length);
  return out;
}

/**
 * A pool warehouse's daily series: the pool's days (its in-stock flags) with `sold` = that day's
 * online demand × the warehouse's share. Days the pool has no row for stay missing.
 */
export function shareSeries(
  poolSeries: readonly DailyRow[],
  onlineSoldByDay: ReadonlyMap<string, number> | undefined,
  share: number,
): DailyRow[] {
  const k = Number.isFinite(share) ? Math.max(0, share) : 0;
  return poolSeries.map((r) => ({ ...r, sold: (onlineSoldByDay?.get(r.day) ?? 0) * k }));
}
