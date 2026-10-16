/**
 * Store-owner emails: who to send to, and send-at-most-once per
 * (shop, kind, period). Keha never emails shoppers.
 *
 * The OwnerEmailLog row is inserted BEFORE sending, so two scheduler ticks
 * can't both send it. If no email transport is configured nothing is logged,
 * so the email still goes out once the transport is set.
 */
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { emailTransportConfigured, sendEmail } from "./email.server";
import { toSupportedLocale, type Locale } from "../lib/i18n";
import type { OwnerEmail } from "../lib/owner-email-shared";

export type OwnerContact = { name: string; to: string | null; locale: Locale };

const OWNER_QUERY = `#graphql
  query KehaInvOwner { shop { name email contactEmail } shopLocales { locale primary } }`;

/** The store's name, owner email (or an override) and primary language. */
export async function ownerContact(shop: string, override?: string | null): Promise<OwnerContact | null> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const res = await admin.graphql(OWNER_QUERY);
    const body = (await res.json()) as {
      data?: { shop?: { name?: string; email?: string | null; contactEmail?: string | null }; shopLocales?: { locale: string; primary: boolean }[] };
    };
    const s = body.data?.shop;
    if (!s) return null;
    const primary = body.data?.shopLocales?.find((l) => l.primary)?.locale;
    return { name: s.name ?? shop, to: override || s.email || s.contactEmail || null, locale: toSupportedLocale(primary) };
  } catch (e) {
    console.error("[owner-email] shop read failed", shop, e);
    return null;
  }
}

/**
 * Insert-then-send. Returns "sent", "failed" (logged as FAILED), or "skipped"
 * (already sent for this period, no transport, or no recipient).
 */
export async function sendOwnerEmailOnce(
  shop: string,
  email: OwnerEmail,
  contact: OwnerContact,
): Promise<"sent" | "failed" | "skipped"> {
  if (!emailTransportConfigured() || !contact.to) return "skipped";
  try {
    await prisma.ownerEmailLog.create({ data: { shop, kind: email.kind, periodKey: email.periodKey } });
  } catch {
    return "skipped"; // already sent for this period (unique)
  }
  const r = await sendEmail({ to: contact.to, subject: email.subject, text: email.text, fromName: "Keha Inventory" });
  if (!r.ok) {
    await prisma.ownerEmailLog.update({
      where: { shop_kind_periodKey: { shop, kind: email.kind, periodKey: email.periodKey } },
      data: { status: "FAILED", error: r.reason.slice(0, 300) },
    });
    console.error(`[owner-email] ${shop} ${email.kind} failed: ${r.reason}`);
    return "failed";
  }
  return "sent";
}
