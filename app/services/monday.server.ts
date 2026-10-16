/**
 * The Monday email (spec §11, §4 J2, decision D5): every Monday from 08:00 in
 * the STORE's time zone, at most once per store-local ISO week, to the store
 * owner (or the recipients chosen in Settings). On by default; the email's
 * unsubscribe link (app/routes/email.unsubscribe.tsx) turns it off.
 *
 * Idempotent, so the scheduler can call runMondayEmailsAllShops every hour:
 * OwnerEmailLog (shop, "monday", week) makes the send happen once
 * (sendOwnerEmailOnce inserts the row before sending).
 *
 * Not sent: no money-at-stake numbers yet, unsubscribed, no recipient, or no
 * app URL to build the unsubscribe link from.
 */
import prisma from "../db.server";
import { adminAppUrl } from "../lib/admin-url.server";
import { toSupportedLocale } from "../lib/i18n";
import { composeMondayEmail, isMondaySendTime, MONDAY_UNSUB_PURPOSE, type MondayValues } from "../lib/monday-shared";
import { MONEY_CARDS } from "../lib/money-shared";
import { weekKey } from "../lib/owner-email-shared";
import { MONEY_REFRESH } from "../lib/plan-shared";
import { seal } from "../lib/seal.server";
import { readSettings } from "../lib/settings-shared";
import { planFor } from "./entitlements.server";
import { ownerContact, sendOwnerEmailOnce } from "./owner-email.server";

export const MONDAY_KIND = "monday";
const UNSUB_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MondayResult =
  | "sent"
  | "failed"
  | "skipped:not_installed"
  | "skipped:unsubscribed"
  | "skipped:not_due"
  | "skipped:already_sent"
  | "skipped:no_data"
  | "skipped:no_app_url"
  | "skipped:no_recipient"
  | "skipped";

type ShopRow = {
  domain: string;
  currency: string;
  timezone: string;
  locale: string;
  uninstalledAt: Date | null;
  settings: unknown;
};

type MoneyRow = { day: Date } & Record<(typeof MONEY_CARDS)[number], unknown>;

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v); // Prisma Decimal → number (2 dp amounts)
  return Number.isFinite(n) ? n : null;
};

const values = (row: MoneyRow): MondayValues =>
  Object.fromEntries(MONEY_CARDS.map((k) => [k, num(row[k])])) as MondayValues;

/** The unsubscribe link for a store (sealed, 180 days). */
export function mondayUnsubscribeUrl(shop: string, now = Date.now()): string | null {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const token = seal(MONDAY_UNSUB_PURPOSE, { shop }, UNSUB_TTL_MS, now);
  return `${base}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** The latest MoneyAtStake row, and the row closest to 7 days before it (within 4–10 days). */
async function moneyRows(shop: string): Promise<{ latest: MoneyRow; before: MoneyRow | null } | null> {
  const latest = (await prisma.moneyAtStake.findFirst({ where: { shop }, orderBy: { day: "desc" } })) as MoneyRow | null;
  if (!latest) return null;
  const t = latest.day.getTime();
  const near = (await prisma.moneyAtStake.findMany({
    where: { shop, day: { gte: new Date(t - 10 * DAY_MS), lte: new Date(t - 4 * DAY_MS) } },
    orderBy: { day: "asc" },
  })) as MoneyRow[];
  const target = t - 7 * DAY_MS;
  let before: MoneyRow | null = null;
  for (const r of near) {
    // Closest to 7 days back; on a tie the older row wins (asc order + strict <).
    if (!before || Math.abs(r.day.getTime() - target) < Math.abs(before.day.getTime() - target)) before = r;
  }
  return { latest, before };
}

async function runForShop(row: ShopRow, now: Date): Promise<MondayResult> {
  const shop = row.domain;
  if (row.uninstalledAt) return "skipped:not_installed";
  const settings = readSettings(row.settings);
  if (!settings.mondayEmail.enabled) return "skipped:unsubscribed";

  const { due, localDate } = isMondaySendTime(now, row.timezone);
  if (!due) return "skipped:not_due";
  const periodKey = weekKey(new Date(`${localDate}T00:00:00Z`));

  // Cheap pre-check so hourly ticks don't re-read Shopify after the send;
  // sendOwnerEmailOnce's unique insert is the real guarantee.
  const sent = await prisma.ownerEmailLog.findUnique({
    where: { shop_kind_periodKey: { shop, kind: MONDAY_KIND, periodKey } },
  });
  if (sent) return "skipped:already_sent";

  const money = await moneyRows(shop);
  if (!money) return "skipped:no_data";
  const nowValues = values(money.latest);
  if (MONEY_CARDS.every((k) => nowValues[k] == null)) return "skipped:no_data";

  const unsubscribe = mondayUnsubscribeUrl(shop, now.getTime());
  if (!unsubscribe) {
    console.error(`[monday] ${shop}: SHOPIFY_APP_URL not set — no unsubscribe link, not sending`);
    return "skipped:no_app_url";
  }

  const recipients = settings.mondayEmail.recipients.map((r) => r.trim()).filter((r) => r.includes("@"));
  const contact = await ownerContact(shop, null);
  const to = recipients.length ? recipients : contact?.to ?? null;
  if (!to || (Array.isArray(to) && !to.length)) return "skipped:no_recipient";

  const locale = toSupportedLocale(row.locale);
  const plan = await planFor(shop);
  const content = composeMondayEmail({
    locale,
    numberLocale: row.locale,
    currency: row.currency,
    storeName: contact?.name || shop,
    now: nowValues,
    before: money.before ? values(money.before) : null,
    refresh: MONEY_REFRESH[plan],
    links: { app: adminAppUrl(shop, "/app"), unsubscribe },
  });

  return sendOwnerEmailOnce(
    shop,
    { kind: MONDAY_KIND, periodKey, ...content },
    { name: contact?.name || shop, to, locale },
  );
}

/** Send this store's Monday email if it is due and not sent yet this store week. */
export async function runMondayEmails(shop: string, now: Date = new Date()): Promise<MondayResult> {
  const row = (await prisma.shop.findUnique({ where: { domain: shop } })) as ShopRow | null;
  if (!row) return "skipped:not_installed";
  return runForShop(row, now);
}

/** Every installed store; one store's failure never stops the others. */
export async function runMondayEmailsAllShops(
  now: Date = new Date(),
): Promise<{ sent: number; failed: number; skipped: number }> {
  const rows = (await prisma.shop.findMany({ where: { uninstalledAt: null } })) as ShopRow[];
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    try {
      const r = await runForShop(row, now);
      if (r === "sent") out.sent++;
      else if (r === "failed") out.failed++;
      else out.skipped++;
    } catch (e) {
      out.failed++;
      console.error(`[monday] ${row.domain} failed`, e);
    }
  }
  return out;
}
