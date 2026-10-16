/**
 * The store's name and email addresses, read with the shop's offline token
 * (2026-09-28). Used where Keha Inventory acts outside an admin request (it never emails
 * shoppers):
 *   - supplier emails: sender name = the store's name, replies go to the store's contact email
 *   - the supplier confirmation page and the purchase-order PDF: the store's name
 *   - GDPR data requests: the answer is emailed to the store owner
 * Cached per shop for an hour. Never throws — null when the store can't be read.
 */
import { unauthenticated } from "../shopify.server";

export type ShopContact = {
  name: string;
  /** Customer-facing sender address (Settings → Store details). */
  contactEmail: string | null;
  /** The store owner's account email. */
  ownerEmail: string | null;
};

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: ShopContact | null }>();

const SHOP_CONTACT = `#graphql
  query KehaInvShopContact { shop { name email contactEmail } }`;

export async function getShopContact(shop: string): Promise<ShopContact | null> {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: ShopContact | null = null;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const res = await admin.graphql(SHOP_CONTACT);
    const body = (await res.json()) as {
      data?: { shop?: { name?: string; email?: string | null; contactEmail?: string | null } };
    };
    const s = body.data?.shop;
    if (s) {
      value = {
        name: s.name ?? "",
        contactEmail: s.contactEmail || null,
        ownerEmail: s.email || null,
      };
    }
  } catch (e) {
    console.error("[shop-contact] read failed", shop, e);
  }
  // Only cache successes — a failed read is retried on the next email.
  if (value) cache.set(shop, { at: Date.now(), value });
  return value;
}
