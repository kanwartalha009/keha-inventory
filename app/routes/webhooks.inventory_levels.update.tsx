/**
 * inventory_levels/update (spec §6.5): refresh that inventory item's stock now, at most once
 * per 60 s per (shop, item). Idempotent: a refresh re-reads Shopify's current state. Always
 * 200: the nightly stock-now run is the safety net, so a retry storm buys nothing.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refreshStockForInventoryItem } from "../services/sync/catalog.server";
import { Debouncer, debounceKey, inventoryItemFromPayload } from "../lib/sync/webhook-shared";

const g = globalThis as unknown as { __kehaInvStockDebounce?: Debouncer };
const debounce = (g.__kehaInvStockDebounce ??= new Debouncer());

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = Date.now();
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const itemId = inventoryItemFromPayload(payload);
  let outcome = "skipped";
  if (itemId && admin && debounce.shouldRun(debounceKey(shop, itemId), started)) {
    try {
      const n = await refreshStockForInventoryItem(admin, shop, itemId);
      outcome = `refreshed ${n} level(s)`;
    } catch (e) {
      outcome = "failed";
      console.error(`[webhooks/${topic}] ${shop} ${itemId}`, e);
    }
  } else if (itemId && admin) {
    outcome = "debounced";
  }
  console.log(`[webhooks/${topic}] ${shop} ${itemId ?? "?"} ${outcome}, acked in ${Date.now() - started}ms`);
  return new Response();
};
