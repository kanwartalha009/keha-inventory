/**
 * "Your order plan is ready" email (lib/plan-ready-email-shared): checked after every compute job
 * (services/jobs/handlers), sent at most once per store (OwnerEmailLog kind "plan_ready", period
 * "once", inserted before sending — sendOwnerEmailOnce). Sent only when:
 *  - the store is installed and its first read finished within the last 7 days (stores whose read
 *    finished before this email existed never get it);
 *  - the plan is ready (the Dashboard's own state: history read, 14 days of sales, stock tracked)
 *    and a plan was computed after the read finished;
 *  - the Monday email is on (the owner's choice to get Keha emails; its unsubscribe link turns it
 *    off), email sending is configured, the app URL is set (no unsubscribe link → no email), and
 *    there is a recipient (the Monday recipients, else the owner's email).
 * Never throws: the compute job only logs the outcome.
 */
import prisma from "../db.server";
import { adminAppUrl } from "../lib/admin-url.server";
import { readSettings } from "../lib/settings-shared";
import { HISTORY_MONTHS, isDegraded, readBackfillState } from "../lib/sync/backfill-shared";
import { syncChunks } from "../lib/sync-progress-shared";
import { readMoneyBasis } from "../lib/dashboard-shared";
import { listUnsubscribeHeaders } from "../lib/owner-email-shared";
import { toSupportedLocale } from "../lib/i18n";
import {
  PLAN_READY_KIND,
  PLAN_READY_PERIOD,
  composePlanReadyEmail,
  planReadyInWindow,
} from "../lib/plan-ready-email-shared";
import { emailTransportConfigured } from "./email.server";
import { emailUnsubscribeUrl, ownerContact, sendOwnerEmailOnce } from "./owner-email.server";
import { getPlanReadiness } from "../models/dashboard.server";

export type PlanReadyResult =
  | "sent"
  | "failed"
  | "skipped:no_transport"
  | "skipped:not_installed"
  | "skipped:not_finished"
  | "skipped:too_old"
  | "skipped:not_ready"
  | "skipped:not_built"
  | "skipped:unsubscribed"
  | "skipped:already_sent"
  | "skipped:no_app_url"
  | "skipped:no_recipient"
  | "skipped";

/** Has the plan-ready email already gone out (or is it being sent)? */
export async function planReadyEmailSent(shop: string): Promise<boolean> {
  const row = await prisma.ownerEmailLog.findUnique({
    where: { shop_kind_periodKey: { shop, kind: PLAN_READY_KIND, periodKey: PLAN_READY_PERIOD } },
    select: { status: true },
  });
  return row?.status === "SENT";
}

export async function maybeSendPlanReadyEmail(shop: string, now: Date = new Date()): Promise<PlanReadyResult> {
  try {
    if (!emailTransportConfigured()) return "skipped:no_transport";
    const row = await prisma.shop.findUnique({
      where: { domain: shop },
      select: { domain: true, locale: true, settings: true, backfillState: true, uninstalledAt: true },
    });
    if (!row || row.uninstalledAt) return "skipped:not_installed";
    const state = readBackfillState(row.backfillState);
    if (!state.finishedAt) return "skipped:not_finished";
    if (!planReadyInWindow(state.finishedAt, now)) return "skipped:too_old";
    const settings = readSettings(row.settings);
    if (!settings.mondayEmail.enabled) return "skipped:unsubscribed";
    if (await planReadyEmailSent(shop)) return "skipped:already_sent";

    const ready = await getPlanReadiness(shop, now);
    if (!ready.ready) return "skipped:not_ready";
    const money = await prisma.moneyAtStake.findFirst({ where: { shop }, orderBy: { day: "desc" }, select: { basis: true } });
    const builtAt = readMoneyBasis(money?.basis)?.computedAt ?? null;
    if (!builtAt || new Date(builtAt).getTime() < new Date(state.finishedAt).getTime()) return "skipped:not_built";

    const unsubscribe = emailUnsubscribeUrl(shop, "monday", now.getTime());
    if (!unsubscribe) return "skipped:no_app_url";
    const contact = await ownerContact(shop, null);
    const recipients = settings.mondayEmail.recipients.map((r) => r.trim()).filter((r) => r.includes("@"));
    const to = recipients.length ? recipients : (contact?.to ?? null);
    if (!to || (Array.isArray(to) && !to.length)) return "skipped:no_recipient";

    const locale = contact?.locale ?? toSupportedLocale(row.locale);
    const content = composePlanReadyEmail({
      locale,
      storeName: contact?.name || shop,
      months: syncChunks(state).length || HISTORY_MONTHS,
      gaps: isDegraded(state),
      links: { app: adminAppUrl(shop, "/app"), unsubscribe },
    });
    return await sendOwnerEmailOnce(
      shop,
      { kind: PLAN_READY_KIND, periodKey: PLAN_READY_PERIOD, ...content, headers: listUnsubscribeHeaders(unsubscribe) },
      { name: contact?.name || shop, to, locale },
      now,
    );
  } catch (e) {
    console.error(`[plan-ready] ${shop}: not sent`, e);
    return "skipped";
  }
}
