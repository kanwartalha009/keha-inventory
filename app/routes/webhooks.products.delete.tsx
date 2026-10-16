/**
 * products/delete (spec §6.5): delete that product's Variant, StockNow and VariantMetric rows.
 * Daily history stays (it is history; purged with the shop). Idempotent. Returns 500 on a DB
 * failure so Shopify retries (no nightly run removes a deleted product's metrics sooner).
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteProduct } from "../services/sync/catalog.server";
import { productIdFromPayload } from "../lib/sync/webhook-shared";

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = Date.now();
  const { shop, topic, payload } = await authenticate.webhook(request);
  const productId = productIdFromPayload(payload);
  if (productId) {
    try {
      const n = await deleteProduct(shop, productId);
      console.log(`[webhooks/${topic}] ${shop} ${productId} removed ${n} variant(s), acked in ${Date.now() - started}ms`);
    } catch (e) {
      console.error(`[webhooks/${topic}] ${shop} ${productId}`, e);
      return new Response("Delete failed", { status: 500 });
    }
  }
  return new Response();
};
