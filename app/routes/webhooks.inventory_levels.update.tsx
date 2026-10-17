/**
 * inventory_levels/update (spec §6.5): refresh that inventory item's stock now, debounced
 * TRAILING per (shop, item): the first event schedules a refresh 60 s later and events in
 * between are coalesced into it, so a burst costs one Admin read and the final state is
 * always applied. Idempotent: a refresh re-reads Shopify's current state. Always 200 (the
 * refresh runs after the ack); the nightly stock-now run is the safety net.
 *
 * The payload's own `available` is NOT written: the refresh re-reads every level of the item
 * through GraphQL and stores available, on_hand, committed and incoming together (field
 * semantics: catalog-shared StockLevelRow), so the planning position (available, may be
 * negative) and on hand never drift apart.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refreshStockForInventoryItem } from "../services/sync/catalog.server";
import { TrailingDebouncer, debounceKey, inventoryItemFromPayload } from "../lib/sync/webhook-shared";

const g = globalThis as unknown as { __kehaInvStockDebounce?: TrailingDebouncer };
const debounce = (g.__kehaInvStockDebounce ??= new TrailingDebouncer());

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = Date.now();
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const itemId = inventoryItemFromPayload(payload);
  let outcome = "skipped";
  if (itemId && admin) {
    outcome = debounce.schedule(debounceKey(shop, itemId), async () => {
      try {
        const n = await refreshStockForInventoryItem(admin, shop, itemId);
        console.log(`[webhooks/${topic}] ${shop} ${itemId} refreshed ${n} level(s)`);
      } catch (e) {
        console.error(`[webhooks/${topic}] ${shop} ${itemId} refresh failed`, e);
      }
    });
  }
  console.log(`[webhooks/${topic}] ${shop} ${itemId ?? "?"} ${outcome}, acked in ${Date.now() - started}ms`);
  return new Response();
};
