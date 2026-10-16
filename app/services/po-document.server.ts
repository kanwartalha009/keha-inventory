/**
 * Everything the PDF / CSV of a Keha order needs (spec §5.3): the order, the
 * store's name and language, whether the supplier sees prices, and the
 * supplier-page link while it works. Shared by the merchant downloads and the
 * public supplier page.
 */
import prisma from "../db.server";
import { toSupportedLocale } from "../lib/i18n";
import { storeLabel } from "../lib/dashboard-shared";
import { confirmLinkOpen } from "../lib/purchase-order-shared";
import { confirmUrl } from "../lib/po-email-shared";
import { getShopContact } from "./shop-contact.server";
import { getOrder, hidePricesFor, type OrderDetail } from "../models/reorder.server";
import type { PoPdfInput } from "./po-pdf.server";

export async function documentFor(shop: string, order: OrderDetail, now: Date = new Date()): Promise<PoPdfInput> {
  const [shopRow, contact] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { locale: true } }),
    getShopContact(shop),
  ]);
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const linkOpen = confirmLinkOpen({ source: order.source, status: order.status, confirmExpiresAt: order.confirmExpiresAt }, now);
  return {
    locale: toSupportedLocale(shopRow?.locale),
    storeName: contact?.name || storeLabel(shop),
    number: order.number,
    supplierName: order.supplier?.name ?? order.supplierName,
    orderDate: (order.sentAt ?? order.createdAt).slice(0, 10),
    expectedDate: order.expectedDate,
    confirmedShipDate: order.confirmedShipDate,
    currency: order.currency,
    hidePrices: hidePricesFor(order),
    lines: order.lines,
    confirmUrl: linkOpen && appUrl ? confirmUrl(appUrl, order.confirmToken) : null,
  };
}

/** A Keha order of this shop as a document; null for a missing or Shopify order. */
export async function poDocument(shop: string, id: string): Promise<{ pdf: PoPdfInput } | null> {
  const order = await getOrder(shop, id);
  if (!order || order.source !== "keha") return null;
  return { pdf: await documentFor(shop, order) };
}
