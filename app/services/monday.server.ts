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
 * Not sent: no money-at-stake numbers yet, numbers too old (over 36 h on paid
 * plans, 35 days on Free), unsubscribed, no recipient, or no app URL to build
 * the unsubscribe link from. A failed send is retried once (sendOwnerEmailOnce).
 *
 * Task 2.6 (full email): the top 5 actions (visible now, ranked, only rows the
 * plan may see; Free counts its Fix rows instead of listing them), each with a
 * button into the app, and last month's accuracy line (Growth). The same
 * summary goes to Slack when it is connected and "Send the Monday summary to
 * Slack" is on (Growth) — once per store week (OwnerEmailLog kind
 * "monday_slack"), independent of the email being on.
 */
import prisma from "../db.server";
import { adminAppUrl } from "../lib/admin-url.server";
import { toSupportedLocale, translate } from "../lib/i18n";
import {
  actionReasonText,
  composeMondayEmail,
  isMondaySendTime,
  lastMonthAccuracy,
  mondaySummary,
  selectMondayActions,
  type MondayAction,
  type MondayActionRow,
  type MondayEmailInput,
  type MondayOrders,
  type MondayValues,
} from "../lib/monday-shared";
import { previewRows, supplierName, thisWeek } from "../lib/order-plan-shared";
import { ordersDue } from "../lib/engine/forward-plan-shared";
import { loadOrderPlan } from "../models/order-plan.server";
import { MONEY_CARDS } from "../lib/money-shared";
import { canRetryOwnerEmail, listUnsubscribeHeaders, weekKey } from "../lib/owner-email-shared";
import { hasFeature, MONEY_REFRESH, type MoneyRefresh, type PlanCode } from "../lib/plan-shared";
import { tabOf, type ActionKind, type ActionState } from "../lib/actions-shared";
import { buildSlackMonday } from "../lib/slack-shared";
import { readSettings } from "../lib/settings-shared";
import type { Locale } from "../lib/i18n";
import { planFor } from "./entitlements.server";
import { emailUnsubscribeUrl, ownerContact, sendOwnerEmailOnce } from "./owner-email.server";
import { deliverSlackOnce } from "./slack.server";

export const MONDAY_KIND = "monday";
/** OwnerEmailLog kind for the Monday summary in Slack (once per store week). */
export const MONDAY_SLACK_KIND = "monday_slack";
const DAY_MS = 24 * 60 * 60 * 1000;

export type MondayResult =
  | "sent"
  | "failed"
  | "skipped:not_installed"
  | "skipped:unsubscribed"
  | "skipped:not_due"
  | "skipped:already_sent"
  | "skipped:no_data"
  | "skipped:stale_data"
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

type MoneyRow = { day: Date; basis?: unknown } & Record<(typeof MONEY_CARDS)[number], unknown>;

/** Oldest money-at-stake numbers the email may show: 36 h on daily refresh, 8 days on Free (weekly). */
export const MAX_MONEY_AGE_MS: Record<MoneyRefresh, number> = {
  daily: 36 * 60 * 60 * 1000,
  weekly: 8 * 24 * 60 * 60 * 1000,
  monthly: 35 * 24 * 60 * 60 * 1000,
};

/** When the row was computed: basis.computedAt, else the start of its (store-local) day. */
function moneyComputedAt(row: MoneyRow): Date {
  const at = (row.basis as { computedAt?: unknown } | null | undefined)?.computedAt;
  const d = typeof at === "string" ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? d : row.day;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v); // Prisma Decimal → number (2 dp amounts)
  return Number.isFinite(n) ? n : null;
};

const values = (row: MoneyRow): MondayValues =>
  Object.fromEntries(MONEY_CARDS.map((k) => [k, num(row[k])])) as MondayValues;

