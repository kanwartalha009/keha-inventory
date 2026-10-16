/**
 * locations/delete (spec §6.5): remove the Location row and its stock now. Idempotent.
 * Returns 500 on a DB failure so Shopify retries.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteLocation } from "../services/sync/catalog.server";
import { locationIdFromPayload } from "../lib/sync/webhook-shared";

export const action = async ({ request }: ActionFunctionArgs) => {
  const started = Date.now();
  const { shop, topic, payload } = await authenticate.webhook(request);
  const locationId = locationIdFromPayload(payload);
  if (locationId) {
    try {
      await deleteLocation(shop, locationId);
    } catch (e) {
      console.error(`[webhooks/${topic}] ${shop} ${locationId}`, e);
      return new Response("Delete failed", { status: 500 });
    }
  }
  console.log(`[webhooks/${topic}] ${shop} ${locationId ?? "?"} acked in ${Date.now() - started}ms`);
  return new Response();
};
