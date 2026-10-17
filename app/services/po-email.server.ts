/**
 * "Email supplier" (spec §5.3): the order goes to the supplier's email
 * (decrypted here only), from the app's verified sender with the store's
 * name, reply-to = the store's contact email, in the supplier's PO language
 * (English by default; merchant audit 2026-10-18), with the order's details
 * (buyer, ship-to, terms, Incoterms, dates, note) and the supplier-page link (confirm the ship date, download the PDF). The email
 * transport has no attachments, so the PDF is linked, not attached.
 *
 * A draft is marked Sent only after the email went out.
 *
 * Limits (lib/po-email-shared): one email per order per 10 minutes and 50
 * per store per UTC day, claimed in OwnerEmailLog before sending (atomic:
 * conditional update / unique insert) and given back when the send fails.
 */
import prisma from "../db.server";
import { decryptSecret } from "../lib/crypto.server";
import { emailTransportConfigured, sendEmail } from "./email.server";
import { getShopContact } from "./shop-contact.server";
import { translate } from "../lib/i18n";
import { formatDay, storeLabel } from "../lib/dashboard-shared";
import { poDetailRows, readPoLanguage } from "../lib/po-document-shared";
import { documentFor } from "./po-document.server";
import {
  SUPPLIER_EMAIL_COOLDOWN_MS,
  SUPPLIER_EMAIL_DAILY_CAP,
  SUPPLIER_EMAIL_DAY_KIND,
  SUPPLIER_EMAIL_KIND,
  confirmUrl,
  supplierEmail,
  supplierEmailDayPrefix,
  supplierEmailOrderKey,
} from "../lib/po-email-shared";
import { supplierLines } from "../lib/purchase-order-shared";
import { getOrder, hidePricesFor, pricingFor, transitionOrder } from "../models/reorder.server";

export type EmailSupplierResult =
  | { ok: true; markedSent: boolean }
  | { ok: false; error: "notFound" | "notAllowed" | "noEmail" | "noTransport" | "noAppUrl" | "failed" | "cooldown" | "dailyCap" };

type Claim = { ok: true; release: () => Promise<void> } | { ok: false; error: "cooldown" | "dailyCap" };

/**
 * Claims this send against both limits. Per order: insert the order's row, or
 * move its sentAt forward only if it is still the value read and at least 10
 * minutes old (two clicks can't both win). Per day: take the next free slot
 * "<day>#<n>" (unique insert; a lost race re-counts) while fewer than 50
 * exist. `release` gives both back (the email didn't go out).
 */
export async function claimSupplierEmail(shop: string, orderId: string, now: Date): Promise<Claim> {
  const orderKey = { shop, kind: SUPPLIER_EMAIL_KIND, periodKey: supplierEmailOrderKey(orderId) };
  let releaseOrder: () => Promise<unknown>;
  const inserted = await prisma.ownerEmailLog.createMany({ data: [{ ...orderKey, sentAt: now }], skipDuplicates: true });
  if (inserted.count === 1) {
    releaseOrder = () => prisma.ownerEmailLog.deleteMany({ where: { ...orderKey, sentAt: now } });
  } else {
    const row = await prisma.ownerEmailLog.findUnique({ where: { shop_kind_periodKey: orderKey }, select: { sentAt: true } });
    if (!row || now.getTime() - row.sentAt.getTime() < SUPPLIER_EMAIL_COOLDOWN_MS) return { ok: false, error: "cooldown" };
    const moved = await prisma.ownerEmailLog.updateMany({ where: { ...orderKey, sentAt: row.sentAt }, data: { sentAt: now } });
    if (moved.count !== 1) return { ok: false, error: "cooldown" };
    releaseOrder = () => prisma.ownerEmailLog.updateMany({ where: { ...orderKey, sentAt: now }, data: { sentAt: row.sentAt } });
  }

  const prefix = supplierEmailDayPrefix(now);
  for (let i = 0; i <= SUPPLIER_EMAIL_DAILY_CAP; i++) {
    const used = await prisma.ownerEmailLog.count({ where: { shop, kind: SUPPLIER_EMAIL_DAY_KIND, periodKey: { startsWith: prefix } } });
    if (used >= SUPPLIER_EMAIL_DAILY_CAP) break;
    const slot = { shop, kind: SUPPLIER_EMAIL_DAY_KIND, periodKey: `${prefix}${used + 1}` };
    const took = await prisma.ownerEmailLog.createMany({ data: [{ ...slot, sentAt: now }], skipDuplicates: true });
    if (took.count === 1) {
      return {
        ok: true,
        release: async () => {
          await prisma.ownerEmailLog.deleteMany({ where: slot });
          await releaseOrder();
        },
      };
    }
  }
  await releaseOrder();
  return { ok: false, error: "dailyCap" };
}

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

  const [contact, doc] = await Promise.all([getShopContact(shop), documentFor(shop, order, now)]);
  const locale = readPoLanguage(order.supplier?.poLanguage);
  const tr = (k: string) => translate(locale, k);
  const storeName = contact?.name || storeLabel(shop);
  const hidePrices = hidePricesFor(order);
  const pricing = pricingFor(order);
  const mail = supplierEmail(
    {
      storeName,
      supplierName: supplier?.name ?? order.supplierName,
      number: order.number,
      lines: supplierLines(order.lines, hidePrices, pricing.factor),
      currency: pricing.currency,
      hidePrices,
      shipDate: order.confirmedShipDate,
      arrival: order.arrival,
      confirmUrl: confirmUrl(appUrl, order.confirmToken),
      locale,
      details: doc.details ? poDetailRows(doc.details, tr, (d) => formatDay(d, locale)) : undefined,
    },
    tr,
  );
  const replyTo = contact?.contactEmail || contact?.ownerEmail || undefined;
  const claim = await claimSupplierEmail(shop, order.id, now);
  if (!claim.ok) return { ok: false, error: claim.error };
  const r = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html, replyTo, fromName: storeName });
  if (!r.ok) {
    console.error(`[po-email] ${shop} ${order.number}: ${r.reason}`);
    await claim.release().catch((e) => console.error(`[po-email] ${shop} ${order.number}: release failed`, e));
    return { ok: false, error: "failed" };
  }
  if (order.status === "draft") {
    const t = await transitionOrder(shop, order.id, "sent", now);
    return { ok: true, markedSent: t.ok };
  }
  return { ok: true, markedSent: false };
}
