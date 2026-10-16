/**
 * Billing state. Since 2026-09-28 Keha Inventory uses Shopify App Pricing (managed
 * pricing): plans are defined in the Partner Dashboard and chosen on Shopify's
 * plan page, and app-pricing.server syncs the merchant's plan into
 * `BillingState` from the Partner API. The old Nova-priced
 * `appSubscriptionCreate` flow was removed — Shopify doesn't allow creating
 * charges with the Billing API once App Pricing is on. Choosing / changing a
 * plan still works, on Shopify's page (App Store requirement 1.2.3).
 */
import prisma from "../db.server";

export type BillingRow = {
  shop: string;
  planCode: string | null;
  interval: string | null;
  status: string | null;
  subscriptionId: string | null;
  currentPeriodEnd: Date | null;
};

const billingState = (
  prisma as unknown as {
    billingState: {
      findUnique(a: { where: { shop: string } }): Promise<BillingRow | null>;
      upsert(a: {
        where: { shop: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }): Promise<unknown>;
    };
  }
).billingState;

export async function getBillingState(shop: string): Promise<BillingRow | null> {
  return billingState.findUnique({ where: { shop } });
}

export async function saveBillingState(
  shop: string,
  data: Partial<BillingRow>,
): Promise<void> {
  await billingState.upsert({
    where: { shop },
    create: { shop, ...data },
    update: { ...data },
  });
}
