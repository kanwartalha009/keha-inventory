import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { forwardToIngress } from "../lib/nova.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Nova platform: forward the lifecycle event to the ingress (billing source of truth, §5.2).
  // Resilient — no-ops if NOVA_API is unset, never throws (handler still returns 200).
  await forwardToIngress({
    topic,
    shopDomain: shop,
    webhookId: request.headers.get("X-Shopify-Webhook-Id"),
    payload,
  });

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // GDPR §7.4: record the uninstall so `cron.purge-uninstalled` hard-deletes the
  // shop's data 48h later. Idempotent (re-arms the timer if the webhook repeats).
  // UninstalledShop arrives via `prisma db push`; reach it through a narrow cast.
  await (
    db as unknown as {
      uninstalledShop: {
        upsert(a: {
          where: { shop: string };
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }): Promise<unknown>;
      };
    }
  ).uninstalledShop
    .upsert({
      where: { shop },
      update: { uninstalledAt: new Date(), purgedAt: null },
      create: { shop },
    })
    .catch((e) => console.error("[uninstall] purge stamp failed", e));

  return new Response();
};
