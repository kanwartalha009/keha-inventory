/**
 * GDPR compliance webhook — customers/redact.
 * The app stores no shopper personal data (spec §10); the handler removes
 * delivered Nova outbox copies that carry the customer's email. Returns 500
 * on failure so Shopify retries until the redaction is confirmed.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactCustomer, type GdprRequest } from "../services/gdpr.server";
import { forwardToIngress } from "../lib/nova.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[gdpr] ${topic} for ${shop}`);

  await forwardToIngress({
    topic,
    shopDomain: shop,
    webhookId: request.headers.get("X-Shopify-Webhook-Id"),
    payload,
  });

  try {
    const r = await redactCustomer(shop, payload as GdprRequest);
    console.log(
      `[gdpr] redact ${shop}: no shopper data stored; ${r.outboxDeleted} outbox copy(ies) deleted`,
    );
  } catch (e) {
    console.error("[gdpr] customers/redact failed", e);
    return new Response("Redaction failed", { status: 500 });
  }
  return new Response();
};
