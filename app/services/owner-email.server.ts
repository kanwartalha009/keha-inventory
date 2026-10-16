/**
 * Store-owner emails: who to send to, and send-at-most-once per
 * (shop, kind, period). Keha never emails shoppers.
 *
 * The OwnerEmailLog row is inserted BEFORE sending, so two scheduler ticks
 * can't both send it (a failed send gets one retry, see sendOwnerEmailOnce).
 * If no email transport is configured nothing is logged,
 * so the email still goes out once the transport is set.
 */
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { emailTransportConfigured, sendEmail } from "./email.server";
import { toSupportedLocale, type Locale } from "../lib/i18n";
import {
  canRetryOwnerEmail,
  emailAttempts,
  failedAttemptError,
  type OwnerEmail,
} from "../lib/owner-email-shared";

/** `to`: the owner email, or the store's chosen recipients (Monday email settings). */
export type OwnerContact = { name: string; to: string | string[] | null; locale: Locale };

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
 *
 * One retry: when this period's row is FAILED, was tried once, and the try is
 * at least an hour old, the row is claimed back to SENT with a conditional
 * update (only one tick can win it) and the email is sent again; a second
 * failure is final for the period. A SENT row is never sent again.
 */
export async function sendOwnerEmailOnce(
  shop: string,
  email: OwnerEmail,
  contact: OwnerContact,
  now: Date = new Date(),
): Promise<"sent" | "failed" | "skipped"> {
  const to = (Array.isArray(contact.to) ? contact.to : [contact.to]).filter((x): x is string => Boolean(x));
  if (!emailTransportConfigured() || !to.length) return "skipped";
  const key = { shop, kind: email.kind, periodKey: email.periodKey };
  let attempt = 1;
  try {
    await prisma.ownerEmailLog.create({ data: { ...key, sentAt: now } });
  } catch {
    // Already logged for this period (unique): only a retryable failure goes on.
    const row = await prisma.ownerEmailLog.findUnique({ where: { shop_kind_periodKey: key } });
    if (!row || !canRetryOwnerEmail(row, now)) return "skipped";
    const claimed = await prisma.ownerEmailLog.updateMany({
      where: { ...key, status: "FAILED", error: row.error, sentAt: row.sentAt },
      data: { status: "SENT", sentAt: now },
    });
    if (claimed.count !== 1) return "skipped"; // another tick took the retry
    attempt = emailAttempts(row.error) + 1;
  }
  const r = await sendEmail({
    to: to.length === 1 ? to[0] : to,
    subject: email.subject,
    text: email.text,
    ...(email.html ? { html: email.html } : {}),
    fromName: "Keha Inventory",
  });
  if (!r.ok) {
    await prisma.ownerEmailLog.update({
      where: { shop_kind_periodKey: key },
      data: { status: "FAILED", error: failedAttemptError(attempt, r.reason) },
    });
    console.error(`[owner-email] ${shop} ${email.kind} attempt ${attempt} failed: ${r.reason}`);
    return "failed";
  }
  if (attempt > 1) {
    await prisma.ownerEmailLog.update({ where: { shop_kind_periodKey: key }, data: { error: null } });
  }
  return "sent";
}
