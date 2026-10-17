/**
 * The order-plan cache store (models/order-plan.server cachedOrderPlan), in its own module so the
 * writes that change what the plan reads can forget a shop's entries without importing the plan
 * (L2): sending / receiving / cancelling / deleting / re-opening an order, "Don't reorder", case
 * sizes, suppliers, settings, and the end of a compute run. The fingerprint still guards every
 * read (other processes, writes made elsewhere); this makes the change visible on the very next
 * page load in this process too.
 */
import type { OrderPlanDetail } from "./order-plan.server";

export type PlanCacheEntry = { fingerprint: string; at: number; value: Promise<OrderPlanDetail> };

/** Keyed `${shop}|${scope}`. */
export const planCache = new Map<string, PlanCacheEntry>();

/** Drop every cached plan of this shop (all scopes). */
export function forgetOrderPlan(shop: string): void {
  const prefix = `${shop}|`;
  for (const key of [...planCache.keys()]) if (key.startsWith(prefix)) planCache.delete(key);
}

/** Tests: start from an empty cache. */
export function clearOrderPlanCache(): void {
  planCache.clear();
}
