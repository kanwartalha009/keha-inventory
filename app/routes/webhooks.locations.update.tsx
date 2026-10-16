/**
 * locations/update (spec §6.5): re-read the location through GraphQL (the REST-shaped payload is not
 * relied on for fulfillsOnlineOrders) and
 * upsert it; the stored role is never overwritten. Idempotent. Always 200; the nightly
 * locations run is the safety net.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refreshLocation } from "../services/sync/catalog.server";
import { locationIdFromPayload } from "../lib/sync/webhook-shared";

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = Date.now();
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const locationId = locationIdFromPayload(payload);
  let outcome = "skipped";
  if (locationId && admin) {
    try {
      outcome = (await refreshLocation(admin, shop, locationId)) ? "upserted" : "not found";
    } catch (e) {
      outcome = "failed";
      console.error(`[webhooks/${topic}] ${shop} ${locationId}`, e);
    }
  }
  console.log(`[webhooks/${topic}] ${shop} ${locationId ?? "?"} ${outcome}, acked in ${Date.now() - started}ms`);
  return new Response();
};