/** The unsubscribe link for a store (sealed, 180 days; owner-email.server emailUnsubscribeUrl). */
export function mondayUnsubscribeUrl(shop: string, now = Date.now()): string | null {
  return emailUnsubscribeUrl(shop, "monday", now);
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

/** Is this (kind, week) still to send? (cheap pre-check; the unique insert is the guarantee) */
async function pending(shop: string, kind: string, periodKey: string, now: Date): Promise<boolean> {
  const row = await prisma.ownerEmailLog.findUnique({ where: { shop_kind_periodKey: { shop, kind, periodKey } } });
  return !row || canRetryOwnerEmail(row, now);
}

const ACTION_STATES_READ: ActionState[] = ["open", "snoozed", "dismissed"];

/** The email's actions (top 5, plan rules) and accuracy line inputs. */
async function mondayExtras(
  shop: string,
  plan: PlanCode,
  locale: Locale,
  localDate: string,
  now: Date,
): Promise<Pick<MondayEmailInput, "actions" | "lockedFixes" | "accuracyPct">> {
  const raw = await prisma.action.findMany({
    where: { shop, state: { in: ACTION_STATES_READ } },
    select: { kind: true, productId: true, amount: true, state: true, stateAmount: true, snoozeUntil: true, reason: true },
  });
  const rows: MondayActionRow[] = raw.map((r) => ({
    kind: r.kind as ActionKind,
    productId: r.productId,
    amount: num(r.amount) ?? 0,
    state: r.state as ActionState,
    stateAmount: num(r.stateAmount),
    snoozeUntil: r.snoozeUntil,
    reason: r.reason,
  }));
  const { listed, lockedFixes } = selectMondayActions(rows, plan, now);
  const titles = new Map<string, string>();
  if (listed.length) {
    const variants = await prisma.variant.findMany({
      where: { shop, productId: { in: listed.map((r) => r.productId) } },
      select: { productId: true, productTitle: true },
    });
    for (const v of variants) if (!titles.has(v.productId)) titles.set(v.productId, v.productTitle);
  }
  const actions: MondayAction[] = listed.map((r) => ({
    title: titles.get(r.productId) ?? "—",
    reason: actionReasonText(locale, r.reason),
    amount: r.amount,
    link: adminAppUrl(shop, `/app?tab=${tabOf(r.kind)}`),
  }));

  let accuracyPct: number | null = null;
  if (hasFeature(plan, "accuracy")) {
    const acc = await prisma.accuracyMonth.findFirst({ where: { shop }, orderBy: { month: "desc" }, select: { month: true, storeErrorPct: true } });
    accuracyPct = lastMonthAccuracy(acc, localDate);
  }
  return { actions, lockedFixes: lockedFixes > 0 ? { count: lockedFixes, link: adminAppUrl(shop, "/app/plans") } : null, accuracyPct };
}

/**
 * "Order this week" (Growth and Pro: every supplier's order due in the next 7 days, overdue
 * first) or Free's top-10 preview. Null when the plan can't be read (the email still goes).
 */
export async function mondayOrders(shop: string, plan: PlanCode, locale: Locale, now: Date): Promise<MondayOrders | null> {
  try {
    const data = await loadOrderPlan(shop, now);
    // Nothing planned in the 13 weeks (or no numbers yet): keep the money email as it was.
    if (!data.events.length) return null;
    const tr = (k: string) => translate(locale, k);
    if (hasFeature(plan, "reorderPlan")) {
      const week = thisWeek(data);
      return {
        kind: "plan",
        today: data.today,
        lines: week.suppliers.map((s) => ({
          name: supplierName(data, s.supplierKey, tr),
          units: s.units,
          cash: s.cash,
          // The supplier's order-by date, as the Dashboard, Order now and Sidekick show it (M2).
          ...ordersDue(s.events),
          link: adminAppUrl(shop, `/app/reorder?supplier=${encodeURIComponent(s.supplierKey)}`),
        })),
        next: week.next ? { name: supplierName(data, week.next.supplierKey, tr), orderBy: week.next.orderBy } : null,
      };
    }
    const rows = previewRows(data, 10);
    return {
      kind: "preview",
      today: data.today,
      // An overdue row reads "order now" (its date is never printed); one with no date (M3) sorts as today.
      rows: rows.map((r) => ({ title: r.productTitle, variant: r.variantTitle, qty: r.qty, orderBy: r.orderBy ?? data.today, overdue: r.overdue })),
      products: new Set(rows.map((r) => data.variants[r.variantId]?.productId ?? r.variantId)).size,
      link: adminAppUrl(shop, "/app"),
      plansLink: adminAppUrl(shop, "/app/plans"),
    };
  } catch (e) {
    console.error(`[monday] ${shop}: order plan not read, sending without it`, e);
    return null;
  }
}

async function runForShop(row: ShopRow, now: Date): Promise<MondayResult> {
  const shop = row.domain;
  if (row.uninstalledAt) return "skipped:not_installed";
  const settings = readSettings(row.settings);
  const emailOn = settings.mondayEmail.enabled;
  const slackOn = Boolean(settings.alerts.slackWebhook) && settings.alerts.slackMonday;
  if (!emailOn && !slackOn) return "skipped:unsubscribed";

  const { due, localDate } = isMondaySendTime(now, row.timezone);
  if (!due) return "skipped:not_due";
  const periodKey = weekKey(new Date(`${localDate}T00:00:00Z`));

  // Cheap pre-check so hourly ticks don't re-read Shopify after the send;
  // the unique insert (sendOwnerEmailOnce / deliverSlackOnce) is the real guarantee.
  const emailPending = emailOn && (await pending(shop, MONDAY_KIND, periodKey, now));
  const slackPending = slackOn && (await pending(shop, MONDAY_SLACK_KIND, periodKey, now));
  if (!emailPending && !slackPending) return emailOn ? "skipped:already_sent" : "skipped:unsubscribed";

  const money = await moneyRows(shop);
  if (!money) return "skipped:no_data";
  const nowValues = values(money.latest);
  if (MONEY_CARDS.every((k) => nowValues[k] == null)) return "skipped:no_data";

  // Never send stale numbers: paid plans refresh daily, Free weekly.
  const plan = await planFor(shop);
  const refresh: keyof typeof MAX_MONEY_AGE_MS = MONEY_REFRESH[plan];
  const computedAt = moneyComputedAt(money.latest);
  const ageMs = now.getTime() - computedAt.getTime();
  if (ageMs > MAX_MONEY_AGE_MS[refresh]) {
    console.warn(
      `[monday] ${shop}: skipped — money at stake computed ${computedAt.toISOString()} (${Math.round(ageMs / 3600000)} h old, ${refresh} refresh)`,
    );
    return "skipped:stale_data";
  }

  const locale = toSupportedLocale(row.locale);
  const contact = await ownerContact(shop, null);
  const unsubscribe = mondayUnsubscribeUrl(shop, now.getTime());
  const input: MondayEmailInput = {
    locale,
    numberLocale: row.locale,
    currency: row.currency,
    storeName: contact?.name || shop,
    now: nowValues,
    before: money.before ? values(money.before) : null,
    refresh,
    links: { app: adminAppUrl(shop, "/app"), unsubscribe: unsubscribe ?? "" },
    ...(await mondayExtras(shop, plan, locale, localDate, now)),
    orders: await mondayOrders(shop, plan, locale, now),
  };

  // Slack (Growth): the same summary, shorter. Its failure never stops the email.
  if (slackPending && hasFeature(plan, "slack")) {
    try {
      const r = await deliverSlackOnce(shop, { kind: MONDAY_SLACK_KIND, periodKey }, settings, buildSlackMonday(mondaySummary(input)), now);
      if (r !== "skipped") console.log(`[monday] ${shop}: Slack summary ${r}`);
    } catch (e) {
      console.error(`[monday] ${shop}: Slack summary failed`, e);
    }
  }

  if (!emailOn) return "skipped:unsubscribed";
  if (!emailPending) return "skipped:already_sent";
  if (!unsubscribe) {
    console.error(`[monday] ${shop}: SHOPIFY_APP_URL not set — no unsubscribe link, not sending`);
    return "skipped:no_app_url";
  }

  const recipients = settings.mondayEmail.recipients.map((r) => r.trim()).filter((r) => r.includes("@"));
  const to = recipients.length ? recipients : contact?.to ?? null;
  if (!to || (Array.isArray(to) && !to.length)) return "skipped:no_recipient";

  const content = composeMondayEmail(input);
  return sendOwnerEmailOnce(
    shop,
    { kind: MONDAY_KIND, periodKey, ...content, headers: listUnsubscribeHeaders(unsubscribe) },
    { name: contact?.name || shop, to, locale },
    now,
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
