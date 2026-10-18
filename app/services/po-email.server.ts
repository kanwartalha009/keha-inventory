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
 * Only when an email provider is configured (INVENTORY_EMAIL_API_KEY / _FROM). Without one — the
 * default since the owner decision of 2026-10-18 — the order page offers "Open in your email"
 * (supplierMailtoFor below: a mailto link for the merchant's own email app, nothing sent by Keha).
 *
 * Limits (lib/po-email-shared): one email per order per 10 minutes and 50
 * per store per UTC day, claimed in OwnerEmailLog before sending (atomic:
 * conditional update / unique insert) and given back when the send fails.
 */
import prisma from "../db.server";
import { decryptSecret } from "../lib/crypto.server";
import { emailTransportConfigured, sendEmail } from "./email.server";
import { getShopContact } from "./shop-contact.server";
import { translate, type Locale } from "../lib/i18n";
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
  type SupplierEmailInput,
  supplierEmailOrderKey,
} from "../lib/po-email-shared";
import { supplierLines } from "../lib/purchase-order-shared";
import { supplierMailto, type SupplierMailto } from "../lib/po-mailto-shared";
import { getOrder, hidePricesFor, pricingFor, transitionOrder, type OrderDetail } from "../models/reorder.server";

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

/** Who the order goes to and what it says: shared by "Email supplier" and "Open in your email". */
export async function supplierMessage(
  shop: string,
  order: OrderDetail,
  now: Date,
): Promise<{ to: string; storeName: string; replyTo?: string; locale: Locale; input: Omit<SupplierEmailInput, "confirmUrl"> }> {
  const supplier = order.supplierId
    ? await prisma.supplier.findFirst({ where: { id: order.supplierId, shop }, select: { email: true, name: true } })
    : null;
  const to = supplier?.email ? decryptSecret(supplier.email) : "";
  const [contact, doc] = await Promise.all([getShopContact(shop), documentFor(shop, order, now)]);
  const locale = readPoLanguage(order.supplier?.poLanguage);
  const tr = (k: string) => translate(locale, k);
  const storeName = contact?.name || storeLabel(shop);
  const hidePrices = hidePricesFor(order);
  const pricing = pricingFor(order);
  return {
    to,
    storeName,
    locale,
    replyTo: contact?.contactEmail || contact?.ownerEmail || undefined,
    input: {
      storeName,
      supplierName: supplier?.name ?? order.supplierName,
      number: order.number,
      lines: supplierLines(order.lines, hidePrices, pricing.factor),
      currency: pricing.currency,
      hidePrices,
      shipDate: order.confirmedShipDate,
      arrival: order.arrival,
      locale,
      details: doc.details ? poDetailRows(doc.details, tr, (d) => formatDay(d, locale)) : undefined,
    },
  };
}

export async function emailSupplier(shop: string, orderId: string, now: Date = new Date()): Promise<EmailSupplierResult> {
  const order = await getOrder(shop, orderId);
  if (!order) return { ok: false, error: "notFound" };
  if (order.source !== "keha" || !["draft", "sent", "confirmed"].includes(order.status)) return { ok: false, error: "notAllowed" };
  if (!emailTransportConfigured()) return { ok: false, error: "noTransport" };
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  if (!appUrl) return { ok: false, error: "noAppUrl" };
  const msg = await supplierMessage(shop, order, now);
  const { to, storeName, replyTo } = msg;
  if (!to) return { ok: false, error: "noEmail" };
  const tr = (k: string) => translate(msg.locale, k);
  const mail = supplierEmail({ ...msg.input, confirmUrl: confirmUrl(appUrl, order.confirmToken) }, tr);
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

export type MailtoResult =
  | { ok: true; mailto: SupplierMailto; draft: boolean; hasLink: boolean }
  | { ok: false; error: "notFound" | "notAllowed" };

/**
 * "Open in your email" (owner decision 2026-10-18, works without an email provider): the order as
 * a mailto link for the merchant's own email app. Builds text only — nothing is sent and the order
 * stays as it is; the merchant marks it sent themselves afterwards. `withLink`: the plan includes
 * the supplier link (and the app URL is set). The decrypted supplier email and the link reach the
 * browser only in this answer, when the merchant asks for it.
 */
export async function supplierMailtoFor(shop: string, orderId: string, withLink: boolean, now: Date = new Date()): Promise<MailtoResult> {
  const order = await getOrder(shop, orderId);
  if (!order) return { ok: false, error: "notFound" };
  if (order.source !== "keha" || !["draft", "sent", "confirmed"].includes(order.status)) return { ok: false, error: "notAllowed" };
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const msg = await supplierMessage(shop, order, now);
  const link = withLink && appUrl ? confirmUrl(appUrl, order.confirmToken) : null;
  const mailto = supplierMailto({ ...msg.input, to: msg.to || null, confirmUrl: link }, (k) => translate(msg.locale, k));
  return { ok: true, mailto, draft: order.status === "draft", hasLink: !!link };
}
