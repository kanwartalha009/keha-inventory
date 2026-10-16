/**
 * products/update (spec §6.5): re-read that product's variants and upsert them. Idempotent
 * (re-reads Shopify's current state). Always 200; the nightly catalog run is the safety net.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncProduct } from "../services/sync/catalog.server";
import { productIdFromPayload } from "../lib/sync/webhook-shared";

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = Date.now();
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const productId = productIdFromPayload(payload);
  let outcome = "skipped";
  if (productId && admin) {
    try {
      outcome = `upserted ${await syncProduct(admin, shop, productId)} variant(s)`;
    } catch (e) {
      outcome = "failed";
      console.error(`[webhooks/${topic}] ${shop} ${productId}`, e);
    }
  }
  console.log(`[webhooks/${topic}] ${shop} ${productId ?? "?"} ${outcome}, acked in ${Date.now() - started}ms`);
  return new Response();
};
