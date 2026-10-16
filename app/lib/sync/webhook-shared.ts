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

type Timer = (fn: () => void, ms: number) => unknown;

const unrefTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
};

/**
 * TRAILING debounce keyed by (shop, item) (review M): the first event in a window schedules
 * the refresh at the window's END; later events in the window are coalesced into it (the
 * newest job replaces the older one). The key is released just before the job runs, so an
 * event that arrives during or after the refresh schedules a new one — the last change is
 * always applied. Timers are unref'd so they never keep the process alive.
 */
export class TrailingDebouncer {
  private pending = new Map<string, { job: () => Promise<void> }>();
  constructor(
    private readonly windowMs: number = STOCK_DEBOUNCE_MS,
    private readonly timer: Timer = unrefTimer,
  ) {}

  schedule(key: string, job: () => Promise<void>): "scheduled" | "coalesced" {
    const existing = this.pending.get(key);
    if (existing) {
      existing.job = job;
      return "coalesced";
    }
    const entry = { job };
    this.pending.set(key, entry);
    this.timer(() => {
      this.pending.delete(key);
      void entry.job().catch(() => {});
    }, this.windowMs);
    return "scheduled";
  }

  get size(): number {
    return this.pending.size;
  }
}

export function debounceKey(shop: string, inventoryItemId: string): string {
  return `${shop}|${inventoryItemId}`;
}
