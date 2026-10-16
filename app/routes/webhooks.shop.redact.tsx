/**
 * GDPR compliance webhook — shop/redact.
 * Sent 48h after a shop uninstalls: hard-delete every shop-scoped row. Returns
 * 500 on failure so Shopify retries until the purge is confirmed.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShopData } from "../services/gdpr.server";
import { forwardToIngress } from "../lib/nova.server";
import prisma from "../db.server";

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
    const counts = await purgeShopData(shop);
    // Clear our own uninstall bookkeeping too.
    await (
      prisma as unknown as {
        uninstalledShop: { deleteMany(a: { where: { shop: string } }): Promise<unknown> };
      }
    ).uninstalledShop
      .deleteMany({ where: { shop } })
      .catch(() => {});
    console.log(`[gdpr] shop/redact ${shop}: ${JSON.stringify(counts)}`);
  } catch (e) {
    console.error("[gdpr] shop/redact failed", e);
    return new Response("Purge failed", { status: 500 });
  }
  return new Response();
};
