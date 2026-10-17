/**
 * Everything the PDF / CSV of a Keha order needs (spec §5.3): the order, the
 * store's name and language, whether the supplier sees prices, and the
 * supplier-page link while it works. Shared by the merchant downloads and the
 * public supplier page. Prices are in the supplier's currency when it has an
 * exchange rate (else the store currency, labelled); the arrival is the ship
 * date + transit days.
 */
import prisma from "../db.server";
import { toSupportedLocale } from "../lib/i18n";
import { storeLabel } from "../lib/dashboard-shared";
import { confirmLinkOpen, supplierLines, type SupplierLine } from "../lib/purchase-order-shared";
import type { GridLine } from "../lib/po-grid-shared";
import { confirmUrl } from "../lib/po-email-shared";
import { getShopContact } from "./shop-contact.server";
import { getOrder, hidePricesFor, pricingFor, type OrderDetail } from "../models/reorder.server";
import type { PoPdfInput } from "./po-pdf.server";

export async function documentFor(shop: string, order: OrderDetail, now: Date = new Date()): Promise<PoPdfInput> {
  const [shopRow, contact] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { locale: true } }),
    getShopContact(shop),
  ]);
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const hidePrices = hidePricesFor(order);
  // Prices in the supplier's currency when it has an exchange rate (audit 2026-10-17), else as stored.
  const pricing = pricingFor(order);
  const linkOpen = confirmLinkOpen({ source: order.source, status: order.status, confirmExpiresAt: order.confirmExpiresAt }, now);
  const lines = supplierLines(order.lines, hidePrices, pricing.factor);
  return {
    locale: toSupportedLocale(shopRow?.locale),
    storeName: contact?.name || storeLabel(shop),
    number: order.number,
    supplierName: order.supplier?.name ?? order.supplierName,
    orderDate: (order.sentAt ?? order.createdAt).slice(0, 10),
    // Arrival = confirmed ship date + the supplier's transit days, else the lead-time estimate.
    expectedDate: order.arrival,
    confirmedShipDate: order.confirmedShipDate,
    currency: pricing.currency,
    hidePrices,
    // Supplier-safe lines: no variant ids / stock, and no unit cost when prices are hidden.
    lines,
    // The same lines grouped per product for the size grid (an opaque counter per product, never an id).
    gridLines: await gridLinesFor(shop, order.lines.map((l) => l.variantId), lines),
    confirmUrl: linkOpen && appUrl ? confirmUrl(appUrl, order.confirmToken) : null,
  };
}

/**
 * The document's lines with their product grouping and supplier code: products and codes are read
 * from the catalog (a deleted variant groups by its product title); the group key is a counter.
 */
async function gridLinesFor(shop: string, variantIds: readonly string[], lines: readonly SupplierLine[]): Promise<GridLine[]> {
  const rows = variantIds.length
    ? await prisma.variant.findMany({ where: { shop, id: { in: [...new Set(variantIds)] } }, select: { id: true, productId: true, supplierCode: true } })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = new Map<string, string>();
  return lines.map((l, i) => {
    const v = byId.get(variantIds[i]!);
    const key = v ? `p:${v.productId}` : `t:${l.productTitle}`;
    if (!groups.has(key)) groups.set(key, `g${groups.size + 1}`);
    return { ...l, group: groups.get(key)!, supplierCode: v?.supplierCode ?? null };
  });
}

/** A Keha order of this shop as a document; null for a missing or Shopify order. */
export async function poDocument(shop: string, id: string): Promise<{ pdf: PoPdfInput } | null> {
  const order = await getOrder(shop, id);
  if (!order || order.source !== "keha") return null;
  return { pdf: await documentFor(shop, order) };
}
