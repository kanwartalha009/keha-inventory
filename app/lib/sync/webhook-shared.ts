/**
 * Webhook payload readers and the per-item debounce (spec §6.5, task 1.2a). Pure.
 *
 * Payloads are the REST-shaped JSON Shopify sends for these topics:
 *   inventory_levels/update  { inventory_item_id, location_id, available, updated_at }
 *   products/update|delete   { id, admin_graphql_api_id? }
 *   locations/*              { id, name, active, admin_graphql_api_id? }
 */
import { toGid } from "./catalog-shared";

type Obj = Record<string, unknown>;
const obj = (p: unknown): Obj => (p && typeof p === "object" ? (p as Obj) : {});

export function inventoryItemFromPayload(payload: unknown): string | undefined {
  return toGid("InventoryItem", obj(payload).inventory_item_id);
}

export function productIdFromPayload(payload: unknown): string | undefined {
  const p = obj(payload);
  return toGid("Product", p.admin_graphql_api_id) ?? toGid("Product", p.id);
}

export function locationIdFromPayload(payload: unknown): string | undefined {
  const p = obj(payload);
  return toGid("Location", p.admin_graphql_api_id) ?? toGid("Location", p.id);
}

/** inventory_levels/update fires on every change; refresh one item at most once per window. */
export const STOCK_DEBOUNCE_MS = 60_000;

/**
 * In-memory "last refresh" map keyed by (shop, item). `shouldRun` records the run when it
 * returns true. Entries older than the window are pruned when the map grows large.
 */
export class Debouncer {
  private last = new Map<string, number>();
  constructor(
    private readonly windowMs: number = STOCK_DEBOUNCE_MS,
    private readonly maxEntries = 10_000,
  ) {}

  shouldRun(key: string, nowMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < this.windowMs) return false;
    this.last.set(key, nowMs);
    if (this.last.size > this.maxEntries) this.prune(nowMs);
    return true;
  }

  prune(nowMs: number): void {
    for (const [k, t] of this.last) if (nowMs - t >= this.windowMs) this.last.delete(k);
  }

  get size(): number {
    return this.last.size;
  }
}

export function debounceKey(shop: string, inventoryItemId: string): string {
  return `${shop}|${inventoryItemId}`;
}
