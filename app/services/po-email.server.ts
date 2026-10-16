/**
 * "Email supplier" (spec §5.3): the order goes to the supplier's email
 * (decrypted here only), from the app's verified sender with the store's
 * name, reply-to = the store's contact email, in the store's language, with
 * the supplier-page link (confirm the ship date, download the PDF). The email
 * transport has no attachments, so the PDF is linked, not attached.
 *
 * A draft is marked Sent only after the email went out.
 */
import prisma from "../db.server";
import { decryptSecret } from "../lib/crypto.server";
import { emailTransportConfigured, sendEmail } from "./email.server";
import { getShopContact } from "./shop-contact.server";
import { toSupportedLocale, translate } from "../lib/i18n";
import { storeLabel } from "../lib/dashboard-shared";
import { confirmUrl, supplierEmail } from "../lib/po-email-shared";
import { supplierLines } from "../lib/purchase-order-shared";
import { getOrder, hidePricesFor, transitionOrder } from "../models/reorder.server";

export type EmailSupplierResult =
  | { ok: true; markedSent: boolean }
  | { ok: false; error: "notFound" | "notAllowed" | "noEmail" | "noTransport" | "noAppUrl" | "failed" };

export async function emailSupplier(shop: string, orderId: string, now: Date = new Date()): Promise<EmailSupplierResult> {
  const order = await getOrder(shop, orderId);
  if (!order) return { ok: false, error: "notFound" };
  if (order.source !== "keha" || !["draft", "sent", "confirmed"].includes(order.status)) return { ok: false, error: "notAllowed" };
  if (!emailTransportConfigured()) return { ok: false, error: "noTransport" };
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  if (!appUrl) return { ok: false, error: "noAppUrl" };
  const supplier = order.supplierId
    ? await prisma.supplier.findFirst({ where: { id: order.supplierId, shop }, select: { email: true, name: true } })
    : null;
  const to = supplier?.email ? decryptSecret(supplier.email) : "";
  if (!to) return { ok: false, error: "noEmail" };

  const [shopRow, contact] = await Promise.all([
    prisma.shop.findUnique({ where: { domain: shop }, select: { locale: true } }),
    getShopContact(shop),
  ]);
  const locale = toSupportedLocale(shopRow?.locale);
  const storeName = contact?.name || storeLabel(shop);
  const hidePrices = hidePricesFor(order);
  const mail = supplierEmail(
    {
      storeName,
      supplierName: supplier?.name ?? order.supplierName,
      number: order.number,
      lines: supplierLines(order.lines, hidePrices),
      currency: order.currency,
      hidePrices,
      confirmUrl: confirmUrl(appUrl, order.confirmToken),
      locale,
    },
    (k) => translate(locale, k),
  );
  const replyTo = contact?.contactEmail || contact?.ownerEmail || undefined;
  const r = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html, replyTo, fromName: storeName });
  if (!r.ok) {
    console.error(`[po-email] ${shop} ${order.number}: ${r.reason}`);
    return { ok: false, error: "failed" };
  }
  if (order.status === "draft") {
    const t = await transitionOrder(shop, order.id, "sent", now);
    return { ok: true, markedSent: t.ok };
  }
  return { ok: true, markedSent: false };
}
